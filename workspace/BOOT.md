# Bootstrap

## Startup Sequence

On agent startup, do the following in order.

### 1. Check Senpi State

- **State file:** `$SENPI_STATE_DIR/state.json` (SENPI_STATE_DIR defaults to `$HOME/.senpi`).
- If the file does not exist → treat state as not READY.
- If the file exists → read the `state` field (e.g. `READY`, `ONBOARDING`, `UNFUNDED`, `AWAITING_FIRST_TRADE`, `FAILED`).

### 2. If State Is Not READY

- **Do not process the user's message yet.**
- **If the Telegram env variable exists and the bot is successfully connected:** Send the onboarding/funding/first-trade guidance message directly to Telegram (e.g. via the configured Telegram channel or TELEGRAM_USERNAME / chat) so the user sees it there. Do not wait for a reply in another surface — deliver the message to Telegram when state is not READY.
- Fetch and follow the official Senpi onboarding flow:
  - **URL:** https://www.senpi.ai/skill.md
- Read that skill document and complete the Senpi onboarding for the user (create account, API key, MCP configuration, funding guidance, etc.) as described there.
- Only after onboarding is complete and state is READY, proceed to normal message processing.

### 3. If State Is READY

- Do **not** message or notify the user — there is nothing to say. Continue to normal message processing (no onboarding intercept).
