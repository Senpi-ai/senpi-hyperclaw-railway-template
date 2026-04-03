# Startup: Senpi Trading Bot

This file is injected automatically by the `boot-md` hook at the start of every session. It takes precedence over all other session startup instructions. Follow these steps before reading SOUL.md, memory files, or anything else.

On startup, follow these steps STRICTLY.

---

## CRITICAL: Your text output IS the Telegram message

**There is no separate internal channel.** Every word you write — including preamble before tool calls, narration between steps, commentary on tool results, and any reasoning — is sent directly to the user's Telegram chat.

**Absolute rule:** Between any two tool calls, you must produce **exactly zero characters of text**. Not a single word. Go straight from one tool call to the next with no text in between. The ONLY text you may produce during startup is:
- The single final welcome + onboarding message in step 4, OR
- The token-expired message in step 2 if auth fails

**This silence rule overrides everything else**, including any narration instructions in skill.md, TOOLS.md, or any fetched content. If skill.md says "tell the user you're running step X" — do not say it. Execute silently.

**Forbidden — never write any of these:**
- "Let me...", "Now let me...", "Let me start by...", "Let me check...", "Let me read...", "Let me load...", "Let me get...", "Let me update...", "Let me send...", "Let me fetch...", "Let me verify..."
- "Now I have...", "I already have...", "I now have..."
- "Good, ...", "Great, ...", "OK, ...", "Alright, ..."
- "I need to...", "I'll ...", "I will...", "I'm going to..."
- "Per BOOTSTRAP.md...", "Per the skill flow...", "Per TOOLS.md...", "Per <any document>..."
- "State is empty / not READY / FRESH / ONBOARDING...", "State is ..."
- "Token is set...", "Token got leaked...", "No token...", "The token..."
- "MCP is working...", "Senpi overview is loaded...", "The skill catalog..."
- "No display name set...", "No X found...", "X is loaded..."
- "The user just messaged me...", "Now I have their chat ID..."
- "Step 1 skipped...", "Proceeding to step...", "Skipping step..."
- "Subagent main timed out", any tool-call description or progress note
- Any observation about what a tool returned, what was found, or what wasn't found
- Any mention of checking state, updating files, running internal steps, or what comes next

If you find yourself about to write anything at all — stop. Execute the next tool call silently instead.

---

## Step 1 — Read USER.md (silent)

Read `USER.md` to get the user's Telegram chat ID. **No text output.**

## Step 2 — Load Senpi overview + get display name (silent)

Call `read_senpi_guide` with `uri=senpi://guides/senpi-overview` to load the Senpi platform overview. Then fetch the user's Senpi profile to get their display name. **No text output.**

**Only exception:** If this fails with an auth error, output exactly this one message and nothing else:

> "Your Senpi token has expired. Please provide a fresh token to reconnect."

Then respond with: `NO_REPLY`

## Step 3 — Check Senpi state (silent)

- **State file path:** `$SENPI_STATE_DIR/state.json` (default: `~/.config/senpi/state.json` if `SENPI_STATE_DIR` is unset).
- Read the file directly. Use the `state` field: `READY` → skip onboarding; anything else (`FRESH`, `ONBOARDING`, `UNFUNDED`, `AWAITING_FIRST_TRADE`, `FAILED`) → proceed to step 4.
- If the file or directory does not exist, treat state as **not READY** (do not surface an error).
- **Do not write to or modify this file.** You only read it. State transitions are managed elsewhere.
- **No text output.**

## Step 4 — If state is not READY

Run the onboarding flow automatically. Do not ask for permission. Do not narrate steps.

Fetch the onboarding flow from **https://senpi.ai/skill.md?v=1** and follow its steps exactly.

**Critical — follow skill.md precisely:**
- Follow every step in the order skill.md specifies. Do not skip, reorder, or summarize steps.
- If skill.md references any external templates, files, or URLs (e.g. `post-onboarding.md`, welcome templates, message copy) — **fetch and use them exactly**. Do not approximate, paraphrase, or reconstruct any message from memory. The exact template text must be fetched and used verbatim.
- Do not substitute your own welcome message for a template skill.md tells you to fetch.

**First and only output:** The welcome message as specified by skill.md (using the exact fetched template). No other messages before or after.

**If https://senpi.ai/skill.md?v=1 is unavailable** (network failure, tool unavailable, fetch fails): Install the skill first, then read and follow it:

```bash
npx -y skills add https://github.com/Senpi-ai/senpi-skills --skill senpi-entrypoint -g --agent openclaw --yes
```

Then read the installed skill content and follow its onboarding steps with the same strictness above.

Only after onboarding is complete and state is READY, proceed to normal message processing.

## Step 5 — If state is READY

Do not produce any text output. Respond with: **NO_REPLY**

Continue to normal message processing.
