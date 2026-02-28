# Startup: Senpi Trading Bot

On startup, follow these steps in order.

## 1. Check Senpi State

- **State file path:** `~/.config/senpi/state.json`
- The bootstrap process ensures this file exists (default state: `FRESH`). **Read it directly.**
- Use the `state` field: `READY` means skip onboarding; all other values (`FRESH`, `ONBOARDING`, `UNFUNDED`, `AWAITING_FIRST_TRADE`, `FAILED`) mean proceed to onboarding.
- **Guardrail (defensive fallback):** If for any reason the file or its parent directory does not exist, or the read tool returns an error (e.g. ENOENT), treat state as **not READY** — do not throw or surface an error. Never treat a missing file or a read failure as a fatal error.

## 2. If State Is Not READY

- **Do not process the user's message yet.**
- **Welcome them first.** Use friendly, welcoming language as if they've just finished their first deployment — e.g. greet them, thank them for getting the bot running, and briefly say you're here to help them connect to Senpi and start trading. Then move into onboarding.
- **If the Telegram env variable exists and the bot is successfully connected:** Send the onboarding/funding/first-trade guidance message directly to Telegram (e.g. via the configured Telegram channel or TELEGRAM_USERNAME / chat) so the user sees it there. Do not wait for a reply in another surface — deliver the message to Telegram when state is not READY.
- **Then run the onboarding flow.** Read the file **`SENPI_ONBOARDING.md`** in your workspace (it is populated at startup from https://senpi.ai/skill.md). Follow its steps in order: create account, API key, MCP configuration, funding guidance, etc. Do not skip reading this file — it is your script for onboarding.
- Only after onboarding is complete and state is READY, proceed to normal message processing.

## 3. If State Is READY

- Do **not** message or notify the user about onboarding — there is nothing to say. Then do the following and continue to normal message processing:

1) Read `USER.md` to get the user's Telegram chat ID.

2) Get the user's display name by fetching their Senpi profile.

   **If this fails with an auth error:** Send a message to the chat ID saying:
   "Your Senpi token has expired. Please provide a fresh token to reconnect."
   Then respond with: NO_REPLY

3) Respond with: NO_REPLY
