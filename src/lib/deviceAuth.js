/**
 * Device auth helpers for newer OpenClaw builds (e.g. v2026.2.22+).
 * Continuously auto-approve loopback operator devices so internal clients
 * (cron, sessions, tools, Control UI) never get stuck on "pairing required".
 *
 * v2026.5.x compatibility: `openclaw devices list --json` now returns
 *   { "pending": [...], "paired": [...] }
 * instead of a flat array. The old wrapper code did `JSON.parse(output).filter(...)`
 * which silently no-op'd on the object (Array.isArray check returned false),
 * so any "scope upgrade" or "re-approval" pending request stayed unapproved.
 * Manifestation: agent's exec tool failing with `scope upgrade pending approval`
 * on the first command that needed scopes beyond `operator.pairing` — operator
 * had to ssh in and run `openclaw devices clear --yes`.
 *
 * Fix: parse both shapes (`extractPendingRequests`), filter via the same
 * predicate (`isLoopbackOperatorRequest`) — exported for unit testing.
 */

import { runCmd } from "./runCmd.js";

// ─── Pure helpers (exported for unit tests) ────────────────────────────────

/**
 * Pull the pending-requests array out of whatever shape OpenClaw emits.
 *
 * v2026.5.x: `{ pending: [...], paired: [...] }`
 * v2026.2.x and earlier: flat `[ { ...device } ]` array — filter by
 * `status === "pending"` so we don't try to "approve" already-paired entries.
 *
 * Returns an empty array on null/undefined/malformed input — the caller
 * treats "nothing to do" as success, not an error.
 *
 * @param {unknown} parsed
 * @returns {object[]}
 */
export function extractPendingRequests(parsed) {
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return Array.isArray(parsed.pending) ? parsed.pending : [];
  }
  if (Array.isArray(parsed)) {
    return parsed.filter((d) => {
      const status = String(d?.status ?? d?.state ?? "").toLowerCase();
      return status === "pending";
    });
  }
  return [];
}

/**
 * Predicate: is this pending request something we should auto-approve?
 *
 * Yes when:
 *   - has a non-empty `requestId` (otherwise we have nothing to pass to
 *     `openclaw devices approve <requestId>`), AND
 *   - resolved role/roles include "operator" (we never auto-approve viewers
 *     or other roles), AND
 *   - one of:
 *       (a) remoteIp is loopback (127.0.0.1, ::1, ::ffff:127.0.0.1) — older
 *           OpenClaw builds populated this for loopback clients, OR
 *       (b) remoteIp is absent/empty — v2026.5.x's DevicePairingPendingRequest
 *           declares `remoteIp?: string` and the local CLI flow
 *           (clientMode: "cli") doesn't populate it. We accept this as
 *           safe because the gateway binds to loopback only (wrapper
 *           enforces `--bind loopback` in src/gateway.js), so any pending
 *           request — including a scope upgrade with `isRepair: true` —
 *           must have originated from a same-container client.
 *
 * Field-name back-compat: `remoteIp` (v2026.5.x) → `remote` / `remoteAddr` /
 * `ip` (older builds).
 *
 * Note: NO status check here — every entry in the `pending` array is
 * by definition pending. Including "scope upgrade" and "re-approval" kinds.
 * That's what fixes the B1 bug: previously the wrapper filtered by
 * `status === "pending"` literally AND required `remoteIp` to be a
 * populated loopback string. v2026.5.x's CLI pairing flow trips on BOTH
 * constraints. The fix is to drop the literal status check (move to
 * "everything in `pending` is pending") AND to allow missing remoteIp
 * (because the gateway's bind-loopback is the actual security boundary).
 *
 * @param {object} req
 * @returns {boolean}
 */
export function isLoopbackOperatorRequest(req) {
  if (!req || typeof req !== "object") return false;
  const requestId =
    req.requestId ?? req.request_id ?? req.id ?? req.deviceId ?? req.device_id;
  if (!requestId || typeof requestId !== "string") return false;
  const role = String(req.role ?? "").toLowerCase();
  const roles = Array.isArray(req.roles)
    ? req.roles.map((r) => String(r).toLowerCase())
    : [];
  if (role !== "operator" && !roles.includes("operator")) return false;
  const remote = req.remoteIp ?? req.remote ?? req.remoteAddr ?? req.ip;
  // Empty / absent remote → trust the gateway's bind-loopback boundary.
  if (remote === undefined || remote === null || remote === "") return true;
  if (typeof remote !== "string") return false;
  return (
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "::ffff:127.0.0.1"
  );
}

let _loopRunning = false;
let _timer = null;
let _consecutiveFailures = 0;

// Burst phase: aggressive polling for the first ~60s after gateway start,
// then settle into a steady cadence for ongoing maintenance.
const BURST_INTERVALS_MS = [
  3_000, 3_000, 4_000, 5_000, 5_000, 10_000, 15_000, 15_000,
];
const STEADY_INTERVAL_MS = 60_000;

const GATEWAY_NOT_READY_PATTERNS = [
  "gateway connect failed",
  "gateway closed",
  "abnormal closure",
  "1006",
  "1008",
  "ECONNREFUSED",
  "ECONNRESET",
  "Failed to start CLI",
  "connect failed",
  "no close reason",
];

function isGatewayNotReady(output) {
  const text = (output || "").toLowerCase();
  return GATEWAY_NOT_READY_PATTERNS.some((p) => text.includes(p.toLowerCase()));
}

/**
 * List pending loopback operator devices and approve ALL of them.
 * Safe to call repeatedly — no-ops when nothing is pending.
 * Uses the CLI with local-file fallback so it works even when the gateway
 * itself rejects WebSocket connections for pairing.
 */
export async function autoApprovePendingOperatorDevices() {
  try {
    const list = await runCmd("openclaw", ["devices", "list", "--json"]);
    if (list.code !== 0) {
      _consecutiveFailures++;
      if (isGatewayNotReady(list.output)) {
        if (_consecutiveFailures === 1) {
          console.log(
            "[deviceAuth] Gateway not reachable yet, will retry silently"
          );
        }
      } else if (_consecutiveFailures <= 3) {
        console.log(
          `[deviceAuth] devices list failed: exit=${list.code} output=${list.output.trim().slice(0, 200)}`
        );
      } else if (_consecutiveFailures === 4) {
        console.log(
          `[deviceAuth] devices list still failing (${_consecutiveFailures} consecutive), suppressing further logs`
        );
      }
      return 0;
    }

    if (_consecutiveFailures > 0) {
      console.log(
        `[deviceAuth] devices list recovered after ${_consecutiveFailures} failure(s)`
      );
      _consecutiveFailures = 0;
    }

    let parsed;
    try {
      parsed = JSON.parse(list.output);
    } catch {
      // Partial / non-JSON output during startup — ignore silently.
      return 0;
    }

    // v2026.5.x returns `{ pending, paired }`; older builds return a flat
    // array. `extractPendingRequests` normalizes; `isLoopbackOperatorRequest`
    // filters. Both are exported for unit tests — see __tests__/deviceAuth.test.mjs.
    const pending = extractPendingRequests(parsed).filter(
      isLoopbackOperatorRequest,
    );

    if (pending.length === 0) return 0;

    let approved = 0;
    for (const device of pending) {
      const requestId =
        device.requestId ||
        device.request_id ||
        device.id ||
        device.deviceId ||
        device.device_id;
      if (!requestId) {
        // Should never trip — `isLoopbackOperatorRequest` already gated on
        // requestId presence. Keep as defensive guard so a future predicate
        // change doesn't silently spawn approves with `undefined` args.
        console.log(
          `[deviceAuth] Pending loopback operator found but no requestId field; skipping`
        );
        continue;
      }

      console.log(
        `[deviceAuth] Auto-approving loopback operator device requestId=${requestId}`
      );
      const result = await runCmd("openclaw", [
        "devices",
        "approve",
        String(requestId),
      ]);
      if (result.code === 0) {
        approved++;
        console.log(
          `[deviceAuth] ✓ Approved ${requestId}: ${result.output.trim()}`
        );
      } else {
        console.log(
          `[deviceAuth] ✗ approve failed for ${requestId}: exit=${result.code} ${result.output.trim()}`
        );
      }
    }
    return approved;
  } catch (err) {
    console.log(`[deviceAuth] auto-approve error: ${String(err)}`);
    return 0;
  }
}

/**
 * Start a persistent polling loop that auto-approves pending loopback operator
 * devices. Uses an aggressive burst schedule for the first ~60s (internal
 * clients typically connect immediately after gateway startup) and then settles
 * into a once-per-minute cadence to catch stragglers.
 *
 * Idempotent — calling when already running is a no-op.
 */
export function startAutoApprovalLoop() {
  if (_loopRunning) return;
  _loopRunning = true;
  _consecutiveFailures = 0;

  let burstIndex = 0;

  async function tick() {
    if (!_loopRunning) return;

    try {
      await autoApprovePendingOperatorDevices();
    } catch {
      // Errors already logged inside the function.
    }

    if (!_loopRunning) return;

    const delay =
      burstIndex < BURST_INTERVALS_MS.length
        ? BURST_INTERVALS_MS[burstIndex++]
        : STEADY_INTERVAL_MS;

    _timer = setTimeout(tick, delay);
  }

  // First tick immediately.
  tick();
  console.log("[deviceAuth] Auto-approval loop started");
}

/**
 * Stop the polling loop. Safe to call when not running.
 */
export function stopAutoApprovalLoop() {
  _loopRunning = false;
  _consecutiveFailures = 0;
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
}
