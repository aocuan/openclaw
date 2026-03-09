import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/feishu";
import type { DynamicAgentCreationConfig, DynamicGroupAgentCreationConfig } from "./types.js";

export type MaybeCreateDynamicAgentResult = {
  created: boolean;
  updatedCfg: OpenClawConfig;
  agentId?: string;
};

type DynamicPeerKind = "direct" | "group";

type DynamicAgentSpec = {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  log: (msg: string) => void;
  peerKind: DynamicPeerKind;
  peerId: string;
  agentId: string;
  workspaceTemplate?: string;
  agentDirTemplate?: string;
  maxAgents?: number;
  templateParams: Record<string, string>;
  subjectLabel: string;
};

const inflightDynamicAgentCreates = new Map<string, Promise<MaybeCreateDynamicAgentResult>>();

/**
 * Check if a dynamic agent should be created for a DM user and create it if needed.
 * This creates a unique agent instance with its own workspace for each DM user.
 */
export async function maybeCreateDynamicAgent(params: {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  senderOpenId: string;
  dynamicCfg: DynamicAgentCreationConfig;
  log: (msg: string) => void;
}): Promise<MaybeCreateDynamicAgentResult> {
  const { cfg, runtime, senderOpenId, dynamicCfg, log } = params;
  const agentId = `feishu-${senderOpenId}`;

  return runSingleFlight(agentId, async () =>
    maybeCreateFeishuScopedAgent({
      cfg,
      runtime,
      log,
      peerKind: "direct",
      peerId: senderOpenId,
      agentId,
      workspaceTemplate: dynamicCfg.workspaceTemplate,
      agentDirTemplate: dynamicCfg.agentDirTemplate,
      maxAgents: dynamicCfg.maxAgents,
      templateParams: {
        userId: senderOpenId,
        agentId,
      },
      subjectLabel: `user ${senderOpenId}`,
    }),
  );
}

/**
 * Check if a dynamic agent should be created for a group chat and create it if needed.
 * This creates one unique agent instance per Feishu group chat.
 */
export async function maybeCreateDynamicGroupAgent(params: {
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  chatId: string;
  dynamicCfg: DynamicGroupAgentCreationConfig;
  log: (msg: string) => void;
}): Promise<MaybeCreateDynamicAgentResult> {
  const { cfg, runtime, chatId, dynamicCfg, log } = params;
  const agentId = `feishu-group-${chatId}`;

  return runSingleFlight(agentId, async () =>
    maybeCreateFeishuScopedAgent({
      cfg,
      runtime,
      log,
      peerKind: "group",
      peerId: chatId,
      agentId,
      workspaceTemplate: dynamicCfg.workspaceTemplate,
      agentDirTemplate: dynamicCfg.agentDirTemplate,
      maxAgents: dynamicCfg.maxAgents,
      templateParams: {
        groupId: chatId,
        chatId,
        agentId,
      },
      subjectLabel: `group ${chatId}`,
    }),
  );
}

async function maybeCreateFeishuScopedAgent(
  params: DynamicAgentSpec,
): Promise<MaybeCreateDynamicAgentResult> {
  const {
    cfg,
    runtime,
    log,
    peerKind,
    peerId,
    agentId,
    workspaceTemplate,
    agentDirTemplate,
    maxAgents,
    templateParams,
    subjectLabel,
  } = params;
  const liveCfg = await loadLatestConfig(runtime, cfg);

  const existingBindings = liveCfg.bindings ?? [];
  if (hasBinding(existingBindings, peerKind, peerId)) {
    return { created: false, updatedCfg: liveCfg };
  }

  if (maxAgents !== undefined) {
    const feishuAgentCount = countDynamicAgents(liveCfg, peerKind);
    if (feishuAgentCount >= maxAgents) {
      log(`feishu: maxAgents limit (${maxAgents}) reached, not creating agent for ${subjectLabel}`);
      return { created: false, updatedCfg: liveCfg };
    }
  }

  const existingAgent = (liveCfg.agents?.list ?? []).find((agent) => agent.id === agentId);
  if (existingAgent) {
    log(`feishu: agent "${agentId}" exists, adding missing binding for ${subjectLabel}`);

    const updatedCfg = addBinding(liveCfg, {
      agentId,
      peerKind,
      peerId,
    });
    await runtime.config.writeConfigFile(updatedCfg);
    return { created: true, updatedCfg, agentId };
  }

  const resolvedWorkspace = resolveUserPath(
    applyTemplate(workspaceTemplate ?? "~/.openclaw/workspace-{agentId}", templateParams),
  );
  const resolvedAgentDir = resolveUserPath(
    applyTemplate(agentDirTemplate ?? "~/.openclaw/agents/{agentId}/agent", templateParams),
  );

  log(`feishu: creating dynamic agent "${agentId}" for ${subjectLabel}`);
  log(`  workspace: ${resolvedWorkspace}`);
  log(`  agentDir: ${resolvedAgentDir}`);

  await fs.promises.mkdir(resolvedWorkspace, { recursive: true });
  await fs.promises.mkdir(resolvedAgentDir, { recursive: true });

  // Write agent context marker so hooks can reliably identify the channel and peer
  // without falling back to fragile agent-id pattern matching.
  const contextDir = path.join(resolvedWorkspace, ".openclaw");
  await fs.promises.mkdir(contextDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(contextDir, "agent-context.json"),
    `${JSON.stringify({ channel: "feishu", peerKind, peerId, agentId, createdAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );

  const updatedCfg: OpenClawConfig = addBinding(
    {
      ...liveCfg,
      agents: {
        ...liveCfg.agents,
        list: [
          ...(liveCfg.agents?.list ?? []),
          {
            id: agentId,
            workspace: resolvedWorkspace,
            agentDir: resolvedAgentDir,
          },
        ],
      },
    },
    {
      agentId,
      peerKind,
      peerId,
    },
  );

  await runtime.config.writeConfigFile(updatedCfg);

  return { created: true, updatedCfg, agentId };
}

function hasBinding(
  bindings: OpenClawConfig["bindings"] | undefined,
  peerKind: DynamicPeerKind,
  peerId: string,
): boolean {
  return (bindings ?? []).some(
    (binding) =>
      binding.match?.channel === "feishu" &&
      binding.match?.peer?.kind === peerKind &&
      binding.match?.peer?.id === peerId,
  );
}

function addBinding(
  cfg: OpenClawConfig,
  params: { agentId: string; peerKind: DynamicPeerKind; peerId: string },
): OpenClawConfig {
  return {
    ...cfg,
    bindings: [
      ...(cfg.bindings ?? []),
      {
        agentId: params.agentId,
        match: {
          channel: "feishu",
          peer: {
            kind: params.peerKind,
            id: params.peerId,
          },
        },
      },
    ],
  };
}

function countDynamicAgents(cfg: OpenClawConfig, peerKind: DynamicPeerKind): number {
  return (cfg.agents?.list ?? []).filter((agent) => {
    if (peerKind === "group") {
      return agent.id.startsWith("feishu-group-");
    }
    return agent.id.startsWith("feishu-") && !agent.id.startsWith("feishu-group-");
  }).length;
}

function applyTemplate(template: string, params: Record<string, string>): string {
  return Object.entries(params).reduce(
    (output, [key, value]) => output.replaceAll(`{${key}}`, value),
    template,
  );
}

async function loadLatestConfig(
  runtime: PluginRuntime,
  fallback: OpenClawConfig,
): Promise<OpenClawConfig> {
  try {
    const loaded = (await runtime.config.loadConfig()) as OpenClawConfig;
    if (loaded && typeof loaded === "object" && Object.keys(loaded).length > 0) {
      return loaded;
    }
  } catch {
    // Fall back to the caller's in-memory config snapshot.
  }
  return fallback;
}

async function runSingleFlight(
  key: string,
  factory: () => Promise<MaybeCreateDynamicAgentResult>,
): Promise<MaybeCreateDynamicAgentResult> {
  const existing = inflightDynamicAgentCreates.get(key);
  if (existing) {
    return existing;
  }

  // Group bootstrap can race when several first-turn messages arrive together.
  // Reusing the same promise keeps config writes and mkdirs single-flight.
  const pending = (async () => {
    try {
      return await factory();
    } finally {
      inflightDynamicAgentCreates.delete(key);
    }
  })();
  inflightDynamicAgentCreates.set(key, pending);
  return pending;
}

/**
 * Resolve a path that may start with ~ to the user's home directory.
 */
function resolveUserPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
