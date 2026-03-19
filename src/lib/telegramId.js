/**
 * Shared Telegram user-ID resolution and caching.
 */

import fs from "node:fs";
import path from "node:path";
import { TELEGRAM_CHAT_ID_FILE } from "./config.js";

const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR?.trim() || "/data/workspace";

/**
 * Synchronously read cached Telegram numeric user ID from disk.
 * @returns {string} numeric ID or ""
 */
export function readCachedTelegramId() {
  try {
    const id = fs.readFileSync(TELEGRAM_CHAT_ID_FILE, "utf8").trim();
    return /^\d+$/.test(id) ? id : "";
  } catch {
    return "";
  }
}

/**
 * Synchronously write a numeric Telegram user ID to the cache file.
 * @param {string} id
 */
export function writeCachedTelegramId(id) {
  if (!id || !/^\d+$/.test(String(id))) return;
  fs.writeFileSync(TELEGRAM_CHAT_ID_FILE, String(id), "utf8");
}

/**
 * Read the Telegram chat ID from USER.md (written during onboarding).
 * Format: "- Chat ID: 1234567890"
 * @returns {string} numeric chat ID or ""
 */
export function readChatIdFromUserMd() {
  try {
    const userMdPath = path.join(WORKSPACE_DIR, "USER.md");
    const content = fs.readFileSync(userMdPath, "utf8");
    const match = content.match(/^- Chat ID:\s*(\d+)/m);
    if (match) {
      return match[1];
    }
  } catch {
    // USER.md doesn't exist or isn't readable
  }
  return "";
}

/**
 * Discover the Telegram user ID from the most recent bot update, without requiring
 * a known username. Useful when TELEGRAM_USERNAME is not set but the user has already
 * messaged the bot.
 * @param {string} botToken
 * @returns {Promise<string>} numeric user ID or ""
 */
export async function discoverTelegramUserFromUpdates(botToken) {
  if (!botToken) return "";
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`);
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/getUpdates?limit=100`
    );
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result) || data.result.length === 0) {
      console.log("[telegram] discoverTelegramUserFromUpdates: no updates available");
      return "";
    }

    for (let i = data.result.length - 1; i >= 0; i--) {
      const update = data.result[i];
      const chat =
        update.message?.chat ||
        update.edited_message?.chat ||
        update.my_chat_member?.chat ||
        update.chat_member?.chat;
      const from =
        update.message?.from ||
        update.edited_message?.from ||
        update.my_chat_member?.from;
      const id = chat?.id || from?.id;
      if (id) {
        const idStr = String(id);
        writeCachedTelegramId(idStr);
        const username = from?.username || chat?.username || "";
        console.log(
          `[telegram] Discovered user from recent update: ${idStr}${username ? ` (@${username})` : ""}`
        );
        return idStr;
      }
    }
    console.log("[telegram] discoverTelegramUserFromUpdates: updates had no chat/user IDs");
  } catch (err) {
    console.warn(`[telegram] discoverTelegramUserFromUpdates error: ${err.message}`);
  }
  return "";
}

/**
 * Resolve a Telegram @username to a numeric user ID via Bot API getUpdates.
 * If the username is already numeric, returns it directly.
 * On success, also writes the ID to the cache file.
 * @param {string} botToken
 * @param {string} username - may include leading @
 * @returns {Promise<string>} numeric ID or ""
 */
export async function resolveTelegramUserId(botToken, username) {
  if (!botToken || !username) {
    console.warn(`[telegram] resolveTelegramUserId error: botToken or username is not set`);
    return "";
  }

  const clean = username.replace(/^@/, "").trim();
  if (!clean) {
    console.warn(`[telegram] resolveTelegramUserId error: username is empty`);
    return "";
  }

  // Already numeric — use directly
  if (/^\d+$/.test(clean)) {
    console.log(`[telegram] resolveTelegramUserId: username is already numeric: ${clean}`);
    writeCachedTelegramId(clean);
    return clean;
  }

  try {
    // Clear any existing webhook — getUpdates returns empty while a webhook is active
    const whRes = await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`);
    const whData = await whRes.json().catch(() => ({}));
    console.log(`[telegram] deleteWebhook result: ${JSON.stringify(whData)}`);
    if (!whData.ok) {
      console.warn(`[telegram] deleteWebhook failed — getUpdates may return empty`);
    }

    // Brief delay to let Telegram process the webhook deletion
    await new Promise((r) => setTimeout(r, 1000));

    // Retry loop: old gateway polling (from previous deploy) may still be consuming updates
    let data = { ok: false, result: [] };
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, 2000));
      const res = await fetch(
        `https://api.telegram.org/bot${botToken}/getUpdates?limit=100`
      );
      data = await res.json();
      console.log(`[telegram] getUpdates attempt ${attempt}: ${data.result?.length ?? 0} updates`);
      if (data.ok && Array.isArray(data.result) && data.result.length > 0) break;
    }

    if (!data.ok || !Array.isArray(data.result)) return "";

    const lc = clean.toLowerCase();
    console.log(`[telegram] resolveTelegramUserId: searching for username: ${lc}`);
    console.log(`[telegram] resolveTelegramUserId: data.result: ${JSON.stringify(data.result)}`);
    for (const update of data.result) {
      const chat = update.message?.chat || update.my_chat_member?.chat;
      const from = update.message?.from || update.my_chat_member?.from;
      if (chat?.username?.toLowerCase() === lc) {
        console.log(`[telegram] resolveTelegramUserId: found username in chat: ${chat.username}`);
        const id = String(chat.id);
        console.log(`[telegram] resolveTelegramUserId: writing cached ID: ${id}`);
        writeCachedTelegramId(id);
        console.log(`[telegram] Async resolved @${clean} → ${id}`);
        return id;
      }
      if (from?.username?.toLowerCase() === lc) {
        console.log(`[telegram] resolveTelegramUserId: found username in from: ${from.username}`);
        const id = String(chat?.id || from?.id);
        console.log(`[telegram] resolveTelegramUserId: writing cached ID: ${id}`);
        writeCachedTelegramId(id);
        console.log(`[telegram] Async resolved @${clean} → ${id}`);
        return id;
      }
    }
  } catch (err) {
    console.warn(`[telegram] resolveTelegramUserId error: ${err.message}`);
  }

  // Fallback: read from USER.md (persisted from a previous successful resolution)
  const userMdId = readChatIdFromUserMd();
  if (userMdId) {
    console.log(`[telegram] Resolved @${clean} from USER.md → ${userMdId}`);
    writeCachedTelegramId(userMdId);
    return userMdId;
  }

  return "";
}
