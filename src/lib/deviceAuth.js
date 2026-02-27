/**
 * Device auth helpers for newer OpenClaw builds (e.g. v2026.2.26).
 * Auto-approve loopback operator devices so internal clients (cron, sessions, tools)
 * don't get stuck on "pairing required" while still keeping pairing for remote devices.
 */

import { runCmd } from "./runCmd.js";

/**
 * Auto-approve the latest pending loopback operator device, if any.
 * Intended to be called a few seconds after startup, once the gateway is running.
 */
export async function autoApprovePendingOperatorDevices() {
  try {
    const list = await runCmd("openclaw", ["devices", "list", "--json"]);
    if (list.code !== 0) {
      console.log(
        `[deviceAuth] devices list failed: exit=${list.code} output=${list.output.trim()}`
      );
      return;
    }

    let devices;
    try {
      devices = JSON.parse(list.output);
    } catch (err) {
      console.log(
        `[deviceAuth] devices list JSON parse failed: ${String(err)}\n${list.output}`
      );
      return;
    }
    if (!Array.isArray(devices) || devices.length === 0) return;

    const isLoopback = (remote) =>
      remote === "127.0.0.1" ||
      remote === "::1" ||
      remote === "::ffff:127.0.0.1";

    const pendingLoopbackOperators = devices.filter((d) => {
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

    if (pendingLoopbackOperators.length === 0) return;

    // Pick the most recent pending loopback operator (by createdAt / lastSeen / array order).
    const pickLatest = (items) => {
      const withTime = items
        .map((d) => {
          const created = d.createdAt || d.created_at || d.requestedAt;
          const lastSeen = d.lastSeen || d.last_seen;
          const t = Date.parse(lastSeen || created || "");
          return { d, t: Number.isFinite(t) ? t : 0 };
        })
        .sort((a, b) => a.t - b.t);
      return (withTime[withTime.length - 1] || {}).d || items[items.length - 1];
    };

    const latest = pickLatest(pendingLoopbackOperators);
    const requestId =
      latest.requestId ||
      latest.request_id ||
      latest.id ||
      latest.deviceId ||
      latest.device_id;
    if (!requestId) {
      console.log(
        "[deviceAuth] Pending loopback operator found but no requestId field; skipping auto-approve"
      );
      return;
    }

    console.log(
      `[deviceAuth] Auto-approving loopback operator device requestId=${requestId}`
    );
    const approve = await runCmd("openclaw", [
      "devices",
      "approve",
      String(requestId),
    ]);
    console.log(
      `[deviceAuth] devices approve exit=${approve.code} output=${approve.output.trim()}`
    );
  } catch (err) {
    console.log(`[deviceAuth] auto-approve failed: ${String(err)}`);
  }
}

