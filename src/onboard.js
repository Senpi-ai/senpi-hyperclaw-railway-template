/**
 * Auto-onboarding and Telegram USER.md resolution.
 * Deps: config, gateway (clawArgs, ensureGatewayRunning, restartGateway), runCmd, tokenLogSafe, bootstrapOpenClaw.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  STATE_DIR,
  WORKSPACE_DIR,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_USERNAME,
  TELEGRAM_USER_ID,
  AI_PROVIDER,
  AI_API_KEY,
  configPath,
  isConfigured,
  PROVIDER_TO_AUTH_CHOICE,
  INTERNAL_GATEWAY_PORT,
  OPENCLAW_NODE,
} from "./lib/config.js";
import { tokenLogSafe } from "./lib/auth.js";
import { runCmd } from "./lib/runCmd.js";
import { clawArgs, ensureGatewayRunning, restartGateway } from "./gateway.js";
import { bootstrapOpenClaw } from "./bootstrap.mjs";

const AUTO_ONBOARD_FINGERPRINT_FILE = path.join(
  STATE_DIR,
  ".auto-onboard-env.fingerprint"
);

let onboardingInProgress = false;

export function isOnboardingInProgress() {
  return onboardingInProgress;
}

export function envFingerprintForOnboard() {
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

export function shouldReOnboardDueToEnvChange() {
  try {
    const stored = fs.readFileSync(AUTO_ONBOARD_FINGERPRINT_FILE, "utf8").trim();
    const current = envFingerprintForOnboard();
    return stored !== "" && current !== stored;
  } catch {
    return false;
  }
}

export function canAutoOnboard() {
  return (
    !isConfigured() &&
    AI_PROVIDER &&
    AI_API_KEY &&
    !!PROVIDER_TO_AUTH_CHOICE[AI_PROVIDER]
  );
}

/**
 * Resolve Telegram user to chat ID and write USER.md. Preserves existing sections (e.g. Trading Profile).
 */
export async function resolveTelegramAndWriteUserMd() {
  let chatId = "";
  let username = "";
  let updateList = [];

  if (!TELEGRAM_BOT_TOKEN) {
    console.log("[telegram] No TELEGRAM_BOT_TOKEN, skipping USER.md write");
    return;
  }

  const userMdPath = path.join(WORKSPACE_DIR, "USER.md");

  let existingExtra = "";
  let existingChatId = "";
  try {
    const existing = fs.readFileSync(userMdPath, "utf8");
    const chatIdMatch = existing.match(/^- Chat ID:\s*(\d+)/m);
    if (chatIdMatch) {
      existingChatId = chatIdMatch[1];
    }
    const telegramSectionEnd = existing.search(/\n## (?!Telegram\b)/);
    if (telegramSectionEnd !== -1) {
      existingExtra = existing.slice(telegramSectionEnd);
    }
  } catch {
    // No existing USER.md
  }

  try {
    const meRes = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`
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
        console.log(
          `[telegram] Using TELEGRAM_USERNAME (numeric): ${chatId}`
        );
      } else {
        username = TELEGRAM_USERNAME.replace(/^@/, "").toLowerCase();
        const updatesRes = await fetch(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=100`
        );
        const updates = await updatesRes.json();
        updateList = (updates.ok && updates.result) || [];

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
          console.log(`[telegram] Resolved @${username} → chat ID ${chatId}`);
        } else if (existingChatId) {
          chatId = existingChatId;
          console.log(
            `[telegram] getUpdates empty — reusing previously resolved chat ID ${chatId} for @${username}`
          );
        } else {
          console.warn(
            `[telegram] Could not resolve @${username} — the user must message the bot first so the chat ID can be discovered.`
          );
        }
      }
    }

    if (!chatId) {
      if (updateList.length === 0) {
        const updatesRes = await fetch(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=50`
        );
        const updates = await updatesRes.json();
        updateList = (updates.ok && updates.result) || [];
      }
      for (let i = updateList.length - 1; i >= 0; i--) {
        const update = updateList[i];
        const chat =
          update.message?.chat ||
          update.edited_message?.chat ||
          update.my_chat_member?.chat ||
          update.chat_member?.chat;
        if (chat?.id) {
          chatId = String(chat.id);
          const from =
            update.message?.from ||
            update.edited_message?.from ||
            update.my_chat_member?.from;
          if (from?.username)
            username = from.username.replace(/^@/, "").toLowerCase();
          console.log(
            `[telegram] Using chat_id from most recent update: ${chatId}` +
              (username ? ` (@${username})` : "")
          );
          break;
        }
      }
      if (!chatId && updateList.length > 0) {
        console.warn(
          "[telegram] getUpdates had updates but none contained a chat id"
        );
      }
    }
  } catch (err) {
    console.error(`[telegram] Error resolving user: ${err.message}`);
  }

  if (!chatId && existingChatId) {
    chatId = existingChatId;
    console.log(
      `[telegram] Falling back to previously resolved chat ID ${chatId}`
    );
  }

  const lines = ["# User"];
  if (chatId) {
    lines.push("");
    lines.push(`## Telegram`);
    lines.push(`- Chat ID: ${chatId}`);
    if (username) lines.push(`- Username: @${username}`);
    lines.push("");
    lines.push(
      "When sending Telegram messages to this user, " +
        `use target \`telegram:${chatId}\` (numeric chat ID, not @username).`
    );
  } else if (username) {
    lines.push("");
    lines.push(`## Telegram`);
    lines.push(`- Username: @${username}`);
    lines.push(
      `- No chat ID yet — user must message the bot first (e.g. send /start).`
    );
    lines.push("");
    lines.push(
      "Do not send Telegram messages until a chat ID is set. Do not use telegram:unknown or @unknown as a target."
    );
  } else {
    lines.push("");
    lines.push(`## Telegram`);
    lines.push(
      `- No chat ID or username. Set TELEGRAM_USERNAME and message the bot, or send /start before deploy.`
    );
    lines.push("");
    lines.push(
      "Do not send Telegram messages until USER.md has a numeric Chat ID. Do not use telegram:unknown as a target."
    );
  }
  if (existingExtra) {
    lines.push(existingExtra);
  } else {
    lines.push("");
  }

  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.writeFileSync(userMdPath, lines.join("\n"));
  console.log(`[telegram] Wrote ${userMdPath}`);
}

/**
 * Build CLI args for openclaw onboard --non-interactive.
 * @param {{ flow?: string, authChoice?: string, authSecret?: string, [k: string]: any }} payload
 * @returns {string[]}
 */
export function buildOnboardArgs(payload, gatewayToken) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    gatewayToken,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

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
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

/**
 * Run auto-onboarding from env vars. Idempotent when already configured or already in progress.
 * @param {string} gatewayToken - OPENCLAW_GATEWAY_TOKEN
 */
export async function autoOnboard(gatewayToken) {
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_USERNAME) {
    await resolveTelegramAndWriteUserMd();
  }

  if (!canAutoOnboard()) {
    if (!isConfigured() && (AI_PROVIDER || AI_API_KEY)) {
      console.log(
        "[auto-onboard] Cannot auto-onboard: missing or invalid env vars"
      );
    }
    return;
  }

  if (onboardingInProgress) {
    console.log("[auto-onboard] Already in progress, skipping");
    return;
  }

  onboardingInProgress = true;

  try {
    console.log("[auto-onboard] ========== AUTO-ONBOARDING START ==========");
    console.log(`[auto-onboard] AI Provider: ${AI_PROVIDER}`);
    console.log(
      `[auto-onboard] Telegram: ${TELEGRAM_BOT_TOKEN ? "configured" : "not set"}`
    );

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const authChoice = PROVIDER_TO_AUTH_CHOICE[AI_PROVIDER];
    const payload = {
      flow: "quickstart",
      authChoice,
      authSecret: AI_API_KEY,
    };

    const onboardArgs = buildOnboardArgs(payload, gatewayToken);
    const autoOnboardCmdForLog = onboardArgs
      .join(" ")
      .replace(AI_API_KEY, "***")
      .replace(gatewayToken, "<redacted>");
    console.log(`[auto-onboard] Running: openclaw ${autoOnboardCmdForLog}`);

    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));
    const ok = onboard.code === 0 && isConfigured();

    if (!ok) {
      console.error(
        `[auto-onboard] Onboarding failed (exit code: ${onboard.code})`
      );
      console.error(`[auto-onboard] Output: ${onboard.output}`);
      return;
    }

    console.log("[auto-onboard] Onboarding succeeded");

    console.log("[auto-onboard] Syncing gateway configuration...");
    await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "gateway.mode", "local"])
    );
    await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "gateway.auth.mode", "token"])
    );

    const setTokenResult = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "gateway.auth.token", gatewayToken])
    );

    if (setTokenResult.code !== 0) {
      console.error(
        `[auto-onboard] Failed to set gateway token: ${setTokenResult.output}`
      );
    }

    try {
      const config = JSON.parse(fs.readFileSync(configPath(), "utf8"));
      const configToken = config?.gateway?.auth?.token;
      if (configToken !== gatewayToken) {
        console.error("[auto-onboard] Token mismatch after sync!");
        throw new Error(
          `Token mismatch: wrapper fingerprint ${tokenLogSafe(gatewayToken)} vs config ${tokenLogSafe(configToken)}`
        );
      }
      console.log("[auto-onboard] Token sync verified");
    } catch (err) {
      console.error(`[auto-onboard] Token verification failed: ${err}`);
      throw err;
    }

    await runCmd(
      OPENCLAW_NODE,
      clawArgs(["config", "set", "gateway.bind", "loopback"])
    );
    await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "config",
        "set",
        "gateway.port",
        String(INTERNAL_GATEWAY_PORT),
      ])
    );
    await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "config",
        "set",
        "--json",
        "gateway.controlUi.allowInsecureAuth",
        "true",
      ])
    );
    await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "config",
        "set",
        "--json",
        "gateway.controlUi.dangerouslyDisableDeviceAuth",
        "true",
      ])
    );
    await runCmd(
      OPENCLAW_NODE,
      clawArgs([
        "config",
        "set",
        "--json",
        "gateway.trustedProxies",
        JSON.stringify(["127.0.0.1", "::1"]),
      ])
    );

    if (TELEGRAM_BOT_TOKEN) {
      console.log("[auto-onboard] Configuring Telegram channel...");
      const channelsHelp = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["channels", "add", "--help"])
      );
      const helpText = channelsHelp.output || "";

      if (!helpText.includes("telegram")) {
        console.log(
          "[auto-onboard] Telegram not supported by this build, skipping"
        );
      } else {
        const allowFrom =
          TELEGRAM_USER_ID && /^\d+$/.test(TELEGRAM_USER_ID)
            ? [TELEGRAM_USER_ID]
            : ["*"];
        const cfgObj = {
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom,
          botToken: TELEGRAM_BOT_TOKEN,
          groupPolicy: "allowlist",
          streamMode: "partial",
          blockStreaming: true,
        };
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "--json",
            "channels.telegram",
            JSON.stringify(cfgObj),
          ])
        );
        console.log(
          `[auto-onboard] Telegram config set: exit=${set.code} output=${set.output.trim()}`
        );

        await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "--json",
            "plugins.entries.telegram",
            JSON.stringify({ enabled: true }),
          ])
        );

        console.log("[auto-onboard] Running doctor --fix to finalize config...");
        const doctor = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["doctor", "--fix"])
        );
        console.log(
          `[auto-onboard] doctor --fix: exit=${doctor.code} output=${doctor.output.trim()}`
        );
      }
    }

    bootstrapOpenClaw();
    console.log("[auto-onboard] Bootstrap complete");

    await restartGateway(gatewayToken);
    console.log("[auto-onboard] Gateway started and ready");

    try {
      fs.writeFileSync(
        AUTO_ONBOARD_FINGERPRINT_FILE,
        envFingerprintForOnboard(),
        "utf8"
      );
      console.log("[auto-onboard] Stored env fingerprint for redeploy detection");
    } catch (e) {
      console.warn(
        "[auto-onboard] Could not write fingerprint file:",
        e.message
      );
    }

    console.log(
      "[auto-onboard] ========== AUTO-ONBOARDING COMPLETE =========="
    );
  } catch (err) {
    console.error(`[auto-onboard] Error: ${err}`);
    console.error(
      "[auto-onboard] Auto-onboarding failed. Visit /setup to configure manually."
    );
  } finally {
    onboardingInProgress = false;
  }
}

export { AUTO_ONBOARD_FINGERPRINT_FILE };
