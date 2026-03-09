import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { CARD_ACTION_TYPE_WELCOME } from "./card-action.js";
import { sendCardFeishu } from "./send.js";
import type { WelcomeCardConfig, WelcomeCardSkillConfig } from "./types.js";

/**
 * Build a Feishu interactive card (schema 2.0) for group welcome.
 * If `cardJson` is provided, use it directly; otherwise build from individual fields.
 */
export function buildWelcomeCard(config: WelcomeCardConfig): Record<string, unknown> {
  if (config.cardJson) {
    return config.cardJson;
  }

  const skills = config.skills ?? [];
  const headerTitle = config.headerTitle ?? "小安同学";
  const headerTemplate = config.headerTemplate ?? "indigo";

  const header: Record<string, unknown> = {
    title: { tag: "plain_text", content: headerTitle },
    template: headerTemplate,
  };
  if (config.headerSubtitle) {
    header.subtitle = { tag: "plain_text", content: config.headerSubtitle };
  }
  if (config.iconImgKey) {
    header.icon = { tag: "custom_icon", img_key: config.iconImgKey };
  }

  const elements: Record<string, unknown>[] = [];

  // Banner image
  if (config.bannerImgKey) {
    elements.push({
      tag: "img",
      img_key: config.bannerImgKey,
      alt: { tag: "plain_text", content: headerTitle },
      scale_type: "crop_center",
      size: "stretch_without_padding",
    });
  }

  // Skill buttons
  if (skills.length > 0) {
    const prompt = config.skillsPrompt ?? "请选择你感兴趣的任务：";
    elements.push({
      tag: "markdown",
      content: prompt,
    });
    for (const skill of skills) {
      elements.push(buildSkillButton(skill));
    }
  }

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header,
    body: {
      direction: "vertical",
      elements,
    },
  };
}

function buildSkillButton(skill: WelcomeCardSkillConfig): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: skill.label },
    type: skill.type ?? "primary",
    width: "fill",
    behaviors: [
      {
        type: "callback",
        value: { type: CARD_ACTION_TYPE_WELCOME, command: skill.command },
      },
    ],
  };
}

/**
 * Send the welcome card to a Feishu group chat.
 */
export async function sendWelcomeCard(params: {
  cfg: ClawdbotConfig;
  chatId: string;
  welcomeCardConfig: WelcomeCardConfig;
  accountId?: string;
}): Promise<void> {
  const { cfg, chatId, welcomeCardConfig, accountId } = params;
  const card = buildWelcomeCard(welcomeCardConfig);
  await sendCardFeishu({ cfg, to: chatId, card, accountId });
}
