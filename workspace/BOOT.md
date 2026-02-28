# Bootstrap

## Startup Sequence

On agent startup, do the following in order.

### 1. Check Senpi State

- **State file path:** `~/.config/senpi/state.json`
- **Guardrails — the file or directory often does not exist** (e.g. first run, new user). That is normal.
  - **Do not throw or surface an error if the file doesn't exist.** Missing file = not READY; continue to onboarding. Never treat a missing file as a failure.
  - **Do not read the file unconditionally.** First check whether the file exists (e.g. list the parent directory or check existence). If the file or its parent directory does not exist, treat state as **not READY** and skip any read; do not attempt to read the path, or you may trigger ENOENT errors.
  - Only if the file exists, read it and use the `state` field (e.g. `READY`, `ONBOARDING`, `UNFUNDED`, `AWAITING_FIRST_TRADE`, `FAILED`).
  - If the file does not exist → treat state as not READY (proceed to onboarding).

### 2. If State Is Not READY

- **Do not process the user's message yet.**
- **Welcome them first.** Use friendly, welcoming language as if they've just finished their first deployment — e.g. greet them, thank them for getting the bot running, and briefly say you're here to help them connect to Senpi and start trading. Then move into onboarding.
- **If the Telegram env variable exists and the bot is successfully connected:** Send the onboarding/funding/first-trade guidance message directly to Telegram (e.g. via the configured Telegram channel or TELEGRAM_USERNAME / chat) so the user sees it there. Do not wait for a reply in another surface — deliver the message to Telegram when state is not READY.
- Fetch and follow the official Senpi onboarding flow:
  - **URL:** https://senpi.ai/skill.md
- Read that skill document and complete the Senpi onboarding for the user (create account, API key, MCP configuration, funding guidance, etc.) as described there.
- Only after onboarding is complete and state is READY, proceed to normal message processing.

### 3. If State Is READY

- Do **not** message or notify the user — there is nothing to say. Continue to normal message processing (no onboarding intercept).
