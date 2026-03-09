import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";

export type FeishuCardActionEvent = {
  operator: {
    open_id: string;
    user_id: string;
    union_id: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
    /** Form field values when the action is triggered inside a form container. */
    form_value?: Record<string, unknown>;
  };
  context: {
    open_chat_id: string;
    open_message_id: string;
  };
};

/**
 * Extract the command/text content from a card action event.
 *
 * Priority:
 * 1. form_value: if a form select field contains a "command" key, use its value
 * 2. action.value.command or action.value.text
 * 3. JSON.stringify fallback
 */
function extractCardActionContent(event: FeishuCardActionEvent): string {
  // Check form_value first (from form container with select_static / radio)
  const formValue = event.action.form_value;
  if (formValue && typeof formValue === "object") {
    // Look for a field whose value is a string starting with "/" (command pattern)
    for (const val of Object.values(formValue)) {
      if (typeof val === "string" && val.startsWith("/")) {
        return val;
      }
    }
    // Fallback: check for a "command" key in form_value
    if ("command" in formValue && typeof formValue.command === "string") {
      return formValue.command;
    }
  }

  // Check action.value (from standalone buttons)
  const actionValue = event.action.value;
  if (typeof actionValue === "object" && actionValue !== null) {
    if ("text" in actionValue && typeof actionValue.text === "string") {
      return actionValue.text;
    }
    if ("command" in actionValue && typeof actionValue.command === "string") {
      return actionValue.command;
    }
    return JSON.stringify(actionValue);
  }

  return String(actionValue);
}

export type FeishuCardActionResponse = {
  toast?: {
    type?: "info" | "success" | "error" | "warning";
    content?: string;
    i18n?: Record<string, string>;
  };
  card?: {
    type: "raw";
    data: Record<string, unknown>;
  };
};

/**
 * Build a "completed" card that replaces the interactive welcome card.
 * Preserves the original banner image and replaces the form with a
 * confirmation message. The selected value is shown as-is (no hardcoded map).
 */
function buildCompletedCard(
  selectedValue: string,
  originalCardConfig?: Record<string, unknown>,
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [];

  let displayLabel = selectedValue;
  if (originalCardConfig) {
    const body = originalCardConfig.body as
      | { elements?: Array<Record<string, unknown>> }
      | undefined;
    const bodyElements = body?.elements;

    // Preserve the original banner image if present
    const imgElement = bodyElements?.find((el: Record<string, unknown>) => el.tag === "img");
    if (imgElement) {
      elements.push(imgElement);
    }

    // Try to find the label text from the original card's select options
    const formEl = bodyElements?.find((el: Record<string, unknown>) => el.tag === "form") as
      | { elements?: Array<Record<string, unknown>> }
      | undefined;
    const selectEl = formEl?.elements?.find(
      (el: Record<string, unknown>) => el.tag === "select_static",
    ) as { options?: Array<{ text?: { content?: string }; value?: string }> } | undefined;
    const matchedOption = selectEl?.options?.find((opt) => opt.value === selectedValue);
    if (matchedOption?.text?.content) {
      displayLabel = matchedOption.text.content;
    }
  }

  elements.push({
    tag: "markdown",
    content: `✅ 已选择：${displayLabel}`,
    text_size: "normal",
  });

  return {
    schema: "2.0",
    config: { update_multi: true },
    body: {
      direction: "vertical",
      elements,
    },
  };
}

export const CARD_ACTION_TYPE_WELCOME = "welcome_card";

export async function handleFeishuCardAction(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<FeishuCardActionResponse | undefined> {
  const { cfg, event, runtime, accountId } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;

  // Only handle known card action types; ignore unrecognized ones.
  const actionType =
    typeof event.action.value?.type === "string" ? event.action.value.type : undefined;
  if (actionType && actionType !== CARD_ACTION_TYPE_WELCOME) {
    log(`feishu[${account.accountId}]: ignoring card action with unknown type "${actionType}"`);
    return undefined;
  }

  const content = extractCardActionContent(event);

  // Construct a synthetic message event
  const messageEvent: FeishuMessageEvent = {
    sender: {
      sender_id: {
        open_id: event.operator.open_id,
        user_id: event.operator.user_id,
        union_id: event.operator.union_id,
      },
    },
    message: {
      message_id: event.context.open_message_id || `card-action-${event.token}`,
      chat_id: event.context.open_chat_id || event.operator.open_id,
      chat_type: event.context.open_chat_id ? "group" : "p2p",
      message_type: "text",
      content: JSON.stringify({ text: content }),
    },
  };

  log(
    `feishu[${account.accountId}]: handling card action from ${event.operator.open_id}: ${content}`,
  );

  // Dispatch async (don't await)
  void handleFeishuMessage({
    cfg,
    event: messageEvent,
    botOpenId: params.botOpenId,
    runtime,
    accountId,
    skipMentionCheck: true,
  }).catch((err) => {
    const error = runtime?.error ?? console.error;
    error(`feishu[${account.accountId}]: card action message dispatch failed: ${String(err)}`);
  });

  // Build an updated card showing "completed" state
  const welcomeCardConfig = account.config.welcomeCard?.cardJson as
    | Record<string, unknown>
    | undefined;
  const updatedCard = buildCompletedCard(content, welcomeCardConfig);

  return {
    card: {
      type: "raw",
      data: updatedCard,
    },
  };
}
