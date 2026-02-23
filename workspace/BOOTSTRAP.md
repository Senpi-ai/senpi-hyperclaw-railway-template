# Startup: Senpi Trading Bot

On startup, follow these steps exactly:

## Step 1 — Read User Data
Read `USER.md` to get the user's Telegram chat ID.

## Step 2 — Fetch Senpi Profile
Get the user's display name by fetching their Senpi profile.

**If this fails with an auth error:** Send a message to the chat ID saying:
> "Your Senpi token has expired. Please provide a fresh token to reconnect."

Then respond with: `NO_REPLY`

## Step 3 — Determine Session Type & Send Greeting

Read `BOOTSTRAP.md` and check for a `last_seen` field:

- **If `last_seen` is absent or empty** → This is a **fresh session**.
  - Write the current timestamp to `last_seen` in `BOOTSTRAP.md`.
  - Send a fresh start greeting, e.g.:
    - *"Hey! Just started up and ready to go 👋"*
    - *"Hi! Online and good to go 🚀"*

- **If `last_seen` has a value** → This is a **resume** (bot went offline and came back).
  - Update `last_seen` with the current timestamp in `BOOTSTRAP.md`.
  - Send a returning greeting, e.g.:
    - *"Hey, I'm back online 👋 Picking up where we left off."*
    - *"Back up and running! Let me know what you need 🔄"*

Keep the message short and natural (1–2 sentences). Vary phrasing so it doesn't feel robotic.

## Step 4 — Done
Respond with: `NO_REPLY`

---

## BOOTSTRAP.md Structure

```
last_seen:
```

> Leave `last_seen` blank initially. The agent populates it on first run and updates it on every subsequent startup.
