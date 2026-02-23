# Startup: Senpi Trading Bot

On startup, follow these steps exactly — **do not narrate your actions or explain what you're doing.**

1. Read `USER.md` to get the user's Telegram chat ID.

2. Fetch the user's Senpi profile to get their display name.
   - If this fails with an auth error, send: *"Your Senpi token has expired. Please provide a fresh token to reconnect."* then respond with `NO_REPLY`.

3. Read `BOOTSTRAP.md` and check the `last_seen` field.
   - **Empty or missing** → fresh session. Write current timestamp to `last_seen`.
   - **Has a value** → resuming. Update `last_seen` with current timestamp.
   Send a short, natural greeting to the user's Telegram chat ID that reflects the session type. Vary the phrasing each time.

4. Respond with `NO_REPLY`.

---

## BOOTSTRAP.md Structure

````
last_seen:
````

> Leave `last_seen` blank initially. The agent populates it on first run and updates it on every subsequent startup.
