# Startup: Senpi Trading Bot

On startup, follow these steps STRICTLY.

---

## CRITICAL: Your text output IS the Telegram message

**There is no separate internal channel.** Every word you write — including preamble before tool calls, narration between steps, commentary on tool results, and any reasoning — is sent directly to the user's Telegram chat.

**Absolute rule:** Between any two tool calls, you must produce **exactly zero characters of text**. Not a single word. Go straight from one tool call to the next with no text in between. The ONLY text you may produce during startup is:
- The welcome message at the start of step 4, OR
- The individual skill.md step messages in step 4 (each sent separately, with pauses for user responses where required), OR
- The token-expired / credential-request messages in step 2 if auth fails

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
- **Never ask the user for credentials unprompted or prematurely.** Only request a token as a last resort (step 2 fallback), and only after exhausting all automatic recovery options. Always explain why you need it when you do ask.

If you find yourself about to write anything at all — stop. Execute the next tool call silently instead.

---

## Step 1 — Resolve Telegram chat ID (silent)

Read `USER.md` to get the user's Telegram chat ID. **No text output.**

If `USER.md` does not exist or contains no chat ID:
- The chat ID is available from the current session context — the message that triggered this startup was sent from Telegram and carries the sender's numeric chat ID (e.g. the session target is `telegram:<chat_id>`). Extract it from there.
- Write it to `USER.md` immediately so future sessions can read it directly.
- **Never ask the user for their chat ID.** It is always knowable from the incoming message.

## Step 2 — Get display name from Senpi profile (silent)

Call the `senpi` MCP server to fetch the user's profile and get their display name. **No text output.**

The `senpi` MCP server is pre-configured by the deployment — do not attempt to set it up manually or ask the user for credentials. Just call the tool.

**Possible outcomes:**

- **Tool call succeeds** → proceed to step 3 with the display name.
- **Tool is unavailable / server not connected** (e.g. tool not found, server error, connection refused) → attempt the fallback reconnect below before giving up.
- **Tool returns an explicit authentication/authorization error** (HTTP 401, 403, "token expired", "invalid token") → output exactly this one message and nothing else:

> "Your Senpi token has expired. Please provide a fresh token to reconnect."

Then respond with: `NO_REPLY`

**Fallback reconnect (if MCP not connected):**

Run this shell command to read the stored token from mcporter.json:

```bash
node -e "
const fs = require('fs');
const p = process.env.MCPORTER_CONFIG || (process.env.OPENCLAW_STATE_DIR || '/data/.openclaw') + '/config/mcporter.json';
try {
  const c = JSON.parse(fs.readFileSync(p,'utf8'));
  console.log(c.mcpServers?.senpi?.env?.SENPI_AUTH_TOKEN || '');
} catch { console.log(''); }
"
```

- **If the output is a non-empty string** → POST it to the reconnect endpoint (no text output):

```bash
curl -s -X POST http://127.0.0.1:8080/setup/api/senpi-token \
  -H "Content-Type: application/json" \
  -d "{\"token\": \"<token from above>\"}"
```

Then retry the `senpi` MCP profile call. If it now succeeds → proceed to step 3. If it still fails for any reason → as a last resort, send exactly one message explaining why, then stop:

> "The Senpi token stored in this deployment is no longer valid. Please provide a fresh API key to reconnect."

Then respond with: `NO_REPLY`. **Do not proceed to step 3.** A working Senpi connection is required to continue.

- **If the output is empty** → `SENPI_AUTH_TOKEN` was never configured. As a last resort, send the user exactly one message explaining why you need it, then stop:

> "I couldn't find a Senpi auth token in this deployment's configuration. Please provide your Senpi API key so I can connect to your account."

Then respond with: `NO_REPLY`

## Step 3 — Check Senpi state (silent)

**State file path:** `$SENPI_STATE_DIR/state.json` (default: `~/.config/senpi/state.json` if `SENPI_STATE_DIR` is unset).

Read the file and check the `state` field:

- **`state` is `"READY"`** → skip to step 5 (no onboarding needed).
- **`state` is an explicit non-READY value** (`"FRESH"`, `"ONBOARDING"`, `"UNFUNDED"`, `"AWAITING_FIRST_TRADE"`, `"FAILED"`) → proceed to step 4.
- **`state` is missing, null, or the file is `{}`** → the local cache is empty (e.g. fresh deploy or volume reset); this does NOT mean the user is not onboarded. **Fall back to the MCP as the source of truth:**
  - Call the `senpi` MCP to query the user's actual account state (e.g. fetch profile or account status).
  - If the MCP confirms the account is active / funded / ready → treat as READY, skip to step 5.
  - If the MCP returns a state that indicates the user still needs onboarding → proceed to step 4.
  - If the MCP call fails → treat as not READY and proceed to step 4.

**Do not write to or modify `state.json`.** You only read it. State transitions are managed by Senpi skills. **No text output.**

## Step 4 — If state is not READY

Fetch the onboarding flow from **https://senpi.ai/skill.md?v=1** and follow its steps in order.

**If that URL is unavailable** (network failure, tool unavailable, fetch fails): Install the skill first, then read and follow it:

```bash
npx -y skills add https://github.com/Senpi-ai/senpi-skills --skill senpi-entrypoint -g --agent openclaw --yes
```

**How to follow skill.md:**

- Your **first output** is a friendly welcome message (greet the user, thank them for deploying, say you're here to help them start trading on Senpi). Send this before running any skill.md steps.
- Then follow each skill.md step **one at a time**, in order.
- **Do NOT compress multiple steps into a single message.** Each step is separate.
- **Any skill.md step that requires user input (e.g. "Would you like me to walk you through your first trade?") MUST be sent as its own message and MUST wait for the user's response before continuing.** Do not skip or bundle these prompts.
- Only after all skill.md steps are complete and state is READY, proceed to normal message processing.

## Step 5 — If state is READY

Do not produce any text output. Respond with: **NO_REPLY**

Continue to normal message processing.
