import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import * as tar from "tar";
import { bootstrapOpenClaw } from "./bootstrap.mjs";


// Railway commonly sets PORT=8080 for HTTP services.
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

// Ensure MCPORTER_CONFIG is set so the gateway and mcporter CLI can find the config.
if (!process.env.MCPORTER_CONFIG) {
  process.env.MCPORTER_CONFIG = path.join(STATE_DIR, "config", "mcporter.json");
}

// Protect /setup with a user-provided password.
const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

if (!SETUP_PASSWORD) {
  console.error("================================================================");
  console.error("WARNING: SETUP_PASSWORD is not configured.");
  console.error("  /setup and gateway routes (/, /openclaw) will be disabled.");
  console.error("  Set SETUP_PASSWORD in Railway Variables to enable the setup");
  console.error("  wizard and Control UI access.");
  console.error("================================================================");
}

// Debug logging helper
const DEBUG = process.env.OPENCLAW_TEMPLATE_DEBUG?.toLowerCase() === "true";
function debug(...args) {
  if (DEBUG) console.log(...args);
}

/** Returns a short fingerprint for logging; never logs the actual token. */
function tokenLogSafe(token) {
  if (!token || typeof token !== "string") return "(none)";
  return crypto.createHash("sha256").update(token, "utf8").digest("hex").slice(0, 8);
}

/** Constant-time string comparison to mitigate timing attacks on password auth. */
function secureCompare(a, b) {
  const aa = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  const maxLen = Math.max(aa.length, bb.length);
  if (maxLen === 0) return aa.length === bb.length;
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  aa.copy(paddedA);
  bb.copy(paddedB);
  return aa.length === bb.length && crypto.timingSafeEqual(paddedA, paddedB);
}

// Gateway admin token (protects Openclaw gateway + Control UI).
// Must be stable across restarts. If not provided via env, persist it in the state dir.
function resolveGatewayToken() {
  console.log(`[token] ========== SERVER STARTUP TOKEN RESOLUTION ==========`);
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  console.log(`[token] ENV OPENCLAW_GATEWAY_TOKEN exists: ${!!process.env.OPENCLAW_GATEWAY_TOKEN}`);
  console.log(`[token] ENV value length: ${process.env.OPENCLAW_GATEWAY_TOKEN?.length || 0}`);
  console.log(`[token] After trim length: ${envTok?.length || 0}`);

  if (envTok) {
    console.log(`[token] ✓ Using token from OPENCLAW_GATEWAY_TOKEN env variable`);
    console.log(`[token]   Fingerprint: ${tokenLogSafe(envTok)} (len: ${envTok.length})`);
    return envTok;
  }

  console.log(`[token] Env variable not available, checking persisted file...`);
  const tokenPath = path.join(STATE_DIR, "gateway.token");
  console.log(`[token] Token file path: ${tokenPath}`);

  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) {
      console.log(`[token] ✓ Using token from persisted file`);
      console.log(`[token]   Fingerprint: ${tokenLogSafe(existing)} (len: ${existing.length})`);
      return existing;
    }
  } catch (err) {
    console.log(`[token] Could not read persisted file: ${err.message}`);
  }

  const generated = crypto.randomBytes(32).toString("hex");
  console.log(`[token] ⚠️  Generating new random token (fingerprint: ${tokenLogSafe(generated)})`);
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
    console.log(`[token] Persisted new token to ${tokenPath}`);
  } catch (err) {
    console.warn(`[token] Could not persist token: ${err}`);
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;
console.log(`[token] Final resolved token fingerprint: ${tokenLogSafe(OPENCLAW_GATEWAY_TOKEN)} (len: ${OPENCLAW_GATEWAY_TOKEN.length})`);
console.log(`[token] ========== TOKEN RESOLUTION COMPLETE ==========\n`);

// Where the gateway will listen internally (we proxy to it).
const INTERNAL_GATEWAY_PORT = Number.parseInt(
  process.env.INTERNAL_GATEWAY_PORT ?? "18789",
  10,
);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

// How long to wait for the gateway to respond on health endpoints (cold start can take 30–60s).
const GATEWAY_READY_TIMEOUT_MS = Number.parseInt(
  process.env.GATEWAY_READY_TIMEOUT_MS ?? "60000",
  10,
) || 60000;

// Always run the built-from-source CLI entry directly to avoid PATH/global-install mismatches.
const OPENCLAW_ENTRY =
  process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

// --- Auto-onboarding from environment variables (zero-touch deployment) ---
// Users set these in Railway Variables instead of using the /setup wizard.

/**
 * Strip "Bearer " / "bearer " prefix if someone pastes it into a token env var.
 */
function stripBearer(val) {
  if (!val) return "";
  return val.replace(/^bearer\s+/i, "").trim();
}

/**
 * Validate and sanitize environment variables at startup.
 * Logs warnings for common mistakes so users can fix them quickly.
 */
function validateEnvVars() {
  const errors = [];
  const warnings = [];

  // --- AI_PROVIDER ---
  const provider = process.env.AI_PROVIDER?.trim()?.toLowerCase() || "";
  if (provider && !PROVIDER_TO_AUTH_CHOICE[provider]) {
    errors.push(
      `AI_PROVIDER="${provider}" is not recognized. ` +
        `Valid values: ${Object.keys(PROVIDER_TO_AUTH_CHOICE).join(", ")}`,
    );
  }

  // --- AI_API_KEY ---
  const apiKey = process.env.AI_API_KEY?.trim() || "";
  if (apiKey) {
    if (/^bearer\s+/i.test(apiKey)) {
      warnings.push('AI_API_KEY starts with "Bearer " — stripping prefix (pass the raw key only).');
      process.env.AI_API_KEY = stripBearer(apiKey);
    }
    if (apiKey.length < 8) {
      warnings.push("AI_API_KEY looks too short — double-check the value.");
    }
  }

  // --- TELEGRAM_BOT_TOKEN ---
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
  if (botToken && !/^\d+:[A-Za-z0-9_-]+$/.test(botToken)) {
    warnings.push(
      'TELEGRAM_BOT_TOKEN format looks wrong (expected "123456789:ABC..." from @BotFather).',
    );
  }

  // --- SENPI_AUTH_TOKEN ---
  const senpiToken = process.env.SENPI_AUTH_TOKEN?.trim() || "";
  if (senpiToken) {
    if (/^bearer\s+/i.test(senpiToken)) {
      warnings.push('SENPI_AUTH_TOKEN starts with "Bearer " — stripping prefix.');
      process.env.SENPI_AUTH_TOKEN = stripBearer(senpiToken);
    }
    if (senpiToken.length < 16) {
      warnings.push(
        "SENPI_AUTH_TOKEN looks too short — Senpi MCP may reject it. Check the value from Senpi.",
      );
    }
  } else {
    warnings.push(
      "SENPI_AUTH_TOKEN is blank — Senpi MCP will not authenticate. Set it in Variables if you use Senpi tools.",
    );
  }

  // --- TELEGRAM_USERNAME ---
  const telegramUser = process.env.TELEGRAM_USERNAME?.trim() || "";
  if (telegramUser && !/^@?\w+$/.test(telegramUser) && !/^\d+$/.test(telegramUser)) {
    warnings.push(
      `TELEGRAM_USERNAME="${telegramUser}" — expected @username or numeric chat ID.`,
    );
  }

  for (const w of warnings) console.warn(`[env-check] WARNING: ${w}`);
  for (const e of errors) console.error(`[env-check] ERROR: ${e}`);

  return { errors, warnings };
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim() || "";
const TELEGRAM_USERNAME = process.env.TELEGRAM_USERNAME?.trim() || "";
const AI_PROVIDER = process.env.AI_PROVIDER?.trim()?.toLowerCase() || "";
const AI_API_KEY = stripBearer(process.env.AI_API_KEY?.trim() || "");

// Map user-friendly AI_PROVIDER names to openclaw --auth-choice values.
const PROVIDER_TO_AUTH_CHOICE = {
  anthropic: "apiKey",
  openai: "openai-api-key",
  openrouter: "openrouter-api-key",
  gemini: "gemini-api-key",
  google: "gemini-api-key",
  "ai-gateway": "ai-gateway-api-key",
  moonshot: "moonshot-api-key",
  "kimi-code": "kimi-code-api-key",
  zai: "zai-api-key",
  minimax: "minimax-api",
  synthetic: "synthetic-api-key",
  "opencode-zen": "opencode-zen",
};

// Run env validation at startup (after PROVIDER_TO_AUTH_CHOICE is defined).
validateEnvVars();

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

let gatewayProc = null;
let gatewayStarting = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? GATEWAY_READY_TIMEOUT_MS;
  const start = Date.now();
  const endpoints = ["/openclaw", "/openclaw", "/", "/health"];
  
  while (Date.now() - start < timeoutMs) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${GATEWAY_TARGET}${endpoint}`, { method: "GET" });
        // Any HTTP response means the port is open.
        if (res) {
          console.log(`[gateway] ready at ${endpoint}`);
          return true;
        }
      } catch (err) {
        // not ready, try next endpoint
      }
    }
    await sleep(250);
  }
  console.error(`[gateway] failed to become ready after ${timeoutMs}ms`);
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  // Sync wrapper token to openclaw.json before every gateway start.
  // This ensures the gateway's config-file token matches what the wrapper injects via proxy.
  console.log(`[gateway] ========== GATEWAY START TOKEN SYNC ==========`);
  console.log(`[gateway] Syncing wrapper token to config (fingerprint: ${tokenLogSafe(OPENCLAW_GATEWAY_TOKEN)}, len: ${OPENCLAW_GATEWAY_TOKEN.length})`);

  const syncResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN]),
  );

  console.log(`[gateway] Sync result: exit code ${syncResult.code}`);
  if (syncResult.output?.trim()) {
    console.log(`[gateway] Sync output: ${syncResult.output}`);
  }

  if (syncResult.code !== 0) {
    console.error(`[gateway] ⚠️  WARNING: Token sync failed with code ${syncResult.code}`);
  }

  // Verify sync succeeded
  try {
    const config = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const configToken = config?.gateway?.auth?.token;

    console.log(`[gateway] Token verification:`);
    console.log(`[gateway]   Wrapper fingerprint: ${tokenLogSafe(OPENCLAW_GATEWAY_TOKEN)} (len: ${OPENCLAW_GATEWAY_TOKEN.length})`);
    console.log(`[gateway]   Config fingerprint:  ${tokenLogSafe(configToken)} (len: ${configToken?.length || 0})`);

    if (configToken !== OPENCLAW_GATEWAY_TOKEN) {
      console.error(`[gateway] ✗ Token mismatch detected!`);
      throw new Error(
        `Token mismatch: wrapper fingerprint ${tokenLogSafe(OPENCLAW_GATEWAY_TOKEN)} vs config ${tokenLogSafe(configToken)}`
      );
    }
    console.log(`[gateway] ✓ Token verification PASSED`);
  } catch (err) {
    console.error(`[gateway] ERROR: Token verification failed: ${err}`);
    throw err; // Don't start gateway with mismatched token
  }

  console.log(`[gateway] ========== TOKEN SYNC COMPLETE ==========`);

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
  ];

  // Capture last 4KB of stderr so we can log it on non-zero exit (helps debug "exited code=1" in Railway).
  let stderrTail = Buffer.alloc(0);
  const stderrMaxBytes = 4096;

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: ["inherit", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc.stdout?.pipe(process.stdout);
  gatewayProc.stderr?.pipe(process.stderr);
  gatewayProc.stderr?.on("data", (chunk) => {
    stderrTail = Buffer.concat([stderrTail, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    if (stderrTail.length > stderrMaxBytes) {
      stderrTail = stderrTail.subarray(-stderrMaxBytes);
    }
  });

  const gatewayCmdForLog = clawArgs(args).join(" ").replace(OPENCLAW_GATEWAY_TOKEN, "<redacted>");
  console.log(`[gateway] starting with command: ${OPENCLAW_NODE} ${gatewayCmdForLog}`);
  console.log(`[gateway] STATE_DIR: ${STATE_DIR}`);
  console.log(`[gateway] WORKSPACE_DIR: ${WORKSPACE_DIR}`);
  console.log(`[gateway] config path: ${configPath()}`);

  gatewayProc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    if (code !== 0 && code != null && stderrTail.length > 0) {
      const tail = stderrTail.toString("utf8").trim();
      if (tail) {
        console.error(`[gateway] stderr before exit:\n${tail}`);
      }
    }
    gatewayProc = null;
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: GATEWAY_READY_TIMEOUT_MS });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function restartGateway() {
  console.log("[gateway] Restarting gateway...");

  // Kill gateway process tracked by wrapper
  if (gatewayProc) {
    console.log("[gateway] Killing wrapper-managed gateway process");
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    gatewayProc = null;
  }

  // Also kill any other gateway processes (e.g., started by onboard command)
  // by finding processes listening on the gateway port
  console.log(`[gateway] Killing any other gateway processes on port ${INTERNAL_GATEWAY_PORT}`);
  try {
    const killResult = await runCmd("pkill", ["-f", "openclaw-gateway"]);
    console.log(`[gateway] pkill result: exit code ${killResult.code}`);
  } catch (err) {
    console.log(`[gateway] pkill failed: ${err.message}`);
  }

  // Give processes time to exit and release the port
  await sleep(1500);

  return ensureGatewayRunning();
}

// --- Auto-onboarding logic ---

let onboardingInProgress = false;

/** Path to file storing env fingerprint after successful auto-onboard (used to detect env changes on redeploy). */
const AUTO_ONBOARD_FINGERPRINT_FILE = path.join(
  STATE_DIR,
  ".auto-onboard-env.fingerprint",
);

/** Hash of env vars that affect auto-onboard config. Redeploy with different values triggers re-onboard. */
function envFingerprintForOnboard() {
  const payload = {
    AI_PROVIDER,
    AI_API_KEY,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_USERNAME,
    SENPI_AUTH_TOKEN: process.env.SENPI_AUTH_TOKEN?.trim() || "",
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

/** True if config was created by auto-onboard and current env vars differ (user updated Variables and redeployed). */
function shouldReOnboardDueToEnvChange() {
  try {
    const stored = fs.readFileSync(AUTO_ONBOARD_FINGERPRINT_FILE, "utf8").trim();
    const current = envFingerprintForOnboard();
    return stored !== "" && current !== stored;
  } catch {
    return false; // No stored fingerprint (e.g. manual setup or legacy deploy)
  }
}

function canAutoOnboard() {
  return (
    !isConfigured() &&
    AI_PROVIDER &&
    AI_API_KEY &&
    !!PROVIDER_TO_AUTH_CHOICE[AI_PROVIDER]
  );
}

/**
 * Resolve TELEGRAM_USERNAME (@username or numeric chat ID) to a numeric chat ID,
 * then write USER.md into the workspace so the agent and BOOT.md hook know
 * who the user is and how to reach them on Telegram.
 *
 * Must be called BEFORE the gateway starts so we can use getUpdates without
 * conflicting with the gateway's Telegram poller.
 */
async function resolveTelegramAndWriteUserMd() {
  let chatId = "";
  let username = "";

  if (!TELEGRAM_BOT_TOKEN) {
    console.log("[telegram] No TELEGRAM_BOT_TOKEN, skipping USER.md write");
    return;
  }

  try {
    // Verify bot token
    const meRes = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`,
    );
    const me = await meRes.json();
    if (!me.ok) {
      console.error(`[telegram] Invalid bot token: ${me.description}`);
      return;
    }

    console.log(`[telegram] Bot verified: @${me.result.username}`);

    if (TELEGRAM_USERNAME) {
      if (/^\d+$/.test(TELEGRAM_USERNAME)) {
        chatId = TELEGRAM_USERNAME;
        console.log(`[telegram] Using TELEGRAM_USERNAME (numeric): ${chatId}`);
      } else {
        // @username — resolve from recent getUpdates
        username = TELEGRAM_USERNAME.replace(/^@/, "").toLowerCase();
        const updatesRes = await fetch(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=100`,
        );
        const updates = await updatesRes.json();
        console.log("[Telegram]updates");
        console.log(JSON.stringify(updates, null, 2));
        const updateList = (updates.ok && updates.result) || [];

        for (const update of updateList) {
          const chat = update.message?.chat || update.my_chat_member?.chat;
          const from = update.message?.from || update.my_chat_member?.from;
          if (chat?.username?.toLowerCase() === username) {
            chatId = String(chat.id);
            break;
          }
          if (from?.username?.toLowerCase() === username) {
            chatId = String(chat?.id || from?.id);
            break;
          }
        }

        if (chatId) {
          console.log(
            `[telegram] Resolved @${username} → chat ID ${chatId}`,
          );
        } else {
          console.warn(
            `[telegram] Could not resolve @${username} — ` +
              "the user must message the bot first so the chat ID can be discovered.",
          );
        }
      }
    }
  } catch (err) {
    console.error(`[telegram] Error resolving user: ${err.message}`);
  }

  // Write USER.md with Telegram contact info so BOOT.md can message the user
  const userMdPath = path.join(WORKSPACE_DIR, "USER.md");
  const lines = ["# User"];
  if (chatId) {
    lines.push("");
    lines.push(`## Telegram`);
    lines.push(`- Chat ID: ${chatId}`);
    if (username) lines.push(`- Username: @${username}`);
    lines.push("");
    lines.push(
      "When sending Telegram messages to this user, " +
        `use target \`telegram:${chatId}\` (numeric chat ID, not @username).`,
    );
  } else if (username) {
    lines.push("");
    lines.push(`## Telegram`);
    lines.push(`- Username: @${username}`);
    lines.push(`- Chat ID: unknown (user hasn't messaged the bot yet)`);
    lines.push("");
    lines.push(
      "Cannot send Telegram messages until the user messages the bot first.",
    );
  }
  lines.push("");

  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.writeFileSync(userMdPath, lines.join("\n"));
  console.log(`[telegram] Wrote ${userMdPath}`);
}

/**
 * Automatically onboard and configure everything from environment variables.
 * This enables zero-touch Railway deployments: set env vars → deploy → bot works.
 */
async function autoOnboard() {
  if (!canAutoOnboard()) {
    if (!isConfigured() && (AI_PROVIDER || AI_API_KEY)) {
      console.log(
        "[auto-onboard] Cannot auto-onboard: missing or invalid env vars",
      );
      if (!AI_PROVIDER)
        console.log("[auto-onboard]   Missing AI_PROVIDER");
      if (!AI_API_KEY) console.log("[auto-onboard]   Missing AI_API_KEY");
      if (AI_PROVIDER && !PROVIDER_TO_AUTH_CHOICE[AI_PROVIDER]) {
        console.log(
          `[auto-onboard]   Unknown AI_PROVIDER: "${AI_PROVIDER}"`,
        );
        console.log(
          `[auto-onboard]   Valid providers: ${Object.keys(PROVIDER_TO_AUTH_CHOICE).join(", ")}`,
        );
      }
    }
    return;
  }

  if (onboardingInProgress) {
    console.log("[auto-onboard] Already in progress, skipping");
    return;
  }

  onboardingInProgress = true;

  try {
    console.log(
      "[auto-onboard] ========== AUTO-ONBOARDING START ==========",
    );
    console.log(`[auto-onboard] AI Provider: ${AI_PROVIDER}`);
    console.log(
      `[auto-onboard] Telegram: ${TELEGRAM_BOT_TOKEN ? "configured" : "not set"}`,
    );

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    // Build onboard payload from env vars
    const authChoice = PROVIDER_TO_AUTH_CHOICE[AI_PROVIDER];
    const payload = {
      flow: "quickstart",
      authChoice,
      authSecret: AI_API_KEY,
    };

    const onboardArgs = buildOnboardArgs(payload);
    const autoOnboardCmdForLog = onboardArgs
      .join(" ")
      .replace(AI_API_KEY, "***")
      .replace(OPENCLAW_GATEWAY_TOKEN, "<redacted>");
    console.log(`[auto-onboard] Running: openclaw ${autoOnboardCmdForLog}`);

    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));
    const ok = onboard.code === 0 && isConfigured();

    if (!ok) {
      console.error(
        `[auto-onboard] Onboarding failed (exit code: ${onboard.code})`,
      );
      console.error(`[auto-onboard] Output: ${onboard.output}`);
      return;
    }

    console.log("[auto-onboard] Onboarding succeeded");

    // --- Sync gateway configuration ---
    console.log("[auto-onboard] Syncing gateway configuration...");
    await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "gateway.mode", "local"]),
    );
    await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "gateway.auth.mode", "token"]),
    );

    const setTokenResult = await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "config",
        "set",
        "gateway.auth.token",
        OPENCLAW_GATEWAY_TOKEN,
      ]),
    );

    if (setTokenResult.code !== 0) {
      console.error(
        `[auto-onboard] Failed to set gateway token: ${setTokenResult.output}`,
      );
    }

    // Verify token sync
    try {
      const config = JSON.parse(fs.readFileSync(configPath(), "utf8"));
      const configToken = config?.gateway?.auth?.token;
      if (configToken !== OPENCLAW_GATEWAY_TOKEN) {
        console.error("[auto-onboard] Token mismatch after sync!");
        throw new Error(
          `Token mismatch: wrapper fingerprint ${tokenLogSafe(OPENCLAW_GATEWAY_TOKEN)} vs config ${tokenLogSafe(configToken)}`,
        );
      }
      console.log("[auto-onboard] Token sync verified");
    } catch (err) {
      console.error(
        `[auto-onboard] Token verification failed: ${err}`,
      );
      throw err;
    }

    await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "gateway.bind", "loopback"]),
    );
    await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "config",
        "set",
        "gateway.port",
        String(INTERNAL_GATEWAY_PORT),
      ]),
    );
    // Allow Control UI without device pairing: wrapper enforces Basic auth on all
    // proxy and Control UI routes, so gateway pairing is redundant (must use --json for boolean).
    await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "config",
        "set",
        "--json",
        "gateway.controlUi.allowInsecureAuth",
        "true",
      ]),
    );
    // Trust the wrapper proxy (loopback) so X-Forwarded-For headers are accepted
    await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "config",
        "set",
        "--json",
        "gateway.trustedProxies",
        JSON.stringify(["127.0.0.1", "::1"]),
      ]),
    );

    // --- Configure Telegram channel ---
    if (TELEGRAM_BOT_TOKEN) {
      console.log("[auto-onboard] Configuring Telegram channel...");
      const channelsHelp = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["channels", "add", "--help"]),
      );
      const helpText = channelsHelp.output || "";

      if (!helpText.includes("telegram")) {
        console.log(
          "[auto-onboard] Telegram not supported by this build, skipping",
        );
      } else {
        // Write the channel config
        // dmPolicy "open" requires allowFrom ["*"] to pass config validation.
        const cfgObj = {
          enabled: true,
          dmPolicy: "open",
          allowFrom: ["*"],
          botToken: TELEGRAM_BOT_TOKEN,
          groupPolicy: "allowlist",
          streamMode: "partial",
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "--json",
            "channels.telegram",
            JSON.stringify(cfgObj),
          ]),
        );
        console.log(
          `[auto-onboard] Telegram config set: exit=${set.code} output=${set.output.trim()}`,
        );

        // Also enable the telegram plugin entry (required by some builds)
        await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "--json",
            "plugins.entries.telegram",
            JSON.stringify({ enabled: true }),
          ]),
        );

        // Run doctor --fix to finalize channel enablement
        console.log("[auto-onboard] Running doctor --fix to finalize config...");
        const doctor = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["doctor", "--fix"]),
        );
        console.log(
          `[auto-onboard] doctor --fix: exit=${doctor.code} output=${doctor.output.trim()}`,
        );
      }
    }

    // --- Resolve Telegram user BEFORE gateway starts ---
    // (Must happen before gateway claims Telegram polling — only one consumer allowed)
    await resolveTelegramAndWriteUserMd();

    // --- Bootstrap and start gateway ---
    // (Senpi MCP server is configured via mcporter.json in bootstrapOpenClaw(),
    //  NOT in openclaw.json — the gateway rejects unknown root keys.)
    bootstrapOpenClaw();
    console.log("[auto-onboard] Bootstrap complete");

    await restartGateway();
    console.log("[auto-onboard] Gateway started and ready");

    // Store env fingerprint so redeploy with updated Variables triggers re-onboard
    try {
      fs.writeFileSync(
        AUTO_ONBOARD_FINGERPRINT_FILE,
        envFingerprintForOnboard(),
        "utf8",
      );
      console.log("[auto-onboard] Stored env fingerprint for redeploy detection");
    } catch (e) {
      console.warn("[auto-onboard] Could not write fingerprint file:", e.message);
    }

    console.log(
      "[auto-onboard] ========== AUTO-ONBOARDING COMPLETE ==========",
    );
  } catch (err) {
    console.error(`[auto-onboard] Error: ${err}`);
    console.error(
      "[auto-onboard] Auto-onboarding failed. Visit /setup to configure manually.",
    );
  } finally {
    onboardingInProgress = false;
  }
}

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send(
        "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
      );
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="Openclaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (!secureCompare(password, SETUP_PASSWORD)) {
    res.set("WWW-Authenticate", 'Basic realm="Openclaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

/**
 * Check that the request is authenticated for proxy (gateway/Control UI) access.
 * Uses the same SETUP_PASSWORD Basic auth as /setup so one password protects everything.
 * Returns true if authenticated; otherwise sends 401/500 and returns false.
 */
function checkProxyAuth(req, res) {
  if (!SETUP_PASSWORD) {
    res
      .status(500)
      .type("text/plain")
      .send(
        "SETUP_PASSWORD is not set. Set it in Railway Variables to access the gateway.",
      );
    return false;
  }
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="Openclaw"');
    res.status(401).send("Auth required");
    return false;
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (!secureCompare(password, SETUP_PASSWORD)) {
    res.set("WWW-Authenticate", 'Basic realm="Openclaw"');
    res.status(401).send("Invalid password");
    return false;
  }
  return true;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Minimal health endpoint for Railway.
// Must be first route: no auth, no config/gateway dependency — so Railway health checks always pass.
app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

// Serve static files for setup wizard
app.get("/setup/app.js", requireSetupAuth, (_req, res) => {
  res.type("application/javascript");
  res.sendFile(path.join(process.cwd(), "src", "public", "setup-app.js"));
});

app.get("/setup/styles.css", requireSetupAuth, (_req, res) => {
  res.type("text/css");
  res.sendFile(path.join(process.cwd(), "src", "public", "styles.css"));
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "setup.html"));
});

// Token-exchange: return gateway token only after auth. Control UI script fetches this
// instead of receiving the token in HTML, so the token is never embedded in the page source.
app.get("/setup/api/gateway-token", requireSetupAuth, (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ token: OPENCLAW_GATEWAY_TOKEN });
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const channelsHelp = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["channels", "add", "--help"]),
  );

  // We reuse Openclaw's own auth-choice grouping logic indirectly by hardcoding the same group defs.
  // This is intentionally minimal; later we can parse the CLI help output to stay perfectly in sync.
  const authGroups = [
    {
      value: "openai",
      label: "OpenAI",
      hint: "Codex OAuth + API key",
      options: [
        { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
        { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
        { value: "openai-api-key", label: "OpenAI API key" },
      ],
    },
    {
      value: "anthropic",
      label: "Anthropic",
      hint: "Claude Code CLI + API key",
      options: [
        { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
        { value: "token", label: "Anthropic token (paste setup-token)" },
        { value: "apiKey", label: "Anthropic API key" },
      ],
    },
    {
      value: "google",
      label: "Google",
      hint: "Gemini API key + OAuth",
      options: [
        { value: "gemini-api-key", label: "Google Gemini API key" },
        { value: "google-antigravity", label: "Google Antigravity OAuth" },
        { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" },
      ],
    },
    {
      value: "openrouter",
      label: "OpenRouter",
      hint: "API key",
      options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }],
    },
    {
      value: "ai-gateway",
      label: "Vercel AI Gateway",
      hint: "API key",
      options: [
        { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
      ],
    },
    {
      value: "moonshot",
      label: "Moonshot AI",
      hint: "Kimi K2 + Kimi Code",
      options: [
        { value: "moonshot-api-key", label: "Moonshot AI API key" },
        { value: "kimi-code-api-key", label: "Kimi Code API key" },
      ],
    },
    {
      value: "zai",
      label: "Z.AI (GLM 4.7)",
      hint: "API key",
      options: [{ value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }],
    },
    {
      value: "minimax",
      label: "MiniMax",
      hint: "M2.1 (recommended)",
      options: [
        { value: "minimax-api", label: "MiniMax M2.1" },
        { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" },
      ],
    },
    {
      value: "qwen",
      label: "Qwen",
      hint: "OAuth",
      options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
    },
    {
      value: "copilot",
      label: "Copilot",
      hint: "GitHub + local proxy",
      options: [
        {
          value: "github-copilot",
          label: "GitHub Copilot (GitHub device login)",
        },
        { value: "copilot-proxy", label: "Copilot Proxy (local)" },
      ],
    },
    {
      value: "synthetic",
      label: "Synthetic",
      hint: "Anthropic-compatible (multi-model)",
      options: [{ value: "synthetic-api-key", label: "Synthetic API key" }],
    },
    {
      value: "opencode-zen",
      label: "OpenCode Zen",
      hint: "API key",
      options: [
        { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" },
      ],
    },
  ];

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version.output.trim(),
    channelsAddHelp: channelsHelp.output,
    authGroups,
  });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    // The wrapper owns public networking; keep the gateway internal.
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    // Map secret to correct flag for common choices.
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      apiKey: "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token" && secret) {
      // This is the Anthropics setup-token flow.
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (onboardingInProgress) {
      return res.status(409).json({
        ok: false,
        output: "Onboarding is already in progress (auto-onboard). Please wait.",
      });
    }

    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({
        ok: true,
        output:
          "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};
    const onboardArgs = buildOnboardArgs(payload);

    // DIAGNOSTIC: Log token fingerprint only (never the actual token)
    console.log(`[onboard] ========== TOKEN DIAGNOSTIC START ==========`);
    console.log(`[onboard] Wrapper token fingerprint: ${tokenLogSafe(OPENCLAW_GATEWAY_TOKEN)} (length: ${OPENCLAW_GATEWAY_TOKEN.length})`);
    console.log(`[onboard] Onboard command args include: --gateway-token <redacted>`);
    const cmdForLog = clawArgs(onboardArgs).join(" ").replace(OPENCLAW_GATEWAY_TOKEN, "<redacted>");
    console.log(`[onboard] Full onboard command: node ${cmdForLog}`);

    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

    let extra = "";

    const ok = onboard.code === 0 && isConfigured();

    // DIAGNOSTIC: Check what token onboard actually wrote to config
    if (ok) {
      try {
        const configAfterOnboard = JSON.parse(fs.readFileSync(configPath(), "utf8"));
        const tokenAfterOnboard = configAfterOnboard?.gateway?.auth?.token;
        console.log(`[onboard] Token in config AFTER onboard: fingerprint ${tokenLogSafe(tokenAfterOnboard)} (length: ${tokenAfterOnboard?.length || 0})`);
        console.log(`[onboard] Token match: ${tokenAfterOnboard === OPENCLAW_GATEWAY_TOKEN ? "✓ MATCHES" : "✗ MISMATCH!"}`);
        if (tokenAfterOnboard !== OPENCLAW_GATEWAY_TOKEN) {
          console.log(`[onboard] ⚠️  PROBLEM: onboard command ignored --gateway-token flag and wrote its own token!`);
          extra += `\n[WARNING] onboard wrote different token than expected\n`;
          extra += `  Expected fingerprint: ${tokenLogSafe(OPENCLAW_GATEWAY_TOKEN)}\n`;
          extra += `  Got fingerprint:      ${tokenLogSafe(tokenAfterOnboard)}\n`;
        }
      } catch (err) {
        console.error(`[onboard] Could not check config after onboard: ${err}`);
      }
    }

    // Optional channel setup (only after successful onboarding, and only if the installed CLI supports it).
    if (ok) {
      // Ensure gateway token is written into config so the browser UI can authenticate reliably.
      // (We also enforce loopback bind since the wrapper proxies externally.)
      console.log(`[onboard] Now syncing wrapper token to config (fingerprint: ${tokenLogSafe(OPENCLAW_GATEWAY_TOKEN)})`);

      await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.mode", "local"]));
      await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "gateway.auth.mode", "token"]),
      );

      const setTokenResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.auth.token",
          OPENCLAW_GATEWAY_TOKEN,
        ]),
      );

      console.log(`[onboard] config set gateway.auth.token result: exit code ${setTokenResult.code}`);
      if (setTokenResult.output?.trim()) {
        console.log(`[onboard] config set output: ${setTokenResult.output}`);
      }

      if (setTokenResult.code !== 0) {
        console.error(`[onboard] ⚠️  WARNING: config set gateway.auth.token failed with code ${setTokenResult.code}`);
        extra += `\n[WARNING] Failed to set gateway token in config: ${setTokenResult.output}\n`;
      }

      // Verify the token was actually written to config
      try {
        const configContent = fs.readFileSync(configPath(), "utf8");
        const config = JSON.parse(configContent);
        const configToken = config?.gateway?.auth?.token;

        console.log(`[onboard] Token verification after sync:`);
        console.log(`[onboard]   Wrapper fingerprint: ${tokenLogSafe(OPENCLAW_GATEWAY_TOKEN)} (len: ${OPENCLAW_GATEWAY_TOKEN.length})`);
        console.log(`[onboard]   Config fingerprint:  ${tokenLogSafe(configToken)} (len: ${configToken?.length || 0})`);

        if (configToken !== OPENCLAW_GATEWAY_TOKEN) {
          console.error(`[onboard] ✗ ERROR: Token mismatch after config set!`);
          extra += `\n[ERROR] Token verification failed! Config has different token than wrapper.\n`;
          extra += `  Wrapper fingerprint: ${tokenLogSafe(OPENCLAW_GATEWAY_TOKEN)}\n`;
          extra += `  Config fingerprint:  ${tokenLogSafe(configToken)}\n`;
        } else {
          console.log(`[onboard] ✓ Token verification PASSED - tokens match!`);
          extra += `\n[onboard] ✓ Gateway token synced successfully\n`;
        }
      } catch (err) {
        console.error(`[onboard] ERROR: Could not verify token in config: ${err}`);
        extra += `\n[ERROR] Could not verify token: ${String(err)}\n`;
      }

      console.log(`[onboard] ========== TOKEN DIAGNOSTIC END ==========`);

      await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "gateway.bind", "loopback"]),
      );
      await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.port",
          String(INTERNAL_GATEWAY_PORT),
        ]),
      );
      // Allow Control UI without device pairing: wrapper enforces Basic auth on all
      // proxy and Control UI routes, so gateway pairing is redundant (must use --json for boolean).
      await runCmd(
        OPENCLAW_NODE,
        clawArgs(["config", "set", "--json", "gateway.controlUi.allowInsecureAuth", "true"]),
      );
      // Trust the wrapper proxy (loopback) so X-Forwarded-For headers are accepted
      await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "--json",
          "gateway.trustedProxies",
          JSON.stringify(["127.0.0.1", "::1"]),
        ]),
      );

      const channelsHelp = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["channels", "add", "--help"]),
      );
      const helpText = channelsHelp.output || "";

      const supports = (name) => helpText.includes(name);

      if (payload.telegramToken?.trim()) {
        if (!supports("telegram")) {
          extra +=
            "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
        } else {
          // Avoid `channels add` here (it has proven flaky across builds); write config directly.
          const token = payload.telegramToken.trim();
          const cfgObj = {
            enabled: true,
            dmPolicy: "pairing",
            botToken: token,
            groupPolicy: "allowlist",
            streamMode: "partial",
          };
          const set = await runCmd(
            OPENCLAW_NODE,
            clawArgs([
              "config",
              "set",
              "--json",
              "channels.telegram",
              JSON.stringify(cfgObj),
            ]),
          );
          // Also enable the telegram plugin entry (required by some builds)
          await runCmd(
            OPENCLAW_NODE,
            clawArgs([
              "config",
              "set",
              "--json",
              "plugins.entries.telegram",
              JSON.stringify({ enabled: true }),
            ]),
          );
          // Run doctor --fix to finalize channel enablement
          const doctor = await runCmd(
            OPENCLAW_NODE,
            clawArgs(["doctor", "--fix"]),
          );
          const get = await runCmd(
            OPENCLAW_NODE,
            clawArgs(["config", "get", "channels.telegram"]),
          );
          extra += `\n[telegram config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
          extra += `\n[telegram doctor] exit=${doctor.code}\n${doctor.output || "(no output)"}`;
          extra += `\n[telegram verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
        }
      }

      if (payload.discordToken?.trim()) {
        if (!supports("discord")) {
          extra +=
            "\n[discord] skipped (this openclaw build does not list discord in `channels add --help`)\n";
        } else {
          const token = payload.discordToken.trim();
          const cfgObj = {
            enabled: true,
            token,
            groupPolicy: "allowlist",
            dm: {
              policy: "pairing",
            },
          };
          const set = await runCmd(
            OPENCLAW_NODE,
            clawArgs([
              "config",
              "set",
              "--json",
              "channels.discord",
              JSON.stringify(cfgObj),
            ]),
          );
          const get = await runCmd(
            OPENCLAW_NODE,
            clawArgs(["config", "get", "channels.discord"]),
          );
          extra += `\n[discord config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
          extra += `\n[discord verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
        }
      }

      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        if (!supports("slack")) {
          extra +=
            "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
        } else {
          const cfgObj = {
            enabled: true,
            botToken: payload.slackBotToken?.trim() || undefined,
            appToken: payload.slackAppToken?.trim() || undefined,
          };
          const set = await runCmd(
            OPENCLAW_NODE,
            clawArgs([
              "config",
              "set",
              "--json",
              "channels.slack",
              JSON.stringify(cfgObj),
            ]),
          );
          const get = await runCmd(
            OPENCLAW_NODE,
            clawArgs(["config", "get", "channels.slack"]),
          );
          extra += `\n[slack config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}`;
          extra += `\n[slack verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`;
        }
      }
      await resolveTelegramAndWriteUserMd();
      bootstrapOpenClaw();
      // Apply changes immediately.
      await restartGateway();
    }

    return res.status(ok ? 200 : 500).json({
      ok,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res
      .status(500)
      .json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

// Debug endpoint: only available when OPENCLAW_TEMPLATE_DEBUG=true to avoid
// leaking internal structure (paths, Node version, token source, commit SHA) in production.
app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  if (!DEBUG) {
    return res.status(404).json({ error: "Not Found" });
  }
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["channels", "add", "--help"]),
  );
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(
        path.join(STATE_DIR, "gateway.token"),
      ),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["pairing", "approve", String(channel), String(code)]),
  );
  return res
    .status(r.code === 0 ? 200 : 500)
    .json({ ok: r.code === 0, output: r.output });
});

// --- Update Senpi auth token at runtime (callable by the agent via curl) ---
// Localhost-only: no auth required since only processes inside the container can reach it.
app.post("/setup/api/senpi-token", async (req, res) => {
  // Restrict to localhost — agent/gateway run in the same container.
  const remoteIp = req.ip || req.socket?.remoteAddress || "";
  const isLocal =
    remoteIp === "127.0.0.1" ||
    remoteIp === "::1" ||
    remoteIp === "::ffff:127.0.0.1";
  if (!isLocal) {
    return res.status(403).json({ ok: false, error: "Localhost only" });
  }

  const { token } = req.body || {};
  if (!token || typeof token !== "string" || !token.trim()) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing or empty token" });
  }

  const newToken = token.trim();

  try {
    // 1. Update process.env so future bootstrapOpenClaw() calls use the new token
    process.env.SENPI_AUTH_TOKEN = newToken;

    // 2. Update mcporter.json directly
    const mcporterPath =
      process.env.MCPORTER_CONFIG ||
      path.join(STATE_DIR, "config", "mcporter.json");

    let config;
    try {
      config = JSON.parse(fs.readFileSync(mcporterPath, "utf8"));
    } catch {
      config = { mcpServers: {}, imports: [] };
    }
    if (!config.mcpServers) config.mcpServers = {};

    if (
      config.mcpServers.senpi &&
      typeof config.mcpServers.senpi === "object"
    ) {
      // Update token in existing entry
      if (!config.mcpServers.senpi.env) config.mcpServers.senpi.env = {};
      config.mcpServers.senpi.env.SENPI_AUTH_TOKEN = newToken;
    } else {
      // Create fresh entry
      const mcpUrl =
        process.env.SENPI_MCP_URL || "https://mcp.dev.senpi.ai/mcp";
      config.mcpServers.senpi = {
        command: "npx",
        args: [
          "mcp-remote",
          mcpUrl,
          "--header",
          "Authorization: Bearer ${SENPI_AUTH_TOKEN}",
        ],
        env: { SENPI_AUTH_TOKEN: newToken },
      };
    }

    fs.writeFileSync(mcporterPath, JSON.stringify(config, null, 2));
    console.log("[senpi-token] Updated mcporter.json with new token");

    // 3. Kill stale mcp-remote processes so mcporter respawns them with the new token
    try {
      const kill = await runCmd("pkill", ["-f", "mcp-remote"]);
      console.log(
        `[senpi-token] pkill mcp-remote: exit=${kill.code}`,
      );
    } catch {
      // pkill returns exit=1 if no processes matched — that's fine
    }

    return res.json({
      ok: true,
      message:
        "Token updated. mcp-remote processes killed — next MCP call will use the new token.",
    });
  } catch (err) {
    console.error(`[senpi-token] Error: ${err}`);
    return res
      .status(500)
      .json({ ok: false, error: String(err) });
  }
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  // Minimal reset: delete the config file so /setup can rerun.
  // Keep credentials/sessions/workspace by default.
  try {
    fs.rmSync(configPath(), { force: true });
    res
      .type("text/plain")
      .send("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.get("/setup/export", requireSetupAuth, async (req, res) => {
  // Audit log: export is a high-sensitivity operation (would include secrets if we didn't exclude)
  console.warn(
    `[export] BACKUP EXPORT requested at ${new Date().toISOString()} (auth passed, sensitive files excluded)`,
  );

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  res.setHeader("content-type", "application/gzip");
  res.setHeader(
    "content-disposition",
    `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`,
  );

  // Prefer exporting from a common /data root so archives are easy to inspect and restore.
  // This preserves dotfiles like /data/.openclaw/openclaw.json.
  const stateAbs = path.resolve(STATE_DIR);
  const workspaceAbs = path.resolve(WORKSPACE_DIR);

  const dataRoot = "/data";
  const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

  let cwd = "/";
  let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

  if (underData(stateAbs) && underData(workspaceAbs)) {
    cwd = dataRoot;
    // We export relative to /data so the archive contains: .openclaw/... and workspace/...
    paths = [
      path.relative(dataRoot, stateAbs) || ".",
      path.relative(dataRoot, workspaceAbs) || ".",
    ];
  }

  // Exclude secrets from backup: gateway token, openclaw.json (API keys, channel creds),
  // mcporter.json (Senpi auth). Reduces impact of weak password or token leak.
  const sensitivePath = (entryPath) => {
    const p = entryPath.replace(/\\/g, "/");
    if (p.includes("gateway.token") || p.endsWith(".token")) return true;
    if (p.includes("openclaw.json")) return true;
    if (p.includes("mcporter.json")) return true;
    return false;
  };

  const stream = tar.c(
    {
      gzip: true,
      portable: true,
      noMtime: true,
      cwd,
      onwarn: () => {},
      filter: (entryPath) => !sensitivePath(entryPath),
    },
    paths,
  );

  stream.on("error", (err) => {
    console.error("[export]", err);
    if (!res.headersSent) res.status(500);
    res.end(String(err));
  });

  stream.pipe(res);
});

// Proxy everything else to the gateway.
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, _res) => {
  console.error("[proxy]", err);
});

// Inject auth token into HTTP proxy requests
proxy.on("proxyReq", (proxyReq, req, res) => {
  console.log(`[proxy] HTTP ${req.method} ${req.url} - injecting token (fingerprint: ${tokenLogSafe(OPENCLAW_GATEWAY_TOKEN)})`);
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
});

// Inject auth token into WebSocket proxy requests (must use proxyReqWs event handler —
// the `headers` option in proxy.ws() does NOT reliably work with http-proxy for WS upgrades).
proxy.on("proxyReqWs", (proxyReq, req, socket, options, head) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  debug(`[proxy-ws] WebSocket ${req.url} - injected token (fingerprint: ${tokenLogSafe(OPENCLAW_GATEWAY_TOKEN)})`);
});

// Intercept Control UI pages and inject the gateway token so the browser-side
// JS can authenticate its WebSocket connection.
// The Control UI loads at BOTH "/" and "/openclaw" (confirmed by proxy logs).
// Require auth so the token is never sent to unauthenticated clients.
// The token is fetched by the injected script from /setup/api/gateway-token (same auth).
app.get(["/", "/openclaw", "/openclaw/"], (req, res, next) => {
  if (!checkProxyAuth(req, res)) return;
  next();
}, async (req, res, next) => {
  if (!isConfigured()) return next();

  try {
    await ensureGatewayRunning();
  } catch {
    return next();
  }

  try {
    const upstream = await fetch(`${GATEWAY_TARGET}${req.originalUrl}`, {
      headers: { Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}` },
      redirect: "follow",
    });

    if (!upstream.ok) return next();

    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return next();

    let html = await upstream.text();

    // Inject a script that fetches the token via authenticated API (never embedded in HTML),
    // then stores it in localStorage/cookies and auto-fills the Gateway Token field.
    // We re-apply the token periodically so we win over React state after redeploy (Control UI
    // may read token before our fetch completes; cookies/localStorage/input must have current token).
    const autoTokenScript = `
<script data-auto-token>
(function(){
  fetch("/setup/api/gateway-token", { credentials: "same-origin" })
    .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error("auth required")); })
    .then(function(data){ var TOKEN = data.token; if (!TOKEN) return;

  function applyToken() {
    try {
      var keys = ["gateway-token", "gatewayToken", "openclaw-token", "token", "oc:gateway-token", "oc:token", "openclaw-gateway-token"];
      for (var i = 0; i < keys.length; i++) localStorage.setItem(keys[i], TOKEN);
    } catch(e) {}
    try {
      document.cookie = "token=" + TOKEN + "; path=/; SameSite=Lax";
      document.cookie = "gateway-token=" + TOKEN + "; path=/; SameSite=Lax";
    } catch(e) {}
  }
  applyToken();

  var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  function fill() {
    var inputs = document.querySelectorAll("input");
    var filled = false;
    for (var j = 0; j < inputs.length; j++) {
      var el = inputs[j];
      var ctx = "";
      var parent = el.closest("label, [class*=field], [class*=form-group]");
      if (parent) ctx += " " + parent.textContent.toLowerCase();
      var prev = el.previousElementSibling;
      if (prev) ctx += " " + prev.textContent.toLowerCase();
      ctx += " " + (el.placeholder || "").toLowerCase() + " " + (el.getAttribute("aria-label") || "").toLowerCase();
      var val = (el.value || "").trim();
      var isTokenField = (ctx.includes("gateway token") || ctx.includes("token")) && !ctx.includes("session") && !ctx.includes("url") && !ctx.includes("password") && !ctx.includes("websocket");
      if (val === "OPENCLAW_GATEWAY_TOKEN") isTokenField = true;
      if (isTokenField) {
        if (val !== TOKEN) {
          nativeSetter.call(el, TOKEN);
          el.dispatchEvent(new Event("input", {bubbles:true}));
          el.dispatchEvent(new Event("change", {bubbles:true}));
          filled = true;
        }
        try { el.setAttribute("type", "password"); } catch(e) {}
      }
    }
    if (filled) {
      var btns = document.querySelectorAll("button");
      for (var k = 0; k < btns.length; k++) {
        if (btns[k].textContent.trim().toLowerCase() === "connect") {
          setTimeout(function(){ btns[k].click(); }, 500);
          break;
        }
      }
    }
    return filled;
  }
  function tryFill() {
    if (!fill()) {
      var obs = new MutationObserver(function(){ if (fill()) obs.disconnect(); });
      obs.observe(document.documentElement, {childList:true, subtree:true});
      setTimeout(function(){ obs.disconnect(); }, 20000);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryFill);
  } else {
    tryFill();
  }
  var applyCount = 0;
  var interval = setInterval(function(){
    applyToken();
    fill();
    if (++applyCount >= 24) clearInterval(interval);
  }, 500);
  }).catch(function(){});
})();
</script>`;

    // Inject before </head> or at end of <body>
    if (html.includes("</head>")) {
      html = html.replace("</head>", autoTokenScript + "\n</head>");
    } else if (html.includes("</body>")) {
      html = html.replace("</body>", autoTokenScript + "\n</body>");
    } else {
      html += autoTokenScript;
    }

    res.type("text/html").send(html);
  } catch (err) {
    console.error(`[control-ui] Token injection failed: ${err.message}`);
    return next(); // Fall through to normal proxy
  }
});

app.use(async (req, res) => {
  // Require authentication before proxying to gateway (prevents unauthenticated access).
  if (!checkProxyAuth(req, res)) return;

  // If not configured, either show auto-onboard progress or redirect to /setup.
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    if (onboardingInProgress) {
      return res
        .status(503)
        .type("text/html")
        .send(
          '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Setting up...</title></head>' +
            '<body style="background:#050810;color:#fff;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">' +
            '<div style="text-align:center"><h2>Setting up your bot...</h2>' +
            "<p>Auto-configuration is in progress. This page will refresh automatically.</p>" +
            "</div></body></html>",
        );
    }
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning();
    } catch (err) {
      return res
        .status(503)
        .type("text/plain")
        .send(`Gateway not ready: ${String(err)}`);
    }
  }

  // Proxy to gateway (auth token injected via proxyReq event)
  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

// Create HTTP server from Express app
const server = app.listen(PORT, () => {
  console.log(`[wrapper] listening on port ${PORT}`);
  console.log(`[wrapper] setup wizard: http://localhost:${PORT}/setup`);
  console.log(`[wrapper] configured: ${isConfigured()}`);

  // If env vars changed since last auto-onboard (e.g. user fixed wrong keys and redeployed),
  // remove only the config file and re-onboard so the new values take effect.
  // We do NOT touch the workspace or memory — only openclaw.json (and the fingerprint file) is removed.
  if (isConfigured() && shouldReOnboardDueToEnvChange()) {
    console.log(
      "[wrapper] Env vars changed since last auto-onboard — re-onboarding with current Variables...",
    );
    try {
      fs.unlinkSync(configPath()); // openclaw.json only; workspace and state (memory, etc.) are preserved
      try {
        fs.unlinkSync(AUTO_ONBOARD_FINGERPRINT_FILE);
      } catch {
        /* ignore */
      }
    } catch (e) {
      console.error(`[wrapper] Failed to remove old config: ${e.message}`);
    }
    autoOnboard().catch((err) => {
      console.error(`[wrapper] Re-onboard failed: ${err}`);
    });
  } else if (canAutoOnboard()) {
    // Zero-touch deployment: auto-configure from environment variables.
    console.log("[wrapper] Auto-onboarding from environment variables...");
    autoOnboard().catch((err) => {
      console.error(`[wrapper] Auto-onboard failed: ${err}`);
    });
  } else if (isConfigured()) {
    // Already configured from a previous deploy: run bootstrap to sync
    // configs (mcporter, workspace patches) then start gateway.
    console.log("[wrapper] Already configured, syncing configs and starting gateway...");
    try { bootstrapOpenClaw(); } catch (err) {
      console.error(`[wrapper] Bootstrap sync error (non-fatal): ${err}`);
    }
    ensureGatewayRunning().catch((err) => {
      console.error(`[wrapper] Gateway startup failed: ${err}`);
    });
  }
});

// Handle WebSocket upgrades
server.on("upgrade", async (req, socket, head) => {
  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  // Require same Basic auth as proxy so WebSocket connections are protected.
  if (!SETUP_PASSWORD) {
    socket.destroy();
    return;
  }
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    socket.destroy();
    return;
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  if (!secureCompare(password, SETUP_PASSWORD)) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch {
    socket.destroy();
    return;
  }

  // Pass token via Authorization header only; do not put it in the URL (avoids
  // logging in access logs, load balancers, browser history, referrers).
  debug(`[ws-upgrade] Proxying WebSocket upgrade for ${req.url}`);

  proxy.ws(req, socket, head, {
    target: GATEWAY_TARGET,
    headers: {
      Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
    },
  });
});

process.on("SIGTERM", () => {
  // Best-effort shutdown
  try {
    if (gatewayProc) gatewayProc.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(0);
});
