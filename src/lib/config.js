/**
 * Environment and paths. Pure config; no gateway or HTTP.
 */

import fs from "node:fs";
import path from "node:path";

export const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() || "/data/.openclaw";
export const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() || "/data/workspace";

export const INTERNAL_GATEWAY_PORT = Number(
  process.env.INTERNAL_GATEWAY_PORT?.trim() || "18789"
);
const INTERNAL_GATEWAY_HOST =
  process.env.INTERNAL_GATEWAY_HOST?.trim() || "127.0.0.1";
export const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

export const GATEWAY_READY_TIMEOUT_MS = Number(
  process.env.GATEWAY_READY_TIMEOUT_MS?.trim() || "20000"
);

export const OPENCLAW_ENTRY =
  process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
export const OPENCLAW_NODE =
  process.env.OPENCLAW_NODE?.trim() || "node";

export const PORT = Number(process.env.PORT?.trim() || "8080");

/** Strip optional "Bearer " prefix from a string. */
export function stripBearer(s) {
  if (typeof s !== "string") return (s ?? "").trim();
  const t = s.trim();
  return t.toLowerCase().startsWith("bearer ") ? t.slice(7).trim() : t;
}

export const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();
export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
export const TELEGRAM_USERNAME = process.env.TELEGRAM_USERID?.trim() || process.env.TELEGRAM_USERNAME?.trim() || "";
export const AI_PROVIDER =
  process.env.AI_PROVIDER?.trim()?.toLowerCase() || "";
export const AI_API_KEY = stripBearer(
  process.env.AI_API_KEY?.trim() || ""
);

/** Map AI_PROVIDER (env) to openclaw --auth-choice value for auto-onboard. */
export const PROVIDER_TO_AUTH_CHOICE = {
  anthropic: "apiKey",
  openai: "openai-api-key",
  openrouter: "openrouter-api-key",
  gemini: "gemini-api-key",
  google: "gemini-api-key",
  "ai-gateway": "ai-gateway-api-key",
  moonshot: "moonshot-api-key",
  "kimi-code": "kimi-code-api-key",
  zai: "zai-api-key",
  venice: "venice-api-key",
  minimax: "minimax-api",
  synthetic: "synthetic-api-key",
  "opencode-zen": "opencode-zen",
};

/** Providers that use ADC/OAuth instead of an API key (AI_API_KEY not required). */
export const PROVIDERS_WITHOUT_API_KEY = new Set([]);

/**
 * Map AI_PROVIDER to its provider-specific env var name.
 * When AI_API_KEY is unset, resolveEffectiveApiKey() falls back to these.
 */
const PROVIDER_API_KEY_ENV = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GEMINI_API_KEY",
  google: "GEMINI_API_KEY",
  xai: "XAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  together: "TOGETHER_API_KEY",
  zai: "ZAI_API_KEY",
  moonshot: "MOONSHOT_API_KEY",
  venice: "VENICE_API_KEY",
  minimax: "MINIMAX_API_KEY",
  synthetic: "SYNTHETIC_API_KEY",
  "opencode-zen": "OPENCODE_API_KEY",
};

/**
 * Resolve the effective API key for the current AI_PROVIDER.
 * Priority: AI_API_KEY > provider-specific env var (e.g. VENICE_API_KEY).
 */
export function resolveEffectiveApiKey() {
  if (AI_API_KEY) return AI_API_KEY;
  const envVar = PROVIDER_API_KEY_ENV[AI_PROVIDER];
  if (envVar) return stripBearer(process.env[envVar]?.trim() || "");
  return "";
}

export const TELEGRAM_CHAT_ID_FILE = path.join(STATE_DIR, "telegram-chat-id");

export function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

export function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

export const DEBUG =
  process.env.OPENCLAW_TEMPLATE_DEBUG?.toLowerCase() === "true";

/**
 * Ensure STATE_DIR and WORKSPACE_DIR exist and are writable. Call at startup.
 * Throws if creation or write test fails.
 */
export function ensureWritableDirs() {
  const dirs = [
    [STATE_DIR, "OPENCLAW_STATE_DIR"],
    [WORKSPACE_DIR, "OPENCLAW_WORKSPACE_DIR"],
  ];
  for (const [dir, label] of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".write-test"), "");
      fs.unlinkSync(path.join(dir, ".write-test"));
    } catch (err) {
      throw new Error(
        `${label} (${dir}) is not writable: ${err.message}. Fix permissions or set a writable path.`
      );
    }
  }
}
