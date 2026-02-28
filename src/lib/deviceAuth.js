/**
 * Device auth helpers for newer OpenClaw builds (e.g. v2026.2.22+).
 * Continuously auto-approve loopback operator devices so internal clients
 * (cron, sessions, tools, Control UI) never get stuck on "pairing required".
 */

import { runCmd } from "./runCmd.js";

let _loopRunning = false;
let _timer = null;

// Burst phase: aggressive polling for the first ~60s after gateway start,
// then settle into a steady cadence for ongoing maintenance.
const BURST_INTERVALS_MS = [
  3_000, 3_000, 4_000, 5_000, 5_000, 10_000, 15_000, 15_000,
];
const STEADY_INTERVAL_MS = 60_000;

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
      // Non-zero exit is expected while gateway is still booting; only log
      // once to avoid noisy logs.
      if (!list.output.includes("gateway connect failed")) {
        console.log(
          `[deviceAuth] devices list failed: exit=${list.code} output=${list.output.trim()}`
        );
      }
      return 0;
    }

    let devices;
    try {
      devices = JSON.parse(list.output);
    } catch {
      // Partial / non-JSON output during startup — ignore silently.
      return 0;
    }
    if (!Array.isArray(devices) || devices.length === 0) return 0;

    const isLoopback = (remote) =>
      remote === "127.0.0.1" ||
      remote === "::1" ||
      remote === "::ffff:127.0.0.1";

    const pending = devices.filter((d) => {
      const status = (d.status || d.state || "").toLowerCase();
      const role = (d.role || "").toLowerCase();
      const remote = d.remote || d.remoteAddr || d.ip || "";
      return (
        status === "pending" &&
        role === "operator" &&
        typeof remote === "string" &&
        isLoopback(remote)
      );
    });

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
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
}
