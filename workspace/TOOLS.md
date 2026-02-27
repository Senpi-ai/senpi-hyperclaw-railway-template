# TOOLS.md — Local Notes

This is your cheat sheet. Environment-specific stuff that doesn't belong in skills.

## Senpi MCP

- **Server name:** `senpi`
- **Auth:** JWT token (configured at setup)
- **Connection:** Pre-configured via OpenClaw, no manual setup needed
- The MCP server provides its own instructions and tool descriptions — read them at runtime
- **On every session startup:** Always call `read_senpi_guide` with `uri=senpi://guides/senpi-overview` to load the Senpi platform overview before doing anything else with Senpi tools

## Telegram

- **Numeric chat IDs only** — `@username` does NOT work
- Target format: `telegram:<chat_id>` (e.g. `telegram:123456789`)
- Check `USER.md` for the user's chat ID

## Shell tools

- `rg` (ripgrep) — recursive by default, do NOT pass `-R` or `-r`
- `node` — use `node -e` for JSON processing
- `python3` — available for scripting
- `grep` — fallback if needed
- **NOT installed:** `jq` — use `node -e` instead

## Cron (Gateway scheduler)

When calling the **cron.add** tool, use this shape. The gateway rejects `payload.message` and `payload.sessionTarget`; it requires `payload.text` and top-level `sessionTarget`.

- **Main session** (system event): `sessionTarget: "main"`, `payload: { "kind": "systemEvent", "text": "Your reminder or prompt text" }`.
- **Isolated session** (dedicated agent turn): `sessionTarget: "isolated"`, `payload: { "kind": "agentTurn", "text": "Your prompt text" }`.

Put `sessionTarget` and `schedule` at the top level of the params, not inside `payload`. Use `payload.text` only (do not use `payload.message`).

Example one-shot main-session job:
```json
{ "name": "Reminder", "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" }, "sessionTarget": "main", "wakeMode": "now", "payload": { "kind": "systemEvent", "text": "Reminder text" }, "deleteAfterRun": true }
```

## Token Refresh

If Senpi calls fail with an auth error, the token has expired. Tell the user to provide a fresh token, then run:
```bash
curl -s -X POST http://127.0.0.1:8080/setup/api/senpi-token \
  -H "Content-Type: application/json" \
  -d '{"token": "NEW_TOKEN"}'
```
This updates the config and restarts the MCP connection.