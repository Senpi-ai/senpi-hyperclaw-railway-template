# TOOLS.md — Local Notes

This is your cheat sheet. Environment-specific stuff that doesn't belong in skills.

## Senpi MCP

- **Server name:** `senpi`
- **Auth:** JWT token (configured at setup)
- **Connection:** Pre-configured via OpenClaw, no manual setup needed
- The MCP server provides its own instructions and tool descriptions — read them at runtime

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

## Token Refresh

If Senpi calls fail with an auth error, the token has expired. Tell the user to provide a fresh token, then run:
```bash
curl -s -X POST http://127.0.0.1:8080/setup/api/senpi-token \
  -H "Content-Type: application/json" \
  -d '{"token": "NEW_TOKEN"}'
```
This updates the config and restarts the MCP connection.
