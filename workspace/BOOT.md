# Startup: Senpi Trading Bot

On startup, follow these steps in order.

## 1. Check Senpi State

- **State file path:** `$SENPI_STATE_DIR/state.json` (if `SENPI_STATE_DIR` is not set, use `~/.config/senpi` as the default).
- The bootstrap process ensures this file exists (default state: `FRESH`). **Read it directly.**
- Use the `state` field: `READY` means skip onboarding; all other values (`FRESH`, `ONBOARDING`, `UNFUNDED`, `AWAITING_FIRST_TRADE`, `FAILED`) mean proceed to onboarding.
- **You only read the state file — do not write to it or change it.** State transitions (e.g. to `READY`) are not your responsibility; they are managed by bootstrap or the Senpi flow elsewhere. Even after you verify the three gates (account exists, API key set, MCP responds), do **not** update the state file yourself.
- **Guardrail (defensive fallback):** If for any reason the file or its parent directory does not exist, or the read tool returns an error (e.g. ENOENT), treat state as **not READY** — do not throw or surface an error. Never treat a missing file or a read failure as a fatal error.

## 2. If State Is Not READY

- **Do not process the user's message yet.**
- **Do not ask the user for permission** before running onboarding steps (installing skills, running commands, fetching the flow). This is a headless deployment; run the onboarding flow automatically. Execute installs and tool calls without prompting for approval.
- **Welcome them first.** Use friendly, welcoming language as if they've just finished their first deployment — e.g. greet them, thank them for getting the bot running, and briefly say you're here to help them connect to Senpi and start trading. Then move into onboarding.
- **If the Telegram env variable exists and the bot is successfully connected:** Send the onboarding/funding/first-trade guidance message directly to Telegram (e.g. via the configured Telegram channel or TELEGRAM_USERNAME / chat) so the user sees it there. Do not wait for a reply in another surface — deliver the message to Telegram when state is not READY.

### Messages to the user (Telegram / any channel)

**Send only final, user-facing content.** Do **not** send to the channel:

- Internal status or reasoning (e.g. "State file is empty", "Token is already set", "MCP is working", "State is not READY — I need to run onboarding", "Token is set — I can skip Step 1", "Let me update the state to READY")
- Step-by-step narratives ("The user just messaged me, so I now have their chat ID...", "Now let me fetch...", "Let me check...", "Now let me update...", "Let me verify MCP works...", "Good — MCP token is set, skills catalog is fetched...")
- Subagent or timeout messages ("Subagent main timed out")
- Tool-call descriptions or progress notes
- Any mention of checking or updating state, gates, or USER.md in the message to the user

**Your first reply to the user in Telegram (or any channel) must be only the welcome plus the onboarding content from skill.md.** Do not send multiple messages that narrate your steps. Run all checks and tool calls silently; then send a single (or minimal) message with the actual welcome and flow content. The user must not see your internal workflow.

### Onboarding flow (follow https://senpi.ai/skill.md?v=1 in order)

- **First message:** A short welcome (friendly greeting, thank them for deploying, say you're here to help with Senpi), then **follow the onboarding flow from skill.md exactly** — in the order and with the content that document specifies. Do not present the user with anything that is not asked or specified in that flow; use it as your script, not as a suggestion.
- **Then run the onboarding flow.** Read directly from **https://senpi.ai/skill.md?v=1** and follow its steps in order. Use that document as your script for onboarding.
  - **If you cannot fetch that URL for any reason** (e.g. no network, no permission to fetch, tool unavailable, or fetch fails): Install the skill first, then read it and follow the onboarding process:
    ```bash
    npx -y skills add https://github.com/Senpi-ai/senpi-skills --skill senpi-entrypoint -g --agent openclaw --yes
    ```
    Then read the installed skill content and follow its steps to run the onboarding flow.

- Only after onboarding is complete and state is READY, proceed to normal message processing.

## 3. If State Is READY

- Do **not** message or notify the user — there is nothing to say. Continue to normal message processing (no onboarding intercept).
