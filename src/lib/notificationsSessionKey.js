/**
 * Resolve the OpenClaw notifications session key — a stable identifier
 * the orchestrator passes through to the agent-bridge as
 * `gateway.notificationsSessionKey` in `GET /v1/agents/me`.
 *
 * Stability rule: the value MUST survive container restarts. If we
 * generated a fresh in-memory UUID on every boot, every Railway
 * redeploy would invalidate the orchestrator's persisted value and
 * break the bridge's notifications stream. We mirror the
 * `<STATE_DIR>/gateway.token` pattern in `src/lib/auth.js`:
 *
 *   - If `<stateDir>/notifications-session-key` exists with a non-empty
 *     payload, return that.
 *   - Otherwise mint a UUIDv4, persist (mkdir -p + write with 0600),
 *     return.
 *
 * An operator can pre-seed the file to pin a specific value (handy
 * for migration scenarios).
 *
 * Pure-ish: `stateDir` is the only input. Exported for unit testing
 * against a tmpdir.
 *
 * @param {string} stateDir Absolute path of the state directory
 *                          (typically `OPENCLAW_STATE_DIR` =
 *                          `/data/.openclaw`).
 * @returns {string}
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FILE_NAME = "notifications-session-key";

export function resolveNotificationsSessionKey(stateDir) {
  const filePath = path.join(stateDir, FILE_NAME);

  // Read-back path: honour existing files (operator pin OR prior boot).
  try {
    const existing = fs.readFileSync(filePath, "utf8").trim();
    if (existing) return existing;
  } catch (err) {
    if (err.code !== "ENOENT") {
      // Surface unexpected errors instead of silently regenerating —
      // a partial write left behind by a crashed previous boot would
      // be invisible otherwise.
      throw err;
    }
  }

  // Mint + persist.
  const key = crypto.randomUUID();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(filePath, key, { encoding: "utf8", mode: 0o600 });
  return key;
}
