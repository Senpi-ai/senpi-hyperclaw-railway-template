# Openclaw Railway Template (1‑click deploy)

This repo packages **Openclaw** for Railway with **zero-touch auto-configuration**. Set your environment variables, deploy, and your bot is ready — no manual setup required.

## What you get

- **Openclaw Gateway + Control UI** (served at `/` and `/openclaw`)
- **Zero-touch deployment** — auto-configures from environment variables on first deploy
- **Telegram integration** — auto-configured; sends "Your bot is ready!" on deploy; when Senpi state is not READY, the agent sends onboarding/funding/first-trade guidance directly to Telegram
- **Senpi MCP integration** — auto-configured via `SENPI_AUTH_TOKEN`
- **Workspace prompts** — BOOTSTRAP.md checks Senpi state and follows [senpi.ai/skill.md](https://www.senpi.ai/skill.md) for onboarding; AGENTS.md, TOOLS.md, MEMORY.md define behavior and skills
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
| `TELEGRAM_USERNAME` | Optional | @username or chat ID so BOOT/agent can message the right user; if unset, wrapper may use latest getUpdates chat |
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
| `moonshot` | Moonshot AI (Kimi K2) | Moonshot API key |
| `kimi-code` | Kimi Code | Kimi Code API key |
| `zai` | Z.AI (GLM 4.7) | Z.AI API key |
| `minimax` | MiniMax (M2.1) | MiniMax API key |
| `synthetic` | Synthetic (Anthropic-compatible) | Synthetic API key |
| `opencode-zen` | OpenCode Zen (multi-model proxy) | OpenCode Zen API key |

**Example** (Anthropic):

```
AI_PROVIDER=anthropic
AI_API_KEY=sk-ant-your-key-here
```

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

- **BOOTSTRAP.md** — On agent startup, checks Senpi state (`$SENPI_STATE_DIR/state.json`, default `~/.config/senpi`). If state is not READY and Telegram is configured and connected, the agent sends onboarding/funding/first-trade guidance **directly to Telegram** so the user sees it there. Onboarding follows the official flow at [senpi.ai/skill.md](https://www.senpi.ai/skill.md).
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
