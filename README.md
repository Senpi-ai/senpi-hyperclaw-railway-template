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

## External agent-bridge integration

The template exposes an OpenClaw gateway endpoint that an external
[`agent-bridge`](https://github.com/Senpi-ai/agent-bridge) (Go rewrite,
branch `v3/go-rewrite`) can dial to perform the v3 device-pair
handshake.

**1. Fetch the three credentials.** With `SETUP_PASSWORD` set, GET
`/setup/api/agent-bridge-creds` over Basic auth:

```bash
curl -u "admin:$SETUP_PASSWORD" \
  https://<your-deploy>.up.railway.app/setup/api/agent-bridge-creds
# {
#   "gatewayUrl": "wss://<your-deploy>.up.railway.app/openclaw/ws",
#   "bootstrapToken": "...",
#   "agentId": "<project-name>-<service-name>"
# }
```

Each read is audit-logged (`[agent-bridge-creds] CREDENTIALS READ …`).

**2. Plug into the bridge's `.env`:**

```
OPENCLAW_GATEWAY_URL=<gatewayUrl>
OPENCLAW_BOOTSTRAP_TOKEN=<bootstrapToken>
OPENCLAW_AGENT_ID=<agentId>
```

**3. The wrapper auto-approves the bridge's pairing request.** When the
bridge connects, OpenClaw places it in `pendingRequests` after verifying
the bootstrap token. The wrapper's approval loop (`src/lib/deviceAuth.js`)
matches the request against the agent-bridge allowlist and approves it
via the local Node-import path, so the bridge gets a `hello-ok` with a
persistent `deviceToken` on the first or second reconnect attempt.

**Allowlist defaults** (override via env vars):

| Env var                          | Default                                 |
|----------------------------------|------------------------------------------|
| `AGENT_BRIDGE_WS_PATH`           | `/openclaw/ws`                          |
| `AGENT_BRIDGE_CLIENT_IDS`        | `webchat-ui,senpi-mobile,senpi-web`     |
| `AGENT_BRIDGE_CLIENT_MODES`      | `webchat`                               |
| `AGENT_BRIDGE_SCOPES_ALLOWLIST`  | `chat`                                  |
| `DEVICE_AUTH_STEADY_INTERVAL_MS` | `10000` (poll cadence outside burst)    |

`client.id` is attacker-controlled metadata, not a security boundary —
the bootstrap token (verified upstream by OpenClaw) is the real gate.
The allowlist exists to narrow auto-approval to the user-chat path so
operator-scope upgrades still need a human. See `CLAUDE.md` Quirk #14.

### Optional: re-enable `dangerouslyDisableDeviceAuth`

As of 2026-05-16 the wrapper **no longer writes**
`gateway.controlUi.dangerouslyDisableDeviceAuth` by default. The flag
never engaged for internal clients or the agent-bridge (different code
paths); its only real effect was admitting a remote Control UI browser
without device pairing.

If you still want browser-based Control UI access without pairing
(debugging convenience), opt back in:

```
OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH=true
```

Otherwise debug from inside the container:

```sh
railway ssh
openclaw sessions ls
openclaw devices list --json
```
