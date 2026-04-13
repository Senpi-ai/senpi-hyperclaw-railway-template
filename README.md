# Openclaw Railway Template (1‑click deploy)

This repo packages **Openclaw** for Railway with **zero-touch auto-configuration**. Set your environment variables, deploy, and your bot is ready — no manual setup required.

## What you get

- **Openclaw Gateway + Control UI** (served at `/` and `/openclaw`)
- **Zero-touch deployment** — auto-configures from environment variables on first deploy
- **Telegram integration** — auto-configured; sends "Your bot is ready!" on deploy; when Senpi state is not READY, the agent sends onboarding/funding/first-trade guidance directly to Telegram
- **Senpi MCP integration** — auto-configured via `SENPI_AUTH_TOKEN`
- **Workspace prompts** — **BOOTSTRAP.md** defines startup: read USER.md (chat ID), fetch Senpi profile (on auth error send "token expired" to Telegram and NO_REPLY), check Senpi state; if not READY the agent sends onboarding/funding/first-trade guidance to Telegram; if READY the agent responds NO_REPLY and continues. AGENTS.md, TOOLS.md, MEMORY.md define behavior and skills.
- Persistent state via **Railway Volume** (config, credentials, memory survive redeploys)
- One-click **Export backup** (migrate off Railway later)
- Fallback **Setup Wizard** at `/setup` for manual configuration
- **Security:** See [SECURITY.md](SECURITY.md) for an audit against [OpenClaw’s security guidance](https://docs.openclaw.ai/gateway/security).

## How it works

1. On first deploy, the wrapper detects `AI_PROVIDER` + `AI_API_KEY` environment variables
2. Runs `openclaw onboard` automatically with the correct provider configuration
3. Configures Telegram channel from `TELEGRAM_BOT_TOKEN`
4. Injects `SENPI_AUTH_TOKEN` into the MCP integration config
5. Starts the gateway and sends a "Your bot is ready!" message to Telegram
6. All subsequent traffic is reverse-proxied to the gateway (including WebSockets)

## Quick start (Railway)

1. Create a new template from this GitHub repo
2. Add a **Volume** mounted at `/data`
3. Set these environment variables:

| Variable | Required | Description |
|---|---|---|
| `AI_PROVIDER` | Yes | AI backend to use (see table below) |
| `AI_API_KEY` | Yes | API key for the chosen provider |
| `TELEGRAM_BOT_TOKEN` | Yes | Telegram bot token from @BotFather |
| `SENPI_AUTH_TOKEN` | Yes | Senpi authentication token for MCP |
| `OPENCLAW_STATE_DIR` | Recommended | Set to `/data/.openclaw` for persistence |
| `OPENCLAW_WORKSPACE_DIR` | Recommended | Set to `/data/workspace` for persistence |
| `TELEGRAM_USERNAME` | Optional | @username or chat ID so the agent can message the right user; if unset, wrapper may use latest getUpdates chat |
| `OPENCLAW_GATEWAY_TOKEN` | Optional | Stable gateway auth token (auto-generated if unset) |
| `SETUP_PASSWORD` | Recommended | Password for `/setup` and Control UI (/, /openclaw). If unset, those routes are disabled and a startup warning is logged. |

4. Enable **Public Networking** (HTTP) — Railway assigns a domain
5. Deploy — everything auto-configures

### AI Provider options

Set `AI_PROVIDER` to one of the following values, and put the corresponding API key in `AI_API_KEY`:

| `AI_PROVIDER` | Provider | `AI_API_KEY` format |
|---|---|---|
| `anthropic` | Anthropic (Claude) | `sk-ant-...` |
| `openai` | OpenAI | `sk-...` |
| `openrouter` | OpenRouter | OpenRouter API key |
| `gemini` | Google Gemini | Gemini API key |
| `google` | Google Gemini (alias) | Gemini API key |
| `ai-gateway` | Vercel AI Gateway | AI Gateway API key |
| `moonshot` | Moonshot AI (Kimi K2.5) | Moonshot API key |
| `kimi-code` | Kimi Code | Kimi Code API key |
| `zai` | Z.AI (GLM-5.1) | Z.AI API key |
| `minimax` | MiniMax (M2.7) | MiniMax API key |
| `synthetic` | Synthetic (Anthropic-compatible) | Synthetic API key |
| `opencode-zen` | OpenCode Zen (multi-model proxy) | OpenCode API key |
| `opencode-go` | OpenCode Go (low-cost open models) | OpenCode API key (same as Zen) |

**Example** (Anthropic):

```
AI_PROVIDER=anthropic
AI_API_KEY=sk-ant-your-key-here
```

**Example** (OpenCode Go — low-cost open models):

```
AI_PROVIDER=opencode-go
AI_API_KEY=sk-your-opencode-key
```

OpenCode Go gives access to curated open coding models (GLM-5.1, GLM-5, Kimi K2.5, MiMo V2, MiniMax M2.5/M2.7) for $5/first month then $10/month. It uses the same API key as OpenCode Zen. The template auto-injects a custom provider block so `opencode-go/*` model refs resolve correctly.

### Provider-specific environment variables

Instead of `AI_PROVIDER` + `AI_API_KEY`, you can set provider-specific env vars directly. When multiple keys are present, the first match in priority order becomes the primary model and the rest become fallbacks:

| Env var | Default model |
|---|---|
| `ANTHROPIC_API_KEY` | `anthropic/claude-opus-4-6` |
| `OPENAI_API_KEY` | `openai/gpt-5.4` |
| `GEMINI_API_KEY` | `google/gemini-3.1-pro-preview` |
| `XAI_API_KEY` | `xai/grok-4.20` |
| `MISTRAL_API_KEY` | `mistral/mistral-large-latest` |
| `GROQ_API_KEY` | `groq/llama-3.3-70b` |
| `TOGETHER_API_KEY` | `together/moonshotai/Kimi-K2.5` |
| `ZAI_API_KEY` | `zai/glm-5.1` |
| `MOONSHOT_API_KEY` | `moonshot/kimi-k2.5` |
| `VENICE_API_KEY` | `venice/llama-3.3-70b` |
| `OPENROUTER_API_KEY` | `openrouter/anthropic/claude-sonnet-4-6` |
| `OPENCODE_API_KEY` | `opencode-go/glm-5.1` |

### Allowed models

The full model allowlist lives in `src/lib/models.js`. Users can `/model switch` to any model in the list. Key providers and their latest models:

- **Anthropic:** Claude Opus 4.6, Sonnet 4.6, Sonnet 4.5, Opus 4.5, Haiku 4.5
- **OpenAI:** GPT-5.4, GPT-5.4 Mini/Nano, GPT-5.2, GPT-5.1 Codex, GPT-4.1, o3/o4-mini
- **Google Gemini:** Gemini 3.1 Pro, 3 Flash, 3.1 Flash Lite, 2.5 Pro/Flash + specialized variants
- **xAI:** Grok 4.20, Grok 4, Grok 4.1 Fast, Grok 3/3 Mini
- **Z.AI:** GLM-5.1, GLM-5, GLM-4.7, GLM-4.6
- **OpenCode Go:** GLM-5.1, GLM-5, Kimi K2.5, MiMo V2 Pro/Omni, MiniMax M2.5/M2.7
- **Venice AI:** 30+ models including private open-source and anonymized proxied models
- **Others:** Moonshot (Kimi K2.5), MiniMax (M2.1–M2.7), Mistral, Groq, Together, OpenRouter, Bedrock

## Getting a Telegram bot token

1. Open Telegram and message **@BotFather**
2. Run `/newbot` and follow the prompts
3. BotFather gives you a token like: `123456789:AA...`
4. (Optional) Send `/start` to your new bot before deploying — the template will send a "Your bot is ready!" confirmation once deployment completes

## Manual setup (fallback)

If you prefer manual configuration or don't set `AI_PROVIDER`/`AI_API_KEY`, the setup wizard is still available:

1. Set `SETUP_PASSWORD` in Railway Variables (if unset, `/setup` and the Control UI are disabled and a startup warning is logged)
2. Visit `https://<your-app>.up.railway.app/setup`
3. Complete the wizard to choose your AI provider, enter API keys, and configure channels

## Senpi user onboarding & first trade

The workspace is preloaded with prompts that guide **end users** (people chatting with your bot) through Senpi onboarding and their first trade:

- **BOOTSTRAP.md** — On agent startup: (1) read USER.md for Telegram chat ID, (2) fetch Senpi profile for display name (if auth fails, send "Your Senpi token has expired…" to Telegram and NO_REPLY), (3) check Senpi state from `$SENPI_STATE_DIR/state.json` (default `~/.config/senpi`). If state is **not READY**, the agent welcomes the user and sends onboarding/funding/first-trade guidance **directly to Telegram**; if state is **READY**, the agent responds NO_REPLY and continues. Onboarding follows [senpi.ai/skill.md](https://www.senpi.ai/skill.md).
- **State-driven flow** — States: FRESH → ONBOARDING → UNFUNDED → AWAITING_FIRST_TRADE → READY.
- **First trade guide** — When the user is ready, the agent walks them through discovery, opening a small position ($50, 3x), and closing, then suggests skills (DSL, WOLF, Whale Index, etc.).
- **Skills** — Users can list and install skills via `npx skills add Senpi-ai/senpi-skills --list` and `npx skills add Senpi-ai/senpi-skills --skill <skill-name> -a openclaw`.

See [ONBOARDING_GUIDE.md](ONBOARDING_GUIDE.md) and [docs/ONBOARDING_ARCHITECTURE.md](docs/ONBOARDING_ARCHITECTURE.md) for the full design.

## Local smoke test

```bash
docker build -t openclaw-railway-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e AI_PROVIDER=anthropic \
  -e AI_API_KEY=sk-ant-your-key \
  -e TELEGRAM_BOT_TOKEN=123456789:AA... \
  -e SENPI_AUTH_TOKEN=your-senpi-token \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template

# Bot auto-configures on startup — check logs for progress
```

For manual setup mode:

```bash
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template

# open http://localhost:8080/setup (password: test)
```