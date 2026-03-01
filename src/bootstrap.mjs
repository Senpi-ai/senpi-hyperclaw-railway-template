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

  // Comprehensive model allowlist — users can /model switch without "not allowed" errors.
  // Only requires the provider's API key to actually use a model.
  const DESIRED_MODELS = {
    // ── Anthropic ──
    "anthropic/claude-opus-4-6": { alias: "Opus 4.6" },
    "anthropic/claude-sonnet-4-6": { alias: "Sonnet 4.6" },
    "anthropic/claude-sonnet-4-5": { alias: "Sonnet 4.5" },
    "anthropic/claude-opus-4-5": { alias: "Opus 4.5" },
    "anthropic/claude-haiku-4-5": { alias: "Haiku 4.5" },
    "anthropic/claude-haiku-3-5": { alias: "Haiku 3.5" },
    "anthropic/claude-sonnet-4": { alias: "Sonnet 4" },
    "anthropic/claude-opus-4": { alias: "Opus 4" },
    // ── OpenAI (API key) ──
    "openai/gpt-5.2": { alias: "GPT-5.2" },
    "openai/gpt-5.1-codex": { alias: "GPT-5.1 Codex" },
    "openai/gpt-4.1": { alias: "GPT-4.1" },
    "openai/gpt-4.1-mini": { alias: "GPT-4.1 Mini" },
    "openai/gpt-4o": { alias: "GPT-4o" },
    "openai/gpt-4o-mini": { alias: "GPT-4o Mini" },
    "openai/o3": { alias: "o3" },
    "openai/o3-mini": { alias: "o3 Mini" },
    "openai/o4-mini": { alias: "o4 Mini" },
    // ── OpenAI Codex (subscription/OAuth) ──
    "openai-codex/gpt-5.3-codex": { alias: "GPT-5.3 Codex" },
    // ── Google Gemini ──
    "google/gemini-3-pro-preview": { alias: "Gemini 3 Pro" },
    "google/gemini-3-flash-preview": { alias: "Gemini 3 Flash" },
    "google/gemini-2.5-pro": { alias: "Gemini 2.5 Pro" },
    "google/gemini-2.5-flash": { alias: "Gemini 2.5 Flash" },
    // ── xAI ──
    "xai/grok-3": { alias: "Grok 3" },
    "xai/grok-3-mini": { alias: "Grok 3 Mini" },
    // ── Groq ──
    "groq/llama-3.3-70b": { alias: "Llama 3.3 70B (Groq)" },
    // ── Mistral ──
    "mistral/mistral-large-latest": { alias: "Mistral Large" },
    "mistral/codestral-latest": { alias: "Codestral" },
    // ── Together AI ──
    "together/moonshotai/Kimi-K2.5": { alias: "Kimi K2.5 (Together)" },
    "together/meta-llama/llama-3.3-70b-instruct-turbo": { alias: "Llama 3.3 70B (Together)" },
    "together/deepseek/deepseek-r1": { alias: "DeepSeek R1 (Together)" },
    // ── Z.AI / GLM ──
    "zai/glm-5": { alias: "GLM-5" },
    "zai/glm-4.7": { alias: "GLM-4.7" },
    "zai/glm-4.6": { alias: "GLM-4.6" },
    // ── Moonshot AI (Kimi) ──
    "moonshot/kimi-k2.5": { alias: "Kimi K2.5" },
    "moonshot/kimi-k2-thinking": { alias: "Kimi K2 Thinking" },
    "moonshot/kimi-k2-thinking-turbo": { alias: "Kimi K2 Thinking Turbo" },
    // ── Venice AI (privacy-focused) ──
    "venice/llama-3.3-70b": { alias: "Llama 3.3 70B (Venice)" },
    "venice/claude-opus-45": { alias: "Opus 4.5 (Venice)" },
    "venice/claude-sonnet-45": { alias: "Sonnet 4.5 (Venice)" },
    "venice/openai-gpt-52": { alias: "GPT-5.2 (Venice)" },
    "venice/deepseek-v3.2": { alias: "DeepSeek V3.2 (Venice)" },
    "venice/qwen3-coder-480b-a35b-instruct": { alias: "Qwen3 Coder (Venice)" },
    // ── MiniMax ──
    "minimax/MiniMax-M2.1": { alias: "MiniMax M2.1" },
    "minimax/MiniMax-M2.1-lightning": { alias: "MiniMax M2.1 Lightning" },
    // ── NVIDIA ──
    "nvidia/nvidia/llama-3.1-nemotron-70b-instruct": { alias: "Nemotron 70B" },
    "nvidia/meta/llama-3.3-70b-instruct": { alias: "Llama 3.3 70B (NVIDIA)" },
    // ── OpenRouter (proxy — prefix with openrouter/) ──
    "openrouter/anthropic/claude-sonnet-4-5": { alias: "Sonnet 4.5 (OpenRouter)" },
    "openrouter/openai/gpt-4.1": { alias: "GPT-4.1 (OpenRouter)" },
    "openrouter/deepseek/deepseek-chat": { alias: "DeepSeek Chat (OpenRouter)" },
    "openrouter/google/gemini-2.5-pro": { alias: "Gemini 2.5 Pro (OpenRouter)" },
    // ── OpenCode Zen ──
    "opencode/claude-opus-4-6": { alias: "Opus 4.6 (OpenCode)" },
    // ── Hugging Face ──
    "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1 (HF)" },
    // ── Amazon Bedrock ──
    "amazon-bedrock/anthropic.claude-opus-4-6": { alias: "Opus 4.6 (Bedrock)" },
    "amazon-bedrock/anthropic.claude-sonnet-4-6": { alias: "Sonnet 4.6 (Bedrock)" },
  };
  merged.agents = merged.agents || {};
  merged.agents.defaults = merged.agents.defaults || {};
  const existingModels =
    typeof merged.agents.defaults.models === "object" &&
    merged.agents.defaults.models !== null &&
    !Array.isArray(merged.agents.defaults.models)
      ? merged.agents.defaults.models
      : {};
  // User customizations (e.g. cacheRetention, temperature) take precedence.
  merged.agents.defaults.models = { ...DESIRED_MODELS, ...existingModels };

  // Set default primary model based on which provider API key is configured.
  // Check provider-specific env vars first, then fall back to AI_PROVIDER.
  const PROVIDER_DEFAULTS = [
    { key: "ANTHROPIC_API_KEY", model: "anthropic/claude-opus-4-6" },
    { key: "OPENAI_API_KEY", model: "openai/gpt-5.2" },
    { key: "GEMINI_API_KEY", model: "google/gemini-3-pro-preview" },
    { key: "XAI_API_KEY", model: "xai/grok-3" },
    { key: "MISTRAL_API_KEY", model: "mistral/mistral-large-latest" },
    { key: "GROQ_API_KEY", model: "groq/llama-3.3-70b" },
    { key: "TOGETHER_API_KEY", model: "together/moonshotai/Kimi-K2.5" },
    { key: "ZAI_API_KEY", model: "zai/glm-5" },
    { key: "MOONSHOT_API_KEY", model: "moonshot/kimi-k2.5" },
    { key: "VENICE_API_KEY", model: "venice/llama-3.3-70b" },
    { key: "OPENROUTER_API_KEY", model: "openrouter/anthropic/claude-sonnet-4-5" },
  ];
  const available = PROVIDER_DEFAULTS.filter((p) => process.env[p.key]?.trim());

  // Fallback: if no provider-specific key matched but AI_PROVIDER + AI_API_KEY
  // are set (used by auto-onboard), pick the model from AI_PROVIDER.
  const AI_PROVIDER_MODEL_MAP = {
    anthropic: "anthropic/claude-opus-4-6",
    openai: "openai/gpt-5.2",
    gemini: "google/gemini-3-pro-preview",
    google: "google/gemini-3-pro-preview",
    openrouter: "openrouter/anthropic/claude-sonnet-4-5",
    moonshot: "moonshot/kimi-k2.5",
    zai: "zai/glm-5",
    mistral: "mistral/mistral-large-latest",
    minimax: "minimax/MiniMax-M2.1",
  };
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
