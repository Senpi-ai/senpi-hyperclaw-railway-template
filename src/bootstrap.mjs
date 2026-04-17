import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DESIRED_MODELS,
  PROVIDER_DEFAULTS,
  AI_PROVIDER_MODEL_MAP,
} from "./lib/models.js";
import { readCachedTelegramId, writeCachedTelegramId, readChatIdFromUserMd } from "./lib/telegramId.js";
import { TELEGRAM_USERNAME } from "./lib/config.js";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";

// Config path — MCPORTER_CONFIG is set as a Railway env var so every process
// in the container (wrapper, gateway, agent, tools) can find it.
const MCPORTER_PATH =
  process.env.MCPORTER_CONFIG ||
  path.join(STATE_DIR, "config", "mcporter.json");

/** Persisted Senpi token so plugin and MCP can be configured independently (env or file). */
const SENPI_TOKEN_FILE = path.join(STATE_DIR, "config", "senpi.token");

const IMAGE_SKILLS_DIR = "/opt/openclaw-skills";
const STATE_SKILLS_DIR = path.join(STATE_DIR, "skills");

/**
 * OpenClaw discovery uses the unscoped npm name as idHint (@senpi-ai/runtime → "runtime").
 * openclaw.plugin.json "id" must match that hint or you get "plugin id mismatch" warnings.
 * npm install spec stays scoped (override with SENPI_RUNTIME_NPM_SPEC).
 */
const SENPI_RUNTIME_PLUGIN_ID = "runtime";
const SENPI_RUNTIME_NPM_SPEC =
  process.env.SENPI_RUNTIME_NPM_SPEC?.trim() || "@senpi-ai/runtime";

/**
 * Skill that provides the agent with documentation on how to use the @senpi-ai/runtime
 * trading plugin. Installed via the `skills` CLI from the senpi-skills GitHub repo.
 */
const SENPI_TRADING_RUNTIME_SKILL_NAME = "senpi-trading-runtime";
const SENPI_SKILLS_REPO = "https://github.com/Senpi-ai/senpi-skills";
const SENPI_SKILLS_BRANCH = "feat/dsl-dev";

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve Senpi token: env first, then persisted file, then mcporter.json for backward compat.
 * MCP is the older feature (token was only in mcporter.json); plugin is newer. We don't assume
 * both are present — so canonical store is senpi.token. If we find token in mcporter.json only,
 * we migrate it to senpi.token so future runs don't depend on MCP config.
 */
function resolveSenpiToken() {
  const fromEnv = process.env.SENPI_AUTH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (exists(SENPI_TOKEN_FILE)) {
    try {
      return fs.readFileSync(SENPI_TOKEN_FILE, "utf8").trim();
    } catch {
      // fall through to backward-compat
    }
  }
  // Backward compat: existing installs may have token only in mcporter.json (MCP-only setup)
  if (exists(MCPORTER_PATH)) {
    try {
      const config = JSON.parse(fs.readFileSync(MCPORTER_PATH, "utf8"));
      const token = config?.mcpServers?.senpi?.env?.SENPI_AUTH_TOKEN;
      const fromMcp = typeof token === "string" ? token.trim() : "";
      if (fromMcp) {
        ensureDir(path.dirname(SENPI_TOKEN_FILE));
        fs.writeFileSync(SENPI_TOKEN_FILE, fromMcp);
        console.log("[bootstrap] Migrated Senpi token from mcporter.json to config/senpi.token");
        return fromMcp;
      }
    } catch {
      // ignore
    }
  }
  return "";
}

// Recursive copy (Node 22 supports fs.cpSync)
function copyDirIfMissing(srcDir, dstDir) {
  if (!exists(srcDir)) return;
  if (exists(dstDir)) return;
  ensureDir(path.dirname(dstDir));
  fs.cpSync(srcDir, dstDir, { recursive: true });
}

/** When missing, OpenClaw may not expose llm-task/message for the main agent. */
const DEFAULT_AGENTS_LIST = [
  {
    id: "main",
    tools: {
      profile: "full",
      alsoAllow: ["llm-task", "message"],
    },
  },
];

function deepMerge(target, patch) {
  if (Array.isArray(target) || Array.isArray(patch)) return patch;
  if (typeof target !== "object" || target === null) return patch;
  if (typeof patch !== "object" || patch === null) return patch;

  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

function patchOpenClawJson() {
  const cfgPath = path.join(STATE_DIR, "openclaw.json");
  if (!exists(cfgPath)) return;

  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

  // Remove any invalid keys that would cause gateway startup to fail.
  delete cfg.mcpServers;

  // Union with existing allow so user-installed plugins stay permitted (deepMerge replaces arrays).
  const existingPluginAllow = Array.isArray(cfg.plugins?.allow)
    ? cfg.plugins.allow.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const bootstrapPluginAllow =
    process.env.SENPI_TRADING_RUNTIME_ENABLED !== "false"
      ? ["telegram", "llm-task", SENPI_RUNTIME_PLUGIN_ID]
      : ["telegram"];
  let pluginsAllow = [...new Set([...existingPluginAllow, ...bootstrapPluginAllow])];
  // Do not keep Senpi runtime plugin in allow when disabled.
  if (process.env.SENPI_TRADING_RUNTIME_ENABLED === "false") {
    pluginsAllow = pluginsAllow.filter((id) => id !== SENPI_RUNTIME_PLUGIN_ID);
  }

  const patch = {
    agents: {
      defaults: {
        workspace: WORKSPACE_DIR,
        // false = run BOOTSTRAP.md on agent startup (boot-md hook). true = bootstrap never runs.
        skipBootstrap: false,
        // Skills with many crons easily exceed the default 4/8 limits, causing
        // sessions to queue instead of running in parallel.
        maxConcurrent: 10,
        subagents: { maxConcurrent: 12 },
        thinkingDefault: "off",
      },
    },
    // Headless Railway deployment: disable exec approval prompts so mcporter (MCP)
    // and other tool calls don't stall waiting for manual approval.
    // See: https://docs.openclaw.ai/tools/exec
    // Note: tools.fs (workspaceOnly) is only supported in newer OpenClaw; omitted for 2026.2.12 compatibility.
    tools: {
      exec: {
        security: "full",
        ask: "off",
      },
    },
    gateway: {
      controlUi: {
        allowInsecureAuth: true,
        // Headless deployment: no device to pair; internal clients (Telegram provider, cron, session WS)
        // must connect with token only. Prevents [ws] code=1008 reason=connect failed / "pairing required".
        dangerouslyDisableDeviceAuth: true,
      },
      // Trust loopback so reverse-proxy and internal clients (e.g. Telegram provider) are accepted
      trustedProxies: ["127.0.0.1", "::1"],
      // Default reload mode to "restart" so gateway restarts on config changes;
      // preserve user-customized value if already set.
      ...(cfg.gateway?.reload?.mode ? {} : { reload: { mode: "restart" } }),
    },
    channels: {
      telegram: (() => {
        const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
        // Resolve numeric ID: env is numeric, or read from cache file
        console.log(`[bootstrap] TELEGRAM_USERNAME: ${TELEGRAM_USERNAME}`);
        let numericId = /^\d+$/.test(TELEGRAM_USERNAME) ? TELEGRAM_USERNAME : readCachedTelegramId();
        // Fallback: recover ID from USER.md (persisted from a previous successful resolution)
        if (!numericId) {
          numericId = readChatIdFromUserMd();
          if (numericId) {
            writeCachedTelegramId(numericId);
            console.log(`[bootstrap] Telegram: recovered ID ${numericId} from USER.md`);
          }
        }
        // Fallback: recover ID from existing config (survives redeploy on persistent volume)
        if (!numericId) {
          const existingAllowFrom = cfg.channels?.telegram?.allowFrom;
          if (Array.isArray(existingAllowFrom) && existingAllowFrom.length > 0) {
            const existing = String(existingAllowFrom[0]);
            if (/^\d+$/.test(existing)) {
              numericId = existing;
              writeCachedTelegramId(numericId);
              console.log(`[bootstrap] Telegram: recovered ID ${numericId} from existing config`);
            }
          }
        }
        console.log(`[bootstrap] numericId: ${numericId}`);
        const base = {
          enabled: true,
          streamMode: "block",
          blockStreaming: true,
        };
        if (numericId) {
          const existingAllowFrom = cfg.channels?.telegram?.allowFrom;
          const merged = Array.isArray(existingAllowFrom) ? [...existingAllowFrom] : [];
          if (!merged.includes(numericId)) merged.push(numericId);
          base.dmPolicy = "allowlist";
          const deduped = [...new Set(merged)];
          base.allowFrom = deduped.some((id) => id !== "*") ? deduped.filter((id) => id !== "*") : deduped;
          console.log(`[bootstrap] Telegram dmPolicy: allowlist (ID: ${numericId})`);
        } else {
          base.dmPolicy = "pairing";
          if (TELEGRAM_BOT_TOKEN) {
            console.warn("[bootstrap] Telegram: no cached user ID — using dmPolicy 'pairing' as safe fallback. Send /start to the bot and redeploy.");
          }
        }
        return base;
      })(),
    },
    plugins: {
      // Always include telegram (+ Senpi runtime plugin id "runtime" when enabled); preserve any other ids from config.
      allow: pluginsAllow,
      entries: (() => {
        const entries = { telegram: { enabled: true } };
        // Only add Senpi runtime if enabled (set SENPI_TRADING_RUNTIME_ENABLED=false when plugin is not installed)
        if (process.env.SENPI_TRADING_RUNTIME_ENABLED !== "false") {
          entries["llm-task"] = { enabled: true };
          entries[SENPI_RUNTIME_PLUGIN_ID] = {
            enabled: true,
            config: {
              stateDir: path.join(STATE_DIR, "senpi-state"),
              apiKey: resolveSenpiToken() || undefined,
            },
          };
        }
        return entries;
      })(),
    },
    hooks: {
      internal: {
        enabled: true,
        entries: {
          "boot-md": { enabled: true },
          "session-memory": { enabled: true },
          "command-logger": { enabled: true },
        },
      },
    },
  };

  const merged = deepMerge(cfg, patch);

  // When OPENCLAW_STATE_DIR is set, prefer STATE_DIR/extensions so one copy wins (no duplication with bundled)
  const stateDirSet = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateDirSet) {
    merged.plugins = merged.plugins || {};
    merged.plugins.load = merged.plugins.load || {};
    const paths = Array.isArray(merged.plugins.load.paths) ? merged.plugins.load.paths : [];
    const stateExt = path.join(STATE_DIR, "extensions");
    if (!paths.includes(stateExt)) merged.plugins.load.paths = [...paths, stateExt];
  }

  // If Senpi runtime is disabled, remove entries so config stays valid when plugin is not installed
  if (process.env.SENPI_TRADING_RUNTIME_ENABLED === "false" && merged.plugins?.entries) {
    delete merged.plugins.entries[SENPI_RUNTIME_PLUGIN_ID];
  }

  merged.agents = merged.agents || {};
  merged.agents.defaults = merged.agents.defaults || {};
  const existingModels =
    typeof merged.agents.defaults.models === "object" &&
    merged.agents.defaults.models !== null &&
    !Array.isArray(merged.agents.defaults.models)
      ? merged.agents.defaults.models
      : {};
  merged.agents.defaults.models = { ...DESIRED_MODELS, ...existingModels };

  const available = PROVIDER_DEFAULTS.filter((p) => process.env[p.key]?.trim());

  if (available.length === 0 && process.env.AI_PROVIDER?.trim() && process.env.AI_API_KEY?.trim()) {
    const aiModel = AI_PROVIDER_MODEL_MAP[process.env.AI_PROVIDER.trim().toLowerCase()];
    if (aiModel) available.push({ key: "AI_API_KEY", model: aiModel });
  }

  if (available.length > 0) {
    merged.agents.defaults.model = {
      primary: available[0].model,
      fallbacks: available.slice(1).map((p) => p.model),
    };
    console.log(
      `[bootstrap] Default model: ${available[0].model} (fallbacks: ${available.slice(1).map((p) => p.model).join(", ") || "none"})`
    );
  }

  // Always rewrite agents.list so profile/alsoAllow fixes take effect on every redeploy.
  // Find and patch the main agent entry if it exists; otherwise set the full default list.
  if (!Array.isArray(merged.agents.list) || merged.agents.list.length === 0) {
    merged.agents.list = structuredClone(DEFAULT_AGENTS_LIST);
    console.log("[bootstrap] Set agents.list (main: profile=full, alsoAllow llm-task/message)");
  } else {
    const mainIdx = merged.agents.list.findIndex((a) => a.id === "main");
    if (mainIdx !== -1) {
      const entry = merged.agents.list[mainIdx];
      // Fix: ensure profile=full and use alsoAllow (not allow) so all tools stay accessible.
      const tools = entry.tools || {};
      const wasAllow = Array.isArray(tools.allow);
      tools.profile = "full";
      tools.alsoAllow = Array.from(new Set([...(tools.alsoAllow || []), "llm-task", "message"]));
      if (wasAllow) {
        // allow acts as an intersection filter and overrides profile; remove it.
        delete tools.allow;
        console.log("[bootstrap] Removed agents.list[main].tools.allow (was restricting tools); using alsoAllow instead");
      }
      entry.tools = tools;
      merged.agents.list[mainIdx] = entry;
    } else {
      merged.agents.list.push(...structuredClone(DEFAULT_AGENTS_LIST));
      console.log("[bootstrap] Added main agent to agents.list (profile=full, alsoAllow llm-task/message)");
    }
  }

  // tools.fs is not supported in OpenClaw 2026.2.12; remove if present (e.g. from prior bootstrap).
  if (merged.tools && typeof merged.tools === "object") {
    delete merged.tools.fs;
  }
  fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
  if (process.env.SENPI_TRADING_RUNTIME_ENABLED !== "false") {
    console.log(
      "[bootstrap] Senpi runtime plugin configured (stateDir:",
      path.join(STATE_DIR, "senpi-state"),
      ")",
    );
  }
}

function writeMcporterConfig() {
  ensureDir(path.dirname(MCPORTER_PATH));

  const mcpUrl = process.env.SENPI_MCP_URL || "https://mcp.dev.senpi.ai/mcp";
  const senpiToken = resolveSenpiToken();

  // The senpi server entry we always want present
  const senpiEntry = {
    command: "npx",
    args: [
      "mcp-remote",
      mcpUrl,
      "--header",
      "Authorization: Bearer ${SENPI_AUTH_TOKEN}",
    ],
    env: {
      SENPI_AUTH_TOKEN: senpiToken,
    },
  };

  let config;
  if (exists(MCPORTER_PATH)) {
    // Smart merge: preserve any servers/settings the agent may have added
    try {
      config = JSON.parse(fs.readFileSync(MCPORTER_PATH, "utf8"));
      if (!config.mcpServers || typeof config.mcpServers !== "object") {
        config.mcpServers = {};
      }
    } catch {
      config = { mcpServers: {}, imports: [] };
    }
  } else {
    config = { mcpServers: {}, imports: [] };
  }

  // When token is blank, remove Senpi so the gateway doesn't try to connect (avoids auth failures / health check issues).
  // When token is set, upsert the senpi server.
  if (senpiToken) {
    config.mcpServers.senpi = senpiEntry;
  } else {
    delete config.mcpServers.senpi;
    console.log("[bootstrap] SENPI_AUTH_TOKEN is blank — Senpi MCP not configured (set it in Variables to enable).");
  }

  fs.writeFileSync(MCPORTER_PATH, JSON.stringify(config, null, 2));
}

/**
 * Sync managed workspace prompt files from the image into the persisted volume.
 * We overwrite these specific files on startup so prompt/rules updates actually
 * take effect across redeploys even when using a persistent volume.
 */
const IMAGE_WORKSPACE_DIR = "/opt/workspace-defaults";
const MANAGED_WORKSPACE_FILES = new Set([
  "AGENTS.md",
  "SOUL.md",
  "BOOTSTRAP.md",
  "TOOLS.md",
]);

function seedWorkspaceFiles() {
  if (!exists(IMAGE_WORKSPACE_DIR)) return;
  for (const name of fs.readdirSync(IMAGE_WORKSPACE_DIR)) {
    const dest = path.join(WORKSPACE_DIR, name);
    const src = path.join(IMAGE_WORKSPACE_DIR, name);
    if (MANAGED_WORKSPACE_FILES.has(name)) {
      fs.cpSync(src, dest);
      continue;
    }
    if (!exists(dest)) fs.cpSync(src, dest);
  }
}

/**
 * Ensure ~/.config/senpi/state.json exists with a default FRESH state.
 *
 * BOOTSTRAP.md runs on every agent startup and reads this file to determine onboarding
 * state. If the file or its parent directory is absent, the openclaw `read` tool
 * throws ENOENT at the I/O layer (logged as "[tools] read failed: ENOENT ...") before
 * the agent can handle it gracefully — and this repeats for every agent session.
 *
 * Creating the file at bootstrap time eliminates the ENOENT entirely:
 * - The agent reads it successfully and gets state = "FRESH" (not READY → onboarding).
 * - When Senpi later writes the real state (e.g. READY), this file is overwritten.
 * - We never overwrite an existing file, so real Senpi state is always preserved.
 */
function ensureSenpiStateFile() {
  const senpiDir = path.join(process.env.HOME || "~", ".config", "senpi");
  const senpiStatePath = path.join(senpiDir, "state.json");
  ensureDir(senpiDir);
  if (!exists(senpiStatePath)) {
    fs.writeFileSync(senpiStatePath, JSON.stringify({}));
  }
}

/**
 * Install @senpi-ai/runtime via openclaw CLI when config exists and plugin is enabled
 * but not yet installed. Ensures plugins.installs and state dir are correct for updates.
 */
function installSenpiRuntimePluginIfNeeded() {
  if (process.env.SENPI_TRADING_RUNTIME_ENABLED === "false") return;
  const cfgPath = path.join(STATE_DIR, "openclaw.json");
  if (!exists(cfgPath)) return;

  // Senpi runtime depends on the llm-task plugin surface. Run on every boot when
  // enabled — not only on first install (early return below skipped this).
  const enableLlmTask = spawnSync("openclaw", ["plugins", "enable", "llm-task"], {
    env: { ...process.env, OPENCLAW_STATE_DIR: STATE_DIR },
    stdio: "pipe",
    encoding: "utf8",
  });
  if (enableLlmTask.status !== 0) {
    console.error(
      "[bootstrap] openclaw plugins enable llm-task failed:",
      enableLlmTask.stderr || enableLlmTask.stdout
    );
    // Continue; failing to enable llm-task should not necessarily block
    // the wrapper boot in environments that already have it enabled.
  }

  const pluginDir = path.join(STATE_DIR, "extensions", "@senpi-ai", "runtime");
  if (exists(pluginDir)) return;

  ensureDir(path.join(STATE_DIR, "extensions"));
  const result = spawnSync(
    "openclaw",
    ["plugins", "install", SENPI_RUNTIME_NPM_SPEC],
    {
      env: { ...process.env, OPENCLAW_STATE_DIR: STATE_DIR },
      stdio: "pipe",
      encoding: "utf8",
    }
  );
  if (result.status !== 0) {
    console.error(
      `[bootstrap] openclaw plugins install ${SENPI_RUNTIME_NPM_SPEC} failed:`,
      result.stderr || result.stdout
    );
    return;
  }
  console.log(`[bootstrap] ${SENPI_RUNTIME_NPM_SPEC} installed via openclaw plugins install`);
}

/**
 * Install the senpi-trading-runtime help skill by cloning the senpi-skills repo
 * at SENPI_SKILLS_BRANCH and copying the skill subdir into STATE_DIR/skills/.
 *
 * The skill lives under a feature branch until merged to main.
 * Update SENPI_SKILLS_BRANCH in this file when that happens.
 *
 * Idempotency: a sentinel file at STATE_DIR/config/senpi-trading-runtime-skill.installed
 * is written on first success and checked on every subsequent boot.
 *
 * Non-fatal: a failure is logged but does not prevent the gateway from starting.
 */
function installSenpiTradingRuntimeSkillIfNeeded() {
  if (process.env.SENPI_TRADING_RUNTIME_ENABLED === "false") return;
  const cfgPath = path.join(STATE_DIR, "openclaw.json");
  if (!exists(cfgPath)) return;

  const sentinelPath = path.join(STATE_DIR, "config", `${SENPI_TRADING_RUNTIME_SKILL_NAME}-skill.installed`);
  if (exists(sentinelPath)) {
    console.log(`[bootstrap] ${SENPI_TRADING_RUNTIME_SKILL_NAME} skill already installed, skipping`);
    return;
  }

  // Clone the skill directory directly from the repo rather than using the `skills` CLI.
  // The `skills` CLI mis-parses branch names containing "/" (e.g. "SAITA/dsl") and leaks
  // the branch suffix into the skill-name filter, causing "No matching skills found".
  // Cloning the full repo at the target branch and copying the skill subdir is reliable.
  const tmpDir = path.join(STATE_DIR, "tmp", `${SENPI_TRADING_RUNTIME_SKILL_NAME}-clone`);
  const skillDestDir = path.join(STATE_SKILLS_DIR, SENPI_TRADING_RUNTIME_SKILL_NAME);

  // Clean up any previous failed clone attempt.
  if (exists(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
  ensureDir(path.dirname(tmpDir));

  console.log(`[bootstrap] Cloning ${SENPI_SKILLS_REPO}@${SENPI_SKILLS_BRANCH} for skill install ...`);
  const cloneResult = spawnSync(
    "git",
    ["clone", "--depth", "1", "--branch", SENPI_SKILLS_BRANCH, SENPI_SKILLS_REPO, tmpDir],
    { stdio: "pipe", encoding: "utf8" }
  );

  if (cloneResult.status !== 0) {
    console.error(
      `[bootstrap] ${SENPI_TRADING_RUNTIME_SKILL_NAME} skill clone failed (non-fatal):`,
      cloneResult.stderr || cloneResult.stdout
    );
    return;
  }

  const skillSrcDir = path.join(tmpDir, SENPI_TRADING_RUNTIME_SKILL_NAME);
  if (!exists(skillSrcDir)) {
    console.error(`[bootstrap] ${SENPI_TRADING_RUNTIME_SKILL_NAME} skill directory not found in cloned repo`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  ensureDir(STATE_SKILLS_DIR);
  fs.cpSync(skillSrcDir, skillDestDir, { recursive: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Write sentinel so future boots skip the install.
  ensureDir(path.dirname(sentinelPath));
  fs.writeFileSync(sentinelPath, new Date().toISOString());
  console.log(`[bootstrap] ${SENPI_TRADING_RUNTIME_SKILL_NAME} skill installed (branch: ${SENPI_SKILLS_BRANCH})`);
}

export function bootstrapOpenClaw() {
  ensureDir(STATE_DIR);
  ensureDir(WORKSPACE_DIR);

  // Ensure MEMORY.md exists (OpenClaw injects it into sessions; missing = noisy error in chat)
  const memoryFile = path.join(WORKSPACE_DIR, "MEMORY.md");
  if (!exists(memoryFile)) {
    fs.writeFileSync(memoryFile, "# Memory\n\nLong-term context across sessions.\n");
  }

  // Ensure memory/ directory exists (daily memory logs)
  ensureDir(path.join(WORKSPACE_DIR, "memory"));

  // Copy mcporter skill into persisted state (so OpenClaw loads it naturally)
  ensureDir(STATE_SKILLS_DIR);
  copyDirIfMissing(
    path.join(IMAGE_SKILLS_DIR, "mcporter"),
    path.join(STATE_SKILLS_DIR, "mcporter"),
  );

  ensureSenpiStateFile();
  writeMcporterConfig();
  seedWorkspaceFiles();
  installSenpiRuntimePluginIfNeeded();
  installSenpiTradingRuntimeSkillIfNeeded();
  patchOpenClawJson();
}
