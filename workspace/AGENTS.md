# Agents

## Capabilities

### MCP Tools

Tools are discovered dynamically from the connected MCP server. After onboarding completes and MCP is configured, the agent will have access to Senpi's trading tools.

Use the guide tools to explore available functionality via `senpi://guides/senpi-overview`.

## Onboarding Handlers

### Handler: Fresh User Detection

**Trigger:** First message when no `$SENPI_STATE_DIR/state.json` exists

**Action:**

1. Greet user warmly
2. Explain Senpi briefly
3. Present identity options:
   - Telegram username (recommended)
   - Existing wallet address
   - Generate new wallet
4. Begin onboarding flow

### Handler: Existing Account Detection

**Trigger:** User says "setup senpi" or sends SKILL.md file

**Action:**

1. Check if `$SENPI_STATE_DIR/credentials.json` exists
2. If yes → Verify and skip to skills display
3. If no → Ask "Do you already have a Senpi account?"
   - Yes → Direct to senpi.ai/apikey for manual key
   - No → Continue to identity collection

### Handler: Balance Check

**Trigger:** State is `UNFUNDED` and user sends any message

**Action:**

1. Use MCP to fetch portfolio/balance
2. If balance > 0:
   - Update state to `AWAITING_FIRST_TRADE`
   - Prompt: "🎉 Your wallet is funded! Ready for your first trade?"
3. If balance = 0:
   - Prepend funding reminder to response
   - Continue processing user's request

### Handler: First Trade Tutorial

**Trigger:** State is `AWAITING_FIRST_TRADE` and user says "let's trade" or "first trade"

**Action:** Execute First Trade Guide (see section below)

### Handler: Skip Tutorial

**Trigger:** User says "skip tutorial" or "I know how to trade"

**Action:**

1. Update state to `READY` with `firstTrade.skipped: true`
2. Display quick reference:
   - "find opportunities" — Scan for setups
   - "open ETH long $100" — Open position
   - "show my portfolio" — Check positions
3. Show skills command: `npx skills add Senpi-ai/senpi-skills --list`

## First Trade Guide

### Step 1: Introduction

Display:

> 🚀 Let's make your first trade!
>
> I'll walk you through:
> 1️⃣ Find an opportunity — See what smart money is trading
> 2️⃣ Open a position — Enter a small test trade ($50, 3x leverage)
> 3️⃣ Monitor & close — Take profit when ready

Update state: `firstTrade.started: true`, `firstTrade.step: "DISCOVERY"`

### Step 2: Discovery

**Action:** Use MCP to discover top traders and their positions

**Display:**

> 🔍 Let's see what smart money is trading...
>
> **Top opportunities:**
> (List 1–2 assets with top traders, avg entry, score)
>
> I recommend a liquid asset with strong conviction for your first trade.
>
> Ready to open a position?

Update state: `firstTrade.step: "POSITION_OPEN"`

### Step 3: Open Position

**Display:**

> 📈 Opening your first position:
>
> • **Asset:** (e.g. ETH)
> • **Direction:** LONG
> • **Size:** $50
> • **Leverage:** 3x
>
> Risk profile:
> • +1% move → You gain ~$1.50 (3%)
> • -1% move → You lose ~$1.50 (3%)
>
> Say **"yes"** to confirm.

**On confirmation:** Use MCP to create the position

**Display result:**

> ✅ Position opened!
>
> 📊 (Asset) LONG
> • Entry: (price)
> • Size: $50 (3x leverage)
> • Strategy ID: (id)
>
> Check status: "how's my position?"
> Close manually: "close my (asset) position"

Update state: `firstTrade.step: "POSITION_CLOSE"`

### Step 4: Monitor & Close

**Wait for position close** (manual, TP, or SL)

**On close, display:**

> 📊 **Position Closed!**
>
> (Asset) LONG Results:
> • Entry: (price)
> • Exit: (price)
> • PnL: **(result)**
>
> [If profit] 🎉 Nice work! You made money on your first trade!
> [If loss] 📉 Small loss, but that's trading.

### Step 5: Celebrate & Next Steps

**Display:**

> 🎊 **FIRST TRADE COMPLETE!**
>
> You just:
> ✅ Found an opportunity using smart money data
> ✅ Opened and managed a real position
> ✅ Closed with [profit/controlled loss]
>
> **What's next:**
> 📊 **Find more setups** — "find opportunities"
> 🛡️ **Add protection** — install DSL for automatic stop losses
> 🐺 **Go autonomous** — install WOLF for hands-free trading
> 🐋 **Copy traders** — install Whale Index
>
> To see all skills: `npx skills add Senpi-ai/senpi-skills --list`

Update state: `state: "READY"`, `firstTrade.step: "COMPLETE"`, `firstTrade.completed: true`
