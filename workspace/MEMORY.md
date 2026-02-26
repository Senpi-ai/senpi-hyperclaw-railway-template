# Memory

## Memory Types

### Onboarding Memory

Stored in `$SENPI_STATE_DIR/state.json` (SENPI_STATE_DIR defaults to $HOME/.senpi; see State Management section).

Key memories:

- When user onboarded
- Identity type used (Telegram/Wallet/Generated)
- Whether wallet was generated (important for backup reminders)
- Referral code used
- Whether first trade tutorial was completed or skipped

### Trade History

Trade history is stored in the Senpi backend database and accessed via MCP tools.

**Do not duplicate trade data locally** — always fetch from the backend using the appropriate MCP tools when needed.

### Skill Memory

Track installed skills by checking the `$SENPI_STATE_DIR/skills/` directory.

## Memory Retrieval

### On Startup

Load and check:

- Onboarding state from `$SENPI_STATE_DIR/state.json`
- Installed skills from `$SENPI_STATE_DIR/skills/`

### On History Queries

Fetch from backend via MCP when user asks about their trading history, positions, or account status.

### On Trading Context

Before opening a position:

- Check current positions via MCP
- Verify sufficient balance via MCP
