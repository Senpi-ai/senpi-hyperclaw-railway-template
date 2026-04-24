/**
 * Single source of truth for AI provider selection.
 *
 * Consumed by:
 *   - src/routes/setup.js (wizard dropdown via /api/status)
 *   - src/onboard.js (buildOnboardArgs → maps authChoice to CLI flag)
 *   - src/lib/config.js (PROVIDER_TO_AUTH_CHOICE for auto-onboard)
 *
 * Each option may carry:
 *   - onboardFlag: the `openclaw onboard` CLI flag that carries the API key
 *   - apiUrl: spec for rendering an API URL text field in the wizard
 *   - models: list of models to register in openclaw config (post-onboard)
 *   - defaultModelId: pre-selected in the wizard's model dropdown
 */

export const AUTH_PROVIDERS = [
  {
    value: "openai",
    label: "OpenAI",
    hint: "Codex OAuth + API key",
    envAlias: "openai",
    defaultAuthChoice: "openai-api-key",
    options: [
      { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
      { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
      { value: "openai-api-key", label: "OpenAI API key", onboardFlag: "--openai-api-key" },
    ],
  },
  {
    value: "anthropic",
    label: "Anthropic",
    hint: "Claude Code CLI + API key",
    envAlias: "anthropic",
    defaultAuthChoice: "apiKey",
    options: [
      { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
      { value: "token", label: "Anthropic token (paste setup-token)" },
      { value: "apiKey", label: "Anthropic API key", onboardFlag: "--anthropic-api-key" },
    ],
  },
  {
    value: "google",
    label: "Google",
    hint: "Gemini API key + Vertex AI + OAuth",
    envAlias: "google",
    defaultAuthChoice: "gemini-api-key",
    options: [
      { value: "gemini-api-key", label: "Google Gemini API key", onboardFlag: "--gemini-api-key" },
      { value: "google-antigravity", label: "Google Antigravity OAuth" },
      { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" },
    ],
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "API key",
    envAlias: "openrouter",
    defaultAuthChoice: "openrouter-api-key",
    options: [
      { value: "openrouter-api-key", label: "OpenRouter API key", onboardFlag: "--openrouter-api-key" },
    ],
  },
  {
    value: "ai-gateway",
    label: "Vercel AI Gateway",
    hint: "API key",
    envAlias: "ai-gateway",
    defaultAuthChoice: "ai-gateway-api-key",
    options: [
      { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key", onboardFlag: "--ai-gateway-api-key" },
    ],
  },
  {
    value: "moonshot",
    label: "Moonshot AI",
    hint: "Kimi K2 + Kimi Code",
    envAlias: "moonshot",
    defaultAuthChoice: "moonshot-api-key",
    options: [
      { value: "moonshot-api-key", label: "Moonshot AI API key", onboardFlag: "--moonshot-api-key" },
      { value: "kimi-code-api-key", label: "Kimi Code API key", onboardFlag: "--kimi-code-api-key" },
    ],
  },
  {
    value: "zai",
    label: "Z.AI (GLM 4.7)",
    hint: "API key",
    envAlias: "zai",
    defaultAuthChoice: "zai-api-key",
    options: [
      { value: "zai-api-key", label: "Z.AI (GLM 4.7) API key", onboardFlag: "--zai-api-key" },
    ],
  },
  {
    value: "minimax",
    label: "MiniMax",
    hint: "M2.1 (recommended)",
    envAlias: "minimax",
    defaultAuthChoice: "minimax-api",
    options: [
      { value: "minimax-api", label: "MiniMax M2.1", onboardFlag: "--minimax-api-key" },
      { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning", onboardFlag: "--minimax-api-key" },
    ],
  },
  {
    value: "qwen",
    label: "Qwen",
    hint: "OAuth",
    envAlias: "qwen",
    defaultAuthChoice: "qwen-portal",
    options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
  },
  {
    value: "copilot",
    label: "Copilot",
    hint: "GitHub + local proxy",
    envAlias: "copilot",
    defaultAuthChoice: "github-copilot",
    options: [
      { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
      { value: "copilot-proxy", label: "Copilot Proxy (local)" },
    ],
  },
  {
    value: "venice",
    label: "Venice AI",
    hint: "Private & uncensored models",
    envAlias: "venice",
    defaultAuthChoice: "venice-api-key",
    options: [
      { value: "venice-api-key", label: "Venice AI API key", onboardFlag: "--venice-api-key" },
    ],
  },
  {
    value: "synthetic",
    label: "Synthetic",
    hint: "Anthropic-compatible (multi-model)",
    envAlias: "synthetic",
    defaultAuthChoice: "synthetic-api-key",
    options: [
      { value: "synthetic-api-key", label: "Synthetic API key", onboardFlag: "--synthetic-api-key" },
    ],
  },
  {
    value: "opencode-zen",
    label: "OpenCode Zen",
    hint: "API key",
    envAlias: "opencode-zen",
    defaultAuthChoice: "opencode-zen",
    options: [
      { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)", onboardFlag: "--opencode-zen-api-key" },
    ],
  },
  {
    value: "litellm",
    label: "LiteLLM",
    hint: "Unified gateway (Vertex AI: Gemini/Claude/Qwen/Gemma)",
    envAlias: "litellm",
    defaultAuthChoice: "litellm-api-key",
    options: [
      {
        value: "litellm-api-key",
        label: "LiteLLM API key",
        onboardFlag: "--litellm-api-key",
        apiUrl: {
          required: true,
          default: "http://litellm.dev.senpi.ai/v1",
          placeholder: "http://litellm.dev.senpi.ai/v1",
          help: "LiteLLM proxy base URL (OpenAI-compatible /v1 endpoint).",
        },
        models: [
          { id: "vertex_ai/gemini", label: "Vertex AI — Gemini", contextWindow: 1000000, input: ["text", "image"], reasoning: true },
          { id: "vertex_ai/claude", label: "Vertex AI — Claude", contextWindow: 2000000, input: ["text", "image"], reasoning: true },
          { id: "vertex_ai/qwen", label: "Vertex AI — Qwen", contextWindow: 256000, input: ["text"] },
          { id: "vertex_ai/gemma", label: "Vertex AI — Gemma", contextWindow: 256000, input: ["text"] },
        ],
        defaultModelId: "vertex_ai/gemini",
      },
    ],
  },
];

/**
 * UI payload for the setup wizard. Strips server-only fields (onboardFlag)
 * but keeps apiUrl + models so the client can render the right inputs.
 */
export function buildAuthGroupsForUi() {
  return AUTH_PROVIDERS.map((g) => ({
    value: g.value,
    label: g.label,
    hint: g.hint,
    options: g.options.map((o) => {
      const out = { value: o.value, label: o.label };
      if (o.apiUrl) out.apiUrl = o.apiUrl;
      if (o.models) out.models = o.models;
      if (o.defaultModelId) out.defaultModelId = o.defaultModelId;
      return out;
    }),
  }));
}

/**
 * Find the option entry for a given authChoice value.
 * Returns { group, option } or null.
 */
export function findAuthOption(authChoice) {
  if (!authChoice) return null;
  for (const g of AUTH_PROVIDERS) {
    for (const o of g.options) {
      if (o.value === authChoice) return { group: g, option: o };
    }
  }
  return null;
}

/**
 * Build AI_PROVIDER → authChoice map for auto-onboard (env-driven).
 * Also includes legacy aliases like "gemini" → gemini-api-key.
 */
export function buildProviderToAuthChoice() {
  const map = {};
  for (const g of AUTH_PROVIDERS) {
    if (g.envAlias && g.defaultAuthChoice) {
      map[g.envAlias] = g.defaultAuthChoice;
    }
  }
  map.gemini = map.google ?? "gemini-api-key";
  map["kimi-code"] = "kimi-code-api-key";
  return map;
}
