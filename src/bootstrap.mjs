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
        skipBootstrap: true,
      },
    },
    channels: {
      telegram: { enabled: true },
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

  // Upsert the senpi server (update token + URL, keep everything else)
  config.mcpServers.senpi = senpiEntry;

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

  writeMcporterConfig();
  seedWorkspaceFiles();
  patchOpenClawJson();
}
