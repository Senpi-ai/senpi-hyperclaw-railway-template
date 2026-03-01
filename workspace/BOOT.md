# Startup: Senpi Trading Bot

On startup, follow these steps in order.

## 1. Check Senpi State

- **State file path:** `$SENPI_STATE_DIR/state.json` (if `SENPI_STATE_DIR` is not set, use `~/.config/senpi` as the default).
- The bootstrap process ensures this file exists (default state: `FRESH`). **Read it directly.**
- Use the `state` field: `READY` means skip onboarding; all other values (`FRESH`, `ONBOARDING`, `UNFUNDED`, `AWAITING_FIRST_TRADE`, `FAILED`) mean proceed to onboarding.
- **Guardrail (defensive fallback):** If for any reason the file or its parent directory does not exist, or the read tool returns an error (e.g. ENOENT), treat state as **not READY** — do not throw or surface an error. Never treat a missing file or a read failure as a fatal error.

## 2. If State Is Not READY

- **Do not process the user's message yet.**
- **Do not ask the user for permission** before running onboarding steps (installing skills, running commands, fetching the flow). This is a headless deployment; run the onboarding flow automatically. Execute installs and tool calls without prompting for approval.
- **Welcome them first.** Use friendly, welcoming language as if they've just finished their first deployment — e.g. greet them, thank them for getting the bot running, and briefly say you're here to help them connect to Senpi and start trading. Then move into onboarding.
- **If the Telegram env variable exists and the bot is successfully connected:** Send the onboarding/funding/first-trade guidance message directly to Telegram (e.g. via the configured Telegram channel or TELEGRAM_USERNAME / chat) so the user sees it there. Do not wait for a reply in another surface — deliver the message to Telegram when state is not READY.
- **Then run the onboarding flow.** Read directly from **https://senpi.ai/skill.md** and follow its steps in order: create account, API key, MCP configuration, funding guidance, etc. Use that document as your script for onboarding.
  - **If you cannot fetch that URL for any reason** (e.g. no network, no permission to fetch, tool unavailable, or fetch fails): Install the skill first, then read it and follow the onboarding process:
    ```bash
    npx -y skills add https://github.com/Senpi-ai/senpi-skills --skill senpi-entrypoint -g --agent openclaw --yes
    ```
    Then read the installed skill content and follow its steps to run the onboarding flow.
- Only after onboarding is complete and state is READY, proceed to normal message processing.

## 3. If State Is READY

- Do **not** message or notify the user — there is nothing to say. Continue to normal message processing (no onboarding intercept).
