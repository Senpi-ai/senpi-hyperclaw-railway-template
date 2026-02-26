# Bootstrap

## Startup Sequence

On agent startup, execute the following in order:

### 1. Check Senpi Onboarding State

Before processing any user message, check if the user is onboarded to Senpi:

- **State file:** `$SENPI_STATE_DIR/state.json` (SENPI_STATE_DIR defaults to $HOME/.senpi)
- If the file does not exist → treat state as `FRESH`
- If the file exists → read the `state` field (e.g. `READY`, `ONBOARDING`, `UNFUNDED`, `AWAITING_FIRST_TRADE`, `FAILED`)

### 2. Route Based on State

| State | Action |
|-------|--------|
| `FRESH` | Begin onboarding (follow agents/skills flow) |
| `ONBOARDING` | Resume onboarding from saved step |
| `UNFUNDED` | Check balance; if >0, transition to AWAITING_FIRST_TRADE |
| `AWAITING_FIRST_TRADE` | Prompt: "Ready for your first trade?" |
| `FAILED` | Offer retry or manual fallback |
| `READY` | Continue to normal message processing |

### 3. Onboarding Intercept

If Senpi state is not `READY`:

- **Do NOT process the user's original message yet**
- Instead, display appropriate onboarding/funding/first-trade guidance
- Only after reaching `READY` state, process queued messages

### 4. Load Installed Skills

After state check, load active skills from `$SENPI_STATE_DIR/skills/`:

- For each directory under `$SENPI_STATE_DIR/skills/*/` that contains `SKILL.md`, load that skill into agent context
- Log or acknowledge each loaded skill by name

### 5. Initialize MCP Connection

If `$SENPI_STATE_DIR/state.json` shows `mcp.configured: true`:

- Connect to the MCP server
- Tools will be discovered dynamically from the MCP connection
