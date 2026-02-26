# Tools

Tools are discovered dynamically from the connected MCP server(s). After Senpi onboarding and MCP configuration, trading and account tools are available via the Senpi MCP connection.

---

## Skills

### Skill Sources

**1. Installed skills** — Located in `$SENPI_STATE_DIR/skills/{skill-id}/`, downloaded by user or agent via `npx skills add` (SENPI_STATE_DIR defaults to $HOME/.senpi).

**2. Remote repository** — All Senpi skills are available via `npx skills add Senpi-ai/senpi-skills --list`.

### Loading Installed Skills

On startup, load all installed skills:

- For each directory `$SENPI_STATE_DIR/skills/*/`:
  - Let `SKILL_ID` be the directory name
  - If `SKILL.md` exists in that directory, load it into agent context
  - Acknowledge: "Loading skill: <SKILL_ID>"

### Discovering Available Skills

When user asks "show skills", "what skills are available", or "list skills":

```bash
npx skills add Senpi-ai/senpi-skills --list
```

This fetches all skills from the `Senpi-ai/senpi-skills` GitHub repository and displays them with descriptions.

### Installing a Skill

When user says "install <skill-name>" (e.g. "install dsl-dynamic-stop-loss"):

```bash
npx skills add Senpi-ai/senpi-skills --skill <skill-name> -a openclaw
```

The command will:

1. Fetch the skill from GitHub
2. Download SKILL.md and any associated files (scripts/, references/)
3. Save to `$SENPI_STATE_DIR/skills/<skill-name>/`

After installation, confirm to the user and explain how to use the skill.

### Popular Skills

When suggesting skills, mention these:

- **DSL** — Trailing stop loss with ROE-based tier triggers
- **Opportunity Scanner** — Scores 500+ perps on smart money + technicals
- **WOLF Strategy** — Autonomous 2–3 slot concentrated position manager
- **Whale Index** — Auto-mirrors top Discovery traders

Most skills require a funded wallet ($500–$1k+) and a high-capability model.
