/**
 * Device auth helpers for newer OpenClaw builds (e.g. v2026.2.22+).
 * Continuously auto-approve loopback operator devices so internal clients
 * (cron, sessions, tools, Control UI) never get stuck on "pairing required".
 *
 * v2026.5.x compatibility: THREE bugs needed fixing on the upgrade.
 *
 * (1) `openclaw devices list --json` shape changed from a flat array to
 *     `{ pending: [...], paired: [...] }`. The old `JSON.parse(...).filter(...)`
 *     silently no-op'd against the object, so pending requests stayed
 *     un-approved. Fixed by `extractPendingRequests` (both shapes) +
 *     `isLoopbackOperatorRequest` (filter predicate) — both pure, both
 *     exported for unit testing.
 *
 * (2) `openclaw devices approve <reqId>` cannot self-approve scope-upgrades
 *     on v2026.5.x because the new scope-escalation check in
 *     `resolveApprovePairingScopesForRequest` (`cli/devices-cli.ts:290`)
 *     refuses approvals whose target scopes exceed the CALLER device's own
 *     scopes — and the wrapper's auto-paired CLI device only holds
 *     `operator.pairing`. The built-in local-file fallback in openclaw
 *     (`approvePairingWithFallback`) only triggers on "pairing required",
 *     not on "scope upgrade pending approval", so the wrapper subprocess
 *     dead-loops on a managed-agent box with no human approver.
 *
 *     Fix: import `approveDevicePairing()` directly from openclaw's plugin-SDK
 *     and call it with `callerScopes: ["operator.admin"]` (the documented
 *     local-trust escape hatch). The wrapper has filesystem access to
 *     `~/.openclaw/devices/` by design, so bypassing the gateway RPC here
 *     is not a privilege bump. The legacy CLI-subprocess path is kept as
 *     a fallback so a misconfigured `OPENCLAW_ENTRY` does not strand the
 *     wrapper completely. See `devicePairingNode.js`.
 *
 * (3) `openclaw devices list --json` ITSELF triggers a scope-upgrade on
 *     v2026.5.x because `device.pair.list` is a pairing method (least-
 *     privilege scope = `operator.pairing`) and the wrapper's CLI device
 *     only holds `operator.read`. The CLI command prints the gateway
 *     error to stderr followed by local-fallback JSON to stdout. The
 *     wrapper's `runCmd()` merges both streams; `JSON.parse(out)` fails
 *     on the error line and the catch block silently returns 0 pending —
 *     so even with fix (2) in place, the auto-approve loop NEVER sees
 *     the pending requests it should be approving. End-to-end smoke
 *     testing on a real v2026.5.x deploy surfaced this; the unit tests
 *     for fixes (1) and (2) passed but the loop was a no-op in production.
 *
 *     Fix: import `listDevicePairing()` directly from openclaw's plugin-SDK,
 *     matching the same local-trust + Node-import pattern as (2). The CLI
 *     subprocess remains as a fallback.
 */

import { runCmd } from "./runCmd.js";
import {
  approveDeviceLocally,
  classifyLocalApproveResult,
  listDevicePairingLocally,
} from "./devicePairingNode.js";

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
    // Primary path: direct Node import of openclaw's `listDevicePairing()`.
    // Required on v2026.5.x because `openclaw devices list --json` itself
    // triggers a scope-upgrade prompt — `device.pair.list` is a pairing
    // method requiring `operator.pairing` and the wrapper's auto-paired
    // CLI device only holds `operator.read`. The subprocess prints the
    // gateway error to stderr and the local-fallback JSON to stdout;
    // `runCmd` merges both streams, so `JSON.parse(out)` fails on the
    // error line and the wrapper silently returns 0 pending — the
    // auto-approve loop never sees the requests it should be approving.
    // See devicePairingNode.js for the full rationale.
    let parsed;
    try {
      parsed = await listDevicePairingLocally();
    } catch (err) {
      // Fallback: legacy CLI subprocess. Preserves v2026.2.x behavior and
      // provides a safety net if `OPENCLAW_ENTRY` is misconfigured or the
      // openclaw bundle layout changes. Same parse-failure quirk applies
      // here — if the CLI prints mixed stdout/stderr the parse will fail
      // and the tick is a no-op, but at least we tried.
      const msg = err instanceof Error ? err.message : String(err);
      _consecutiveFailures++;
      if (_consecutiveFailures <= 3) {
        console.log(
          `[deviceAuth] local-node-import list failed (${msg.slice(0, 200)}), falling back to CLI subprocess`
        );
      } else if (_consecutiveFailures === 4) {
        console.log(
          `[deviceAuth] local-node-import list still failing (${_consecutiveFailures} consecutive), suppressing further logs`
        );
      }

      const list = await runCmd("openclaw", ["devices", "list", "--json"]);
      if (list.code !== 0) {
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
        }
        return 0;
      }

      try {
        parsed = JSON.parse(list.output);
      } catch {
        // Partial / non-JSON output during startup or scope-upgrade mixed
        // stdout/stderr — ignore silently. The Node-import primary path
        // above is the v2026.5.x escape hatch from this exact failure mode.
        return 0;
      }
    }

    if (_consecutiveFailures > 0) {
      console.log(
        `[deviceAuth] device pairing list recovered after ${_consecutiveFailures} failure(s)`
      );
      _consecutiveFailures = 0;
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

      // Primary path: direct Node import of openclaw's `approveDevicePairing`
      // with `callerScopes: ["operator.admin"]`. Bypasses gateway RPC + CLI
      // subprocess, so it is not subject to v2026.5.x's scope-escalation
      // check (`resolveApprovePairingScopesForRequest`) — which would
      // otherwise refuse to approve any request whose target scopes exceed
      // the wrapper CLI device's own `operator.pairing`-only scope set.
      // See devicePairingNode.js for the full rationale.
      try {
        const raw = await approveDeviceLocally(String(requestId));
        const outcome = classifyLocalApproveResult(raw);
        if (outcome.ok) {
          approved++;
          console.log(
            `[deviceAuth] ✓ Approved ${requestId} via local-node-import: ${outcome.detail}`
          );
          continue;
        }
        console.log(
          `[deviceAuth] local-node-import approval did not succeed for ${requestId}: ${outcome.detail} — falling back to CLI subprocess`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Truncated to keep logs readable when stack traces include long paths.
        console.log(
          `[deviceAuth] local-node-import approval threw for ${requestId}: ${msg.slice(0, 300)} — falling back to CLI subprocess`
        );
      }

      // Fallback: legacy CLI subprocess. On v2026.2.x this still works
      // (no scope-escalation enforcement). On v2026.5.x it is expected to
      // fail with "scope upgrade pending approval" when the wrapper CLI
      // device only holds operator.pairing — that is precisely why the
      // primary path above exists. Kept as a safety net so a misconfigured
      // OPENCLAW_ENTRY or a future bundle-layout change does not strand
      // the wrapper completely.
      const result = await runCmd("openclaw", [
        "devices",
        "approve",
        String(requestId),
      ]);
      if (result.code === 0) {
        approved++;
        console.log(
          `[deviceAuth] ✓ Approved ${requestId} via cli-subprocess: ${result.output.trim()}`
        );
      } else {
        console.log(
          `[deviceAuth] ✗ approve failed for ${requestId} via cli-subprocess: exit=${result.code} ${result.output.trim()}`
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
