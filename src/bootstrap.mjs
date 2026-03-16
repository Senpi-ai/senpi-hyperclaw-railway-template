import fs from "node:fs";
import path from "node:path";
import {
  DESIRED_MODELS,
  PROVIDER_DEFAULTS,
  AI_PROVIDER_MODEL_MAP,
} from "./lib/models.js";

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
    },
    channels: {
      telegram: {
        enabled: true,
        dmPolicy: "open",
        allowFrom: ["*"],
        streamMode: "block",
        blockStreaming: true,
      },
    },
    plugins: {
      entries: (() => {
        const entries = { telegram: { enabled: true } };
        // Only add trading-runtime if enabled (set SENPI_TRADING_RUNTIME_ENABLED=false to omit when plugin is not in image)
        if (process.env.SENPI_TRADING_RUNTIME_ENABLED !== "false") {
          entries["trading-runtime"] = {
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

  // If trading-runtime is disabled, remove it so config stays valid when plugin is not in image
  if (process.env.SENPI_TRADING_RUNTIME_ENABLED === "false" && merged.plugins?.entries) {
    delete merged.plugins.entries["trading-runtime"];
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

  // tools.fs is not supported in OpenClaw 2026.2.12; remove if present (e.g. from prior bootstrap).
  if (merged.tools && typeof merged.tools === "object") {
    delete merged.tools.fs;
  }
  fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
  if (process.env.SENPI_TRADING_RUNTIME_ENABLED !== "false") {
    console.log("[bootstrap] trading-runtime plugin configured (stateDir:", path.join(STATE_DIR, "senpi-state"), ")");
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
  patchOpenClawJson();
}
