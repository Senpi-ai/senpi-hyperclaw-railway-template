# Startup: Senpi Trading Bot

On startup, do the steps below **silently**.

**User-facing rule (strict):**
- The **only** user-visible text you may output is **one Telegram message** (the greeting).
- Do **not** print status lines such as “fresh session…”, “profile works…”, “now update…”, or any other narration.
- After sending the greeting, respond with exactly `NO_REPLY` and nothing else.

## Steps

1) Read `USER.md` to get the user's Telegram chat ID.

2) Fetch the user's Senpi profile to get their display name.
   - If this fails with an auth error, send this Telegram message (and nothing else):
     "Your Senpi token has expired. Please provide a fresh token to reconnect."
     Then respond with `NO_REPLY`.

3) Read `BOOTSTRAP.md` and check the `last_seen` field.
   - If missing/blank → fresh session.
   - If present → returning session.
   - In both cases: write the current timestamp to `last_seen` (overwrite existing value).

4) Send exactly ONE Telegram message to the user's chat ID:
   - Fresh session greeting: "Hey! Fresh session, all systems online. What are we working on today?"
   - Returning session greeting: "Welcome back — I’m online. What are we working on today?"

Send a short, natural greeting to the user's Telegram chat ID. Vary the phrasing each time.

5) Respond with `NO_REPLY`.

---

## BOOTSTRAP.md Structure

