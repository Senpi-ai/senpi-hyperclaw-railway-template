/**
 * AI model catalog, provider defaults, and provider-to-model mapping.
 * Extracted from bootstrap.mjs so the model list is easy to maintain.
 */

/**
 * Comprehensive model allowlist — users can /model switch without "not allowed" errors.
 * Only requires the provider's API key to actually use a model.
 */
export const DESIRED_MODELS = {
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
  "openai/gpt-5.4": { alias: "GPT-5.4" },
  "openai/gpt-5.4-mini": { alias: "GPT-5.4 Mini" },
  "openai/gpt-5.4-nano": { alias: "GPT-5.4 Nano" },
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
  "google/gemini-3.1-pro-preview": { alias: "Gemini 3.1 Pro" },
  "google/gemini-3-flash-preview": { alias: "Gemini 3 Flash" },
  "google/gemini-3.1-flash-lite-preview": { alias: "Gemini 3.1 Flash Lite" },
  "google/gemini-2.5-pro": { alias: "Gemini 2.5 Pro" },
  "google/gemini-2.5-flash": { alias: "Gemini 2.5 Flash" },
  "google/gemini-2.5-flash-lite": { alias: "Gemini 2.5 Flash Lite" },
  // ── Google Gemini (Specialized) ──
  "google/gemini-2.5-flash-image": { alias: "Gemini 2.5 Flash Image" },
  "google/gemini-3.1-flash-image-preview": { alias: "Gemini 3.1 Flash Image" },
  "google/gemini-3-pro-image-preview": { alias: "Gemini 3 Pro Image" },
  "google/gemini-2.5-flash-native-audio-preview-12-2025": { alias: "Gemini 2.5 Flash Audio" },
  "google/gemini-2.5-flash-preview-tts": { alias: "Gemini 2.5 Flash TTS" },
  "google/gemini-2.5-pro-preview-tts": { alias: "Gemini 2.5 Pro TTS" },
  "google/gemini-2.5-computer-use-preview-10-2025": { alias: "Gemini 2.5 Computer Use" },
  "google/gemini-embedding-001": { alias: "Gemini Embedding" },
  "google/gemini-robotics-er-1.5-preview": { alias: "Gemini Robotics ER" },
  "google/deep-research-pro-preview-12-2025": { alias: "Deep Research Pro" },
  "google/imagen-4": { alias: "Imagen 4" },
  "google/veo-3.1-generate-preview": { alias: "Veo 3.1" },
  "google/lyria-realtime-exp": { alias: "Lyria Realtime" },


  // ── xAI ──
  "xai/grok-4.20": { alias: "Grok 4.20" },
  "xai/grok-4": { alias: "Grok 4" },
  "xai/grok-4.1-fast": { alias: "Grok 4.1 Fast" },
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
  "zai/glm-5.1": { alias: "GLM-5.1" },
  "zai/glm-5": { alias: "GLM-5" },
  "zai/glm-4.7": { alias: "GLM-4.7" },
  "zai/glm-4.6": { alias: "GLM-4.6" },

  // ── Moonshot AI (Kimi) ──
  "moonshot/kimi-k2.5": { alias: "Kimi K2.5" },
  "moonshot/kimi-k2-thinking": { alias: "Kimi K2 Thinking" },
  "moonshot/kimi-k2-thinking-turbo": { alias: "Kimi K2 Thinking Turbo" },

  // ── Venice AI — Private models (no logging) ──
  "venice/kimi-k2-5": { alias: "Kimi K2.5 (Venice)" },
  "venice/kimi-k2-thinking": { alias: "Kimi K2 Thinking (Venice)" },
  "venice/llama-3.3-70b": { alias: "Llama 3.3 70B (Venice)" },
  "venice/llama-3.2-3b": { alias: "Llama 3.2 3B (Venice)" },
  "venice/hermes-3-llama-3.1-405b": { alias: "Hermes 3 405B (Venice)" },
  "venice/qwen3-235b-a22b-thinking-2507": { alias: "Qwen3 235B Thinking (Venice)" },
  "venice/qwen3-235b-a22b-instruct-2507": { alias: "Qwen3 235B Instruct (Venice)" },
  "venice/qwen3-coder-480b-a35b-instruct": { alias: "Qwen3 Coder 480B (Venice)" },
  "venice/qwen3-coder-480b-a35b-instruct-turbo": { alias: "Qwen3 Coder 480B Turbo (Venice)" },
  "venice/qwen3-5-35b-a3b": { alias: "Qwen3.5 35B (Venice)" },
  "venice/qwen3-next-80b": { alias: "Qwen3 Next 80B (Venice)" },
  "venice/qwen3-vl-235b-a22b": { alias: "Qwen3 VL 235B (Venice)" },
  "venice/qwen3-4b": { alias: "Qwen3 4B (Venice)" },
  "venice/deepseek-v3.2": { alias: "DeepSeek V3.2 (Venice)" },
  "venice/venice-uncensored": { alias: "Venice Uncensored" },
  "venice/mistral-31-24b": { alias: "Mistral 3.1 24B (Venice)" },
  "venice/google-gemma-3-27b-it": { alias: "Gemma 3 27B (Venice)" },
  "venice/openai-gpt-oss-120b": { alias: "GPT OSS 120B (Venice)" },
  "venice/nvidia-nemotron-3-nano-30b-a3b": { alias: "Nemotron 3 Nano 30B (Venice)" },
  "venice/olafangensan-glm-4.7-flash-heretic": { alias: "GLM 4.7 Flash Heretic (Venice)" },
  "venice/zai-org-glm-4.6": { alias: "GLM 4.6 (Venice)" },
  "venice/zai-org-glm-4.7": { alias: "GLM 4.7 (Venice)" },
  "venice/zai-org-glm-4.7-flash": { alias: "GLM 4.7 Flash (Venice)" },
  "venice/zai-org-glm-5": { alias: "GLM 5 (Venice)" },
  "venice/minimax-m21": { alias: "MiniMax M2.1 (Venice)" },
  "venice/minimax-m25": { alias: "MiniMax M2.5 (Venice)" },

  // ── Venice AI — Anonymized models (via proxy) ──
  "venice/claude-opus-4-6": { alias: "Claude Opus 4.6 (Venice)" },
  "venice/claude-opus-4-5": { alias: "Claude Opus 4.5 (Venice)" },
  "venice/claude-sonnet-4-6": { alias: "Claude Sonnet 4.6 (Venice)" },
  "venice/claude-sonnet-4-5": { alias: "Claude Sonnet 4.5 (Venice)" },
  "venice/openai-gpt-54": { alias: "GPT-5.4 (Venice)" },
  "venice/openai-gpt-53-codex": { alias: "GPT-5.3 Codex (Venice)" },
  "venice/openai-gpt-52": { alias: "GPT-5.2 (Venice)" },
  "venice/openai-gpt-52-codex": { alias: "GPT-5.2 Codex (Venice)" },
  "venice/openai-gpt-4o-2024-11-20": { alias: "GPT-4o (Venice)" },
  "venice/openai-gpt-4o-mini-2024-07-18": { alias: "GPT-4o Mini (Venice)" },
  "venice/gemini-3-1-pro-preview": { alias: "Gemini 3.1 Pro (Venice)" },
  "venice/gemini-3-pro-preview": { alias: "Gemini 3 Pro (Venice)" },
  "venice/gemini-3-flash-preview": { alias: "Gemini 3 Flash (Venice)" },
  "venice/grok-41-fast": { alias: "Grok 4.1 Fast (Venice)" },
  "venice/grok-code-fast-1": { alias: "Grok Code Fast (Venice)" },

  // ── MiniMax ──
  "minimax/MiniMax-M2.1": { alias: "MiniMax M2.1" },
  "minimax/MiniMax-M2.1-lightning": { alias: "MiniMax M2.1 Lightning" },
  "minimax/MiniMax-M2.5": { alias: "MiniMax M2.5" },
  "minimax/MiniMax-M2.7": { alias: "MiniMax M2.7" },

  // ── NVIDIA ──
  "nvidia/nvidia/llama-3.1-nemotron-70b-instruct": { alias: "Nemotron 70B" },
  "nvidia/meta/llama-3.3-70b-instruct": { alias: "Llama 3.3 70B (NVIDIA)" },

  // ── OpenRouter (proxy — prefix with openrouter/) ──
  "openrouter/anthropic/claude-sonnet-4-6": { alias: "Sonnet 4.6 (OpenRouter)" },
  "openrouter/anthropic/claude-sonnet-4-5": { alias: "Sonnet 4.5 (OpenRouter)" },
  "openrouter/openai/gpt-5.4": { alias: "GPT-5.4 (OpenRouter)" },
  "openrouter/openai/gpt-4.1": { alias: "GPT-4.1 (OpenRouter)" },
  "openrouter/deepseek/deepseek-chat": { alias: "DeepSeek Chat (OpenRouter)" },
  "openrouter/google/gemini-3.1-pro-preview": { alias: "Gemini 3.1 Pro (OpenRouter)" },
  "openrouter/google/gemini-2.5-pro": { alias: "Gemini 2.5 Pro (OpenRouter)" },

  // ── OpenCode Zen ──
  "opencode/claude-opus-4-6": { alias: "Opus 4.6 (OpenCode)" },

  // ── OpenCode Go — Low-cost open coding models ──
  "opencode-go/glm-5.1": { alias: "GLM-5.1 (OpenCode Go)" },
  "opencode-go/glm-5": { alias: "GLM-5 (OpenCode Go)" },
  "opencode-go/kimi-k2.5": { alias: "Kimi K2.5 (OpenCode Go)" },
  "opencode-go/mimo-v2-pro": { alias: "MiMo V2 Pro (OpenCode Go)" },
  "opencode-go/mimo-v2-omni": { alias: "MiMo V2 Omni (OpenCode Go)" },
  "opencode-go/minimax-m2.5": { alias: "MiniMax M2.5 (OpenCode Go)" },
  "opencode-go/minimax-m2.7": { alias: "MiniMax M2.7 (OpenCode Go)" },

  // ── Hugging Face ──
  "huggingface/deepseek-ai/DeepSeek-R1": { alias: "DeepSeek R1 (HF)" },

  // ── Amazon Bedrock ──
  "amazon-bedrock/anthropic.claude-opus-4-6": { alias: "Opus 4.6 (Bedrock)" },
  "amazon-bedrock/anthropic.claude-sonnet-4-6": { alias: "Sonnet 4.6 (Bedrock)" },
};

/**
 * When a provider-specific env var is set, use this model as the default.
 * Checked in order — first match wins as primary, rest become fallbacks.
 */
export const PROVIDER_DEFAULTS = [
  { key: "ANTHROPIC_API_KEY", model: "anthropic/claude-opus-4-6" },
  { key: "OPENAI_API_KEY", model: "openai/gpt-5.4" },
  { key: "GEMINI_API_KEY", model: "google/gemini-3.1-pro-preview" },
  { key: "XAI_API_KEY", model: "xai/grok-4.20" },
  { key: "MISTRAL_API_KEY", model: "mistral/mistral-large-latest" },
  { key: "GROQ_API_KEY", model: "groq/llama-3.3-70b" },
  { key: "TOGETHER_API_KEY", model: "together/moonshotai/Kimi-K2.5" },
  { key: "ZAI_API_KEY", model: "zai/glm-5.1" },
  { key: "MOONSHOT_API_KEY", model: "moonshot/kimi-k2.5" },
  { key: "VENICE_API_KEY", model: "venice/llama-3.3-70b" },
  { key: "OPENROUTER_API_KEY", model: "openrouter/anthropic/claude-sonnet-4-6" },
  { key: "OPENCODE_API_KEY", model: "opencode-go/glm-5.1" },
];

/**
 * Fallback: map AI_PROVIDER value to default model when no provider-specific
 * env var matched (used by auto-onboard with AI_PROVIDER + AI_API_KEY).
 */
export const AI_PROVIDER_MODEL_MAP = {
  anthropic: "anthropic/claude-opus-4-6",
  openai: "openai/gpt-5.4",
  gemini: "google/gemini-3.1-pro-preview",
  google: "google/gemini-3.1-pro-preview",
  openrouter: "openrouter/anthropic/claude-sonnet-4-6",
  moonshot: "moonshot/kimi-k2.5",
  zai: "zai/glm-5.1",
  venice: "venice/llama-3.3-70b",
  mistral: "mistral/mistral-large-latest",
  minimax: "minimax/MiniMax-M2.7",
  "opencode-go": "opencode-go/glm-5.1",
};