import fs from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";

// Config path — MCPORTER_CONFIG is set as a Railway env var so every process
// in the container (wrapper, gateway, agent, tools) can find it.
const MCPORTER_PATH =
  process.env.MCPORTER_CONFIG ||
  path.join(STATE_DIR, "config", "mcporter.json");

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
        // false = run BOOT.md on agent startup (boot-md hook). true = BOOT.md never runs.
        skipBootstrap: false,
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
        streamMode: "partial",
        blockStreaming: true,
      },
    },
    plugins: {
      entries: {
        telegram: { enabled: true },
      },
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
  // tools.fs is not supported in OpenClaw 2026.2.12; remove if present (e.g. from prior bootstrap).
  if (merged.tools && typeof merged.tools === "object") {
    delete merged.tools.fs;
  }
  fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
}

function writeMcporterConfig() {
  ensureDir(path.dirname(MCPORTER_PATH));

  const mcpUrl = process.env.SENPI_MCP_URL || "https://mcp.dev.senpi.ai/mcp";
  const senpiToken = process.env.SENPI_AUTH_TOKEN?.trim() || "";

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
  "BOOT.md",
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
 * BOOT.md runs on every agent startup and reads this file to determine onboarding
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
    fs.writeFileSync(senpiStatePath, JSON.stringify({ state: "FRESH" }, null, 2));
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
