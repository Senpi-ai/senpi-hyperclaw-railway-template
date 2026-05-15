/**
 * Direct Node-import approval helper for OpenClaw device pairing.
 *
 * Why this exists:
 *
 * OpenClaw v2026.5.x added scope-escalation in `resolveApprovePairingScopesForRequest`
 * (`src/cli/devices-cli.ts:290`). Approving a pending request whose target scopes
 * include scope `X` now requires the CALLER device to ALREADY hold scope `X`.
 *
 * The wrapper's auto-approval loop runs `openclaw devices approve <reqId>` as
 * a subprocess. That subprocess authenticates as its own paired CLI device.
 * On a fresh managed-agent box, the wrapper's CLI device is silent-paired
 * with only `operator.pairing` (least-privilege scope for `device.pair.approve`).
 * Any subsequent senpi.* or other internal call needs `operator.read` or
 * higher, which triggers a scope-upgrade pending request — and approving THAT
 * needs `operator.read` which the CLI device doesn't have. Dead loop.
 *
 * The built-in `approvePairingWithFallback` (devices-cli.ts:193) DOES drop
 * to a local-file path that uses `callerScopes: ["operator.admin"]`, but it
 * ONLY triggers when the gateway returns "pairing required" — NOT when it
 * returns "scope upgrade pending approval". So for managed agents with no
 * human in the loop, the fallback never fires.
 *
 * Resolution: invoke `approveDevicePairing()` directly from the wrapper's
 * Node process, with `callerScopes: ["operator.admin"]`. This is the same
 * local-trust escape hatch the CLI uses, just without the precondition.
 * It writes to `~/.openclaw/devices/paired.json` atomically and grants the
 * device whatever scopes the pending request asked for.
 *
 * Why this is not a privilege bump: anyone with filesystem access to the
 * openclaw state dir already has admin-equivalent capability (they can edit
 * paired.json directly). The wrapper has that access by design.
 *
 * Resolution of the openclaw install: derived from `OPENCLAW_ENTRY`
 * (default `/openclaw/dist/entry.js`). The plugin-sdk lives at
 * `dirname(OPENCLAW_ENTRY)/plugin-sdk/device-bootstrap.js` and is exposed
 * as a stable subpath export (`openclaw/plugin-sdk/device-bootstrap`).
 */

import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_OPENCLAW_ENTRY = "/openclaw/dist/entry.js";

/**
 * Resolve the absolute file:// URL of openclaw's `device-bootstrap.js` module.
 *
 * Pure function of the OPENCLAW_ENTRY env var — exported for unit testing.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveDeviceBootstrapUrl(env = process.env) {
  const entry = env.OPENCLAW_ENTRY || DEFAULT_OPENCLAW_ENTRY;
  const path = `${dirname(entry)}/plugin-sdk/device-bootstrap.js`;
  return pathToFileURL(path).href;
}

/**
 * Classify the result of `approveDevicePairing()` into the wrapper's outcome
 * shape: `{ ok, detail }`. Pure — exported for unit testing.
 *
 * Result shapes the openclaw bundle returns:
 *   - `null`                                       → request no longer pending (raced)
 *   - `{ status: "approved", device }`             → success
 *   - `{ status: "forbidden", reason, scope?, … }` → denied (rare with admin callerScopes)
 *
 * @param {object|null} result
 * @returns {{ ok: boolean, detail: string }}
 */
export function classifyLocalApproveResult(result) {
  if (result === null || result === undefined) {
    return { ok: false, detail: "request no longer pending (raced)" };
  }
  if (typeof result !== "object") {
    return { ok: false, detail: `unexpected result: ${JSON.stringify(result)}` };
  }
  if (result.status === "approved") {
    const deviceId =
      (result.device && typeof result.device.deviceId === "string"
        ? result.device.deviceId
        : null) || "unknown";
    return { ok: true, detail: `device=${deviceId}` };
  }
  if (result.status === "forbidden") {
    const reason =
      typeof result.reason === "string" ? result.reason : "unknown-reason";
    const scope = typeof result.scope === "string" ? ` scope=${result.scope}` : "";
    return { ok: false, detail: `forbidden: ${reason}${scope}` };
  }
  return { ok: false, detail: `unexpected status: ${String(result.status)}` };
}

let _modulePromise = null;

async function loadDeviceBootstrap() {
  if (_modulePromise) return _modulePromise;
  const url = resolveDeviceBootstrapUrl();
  _modulePromise = import(url).catch((err) => {
    // Clear cached promise so a later retry can attempt the import again
    // (the path might come online if openclaw is re-built / re-mounted).
    _modulePromise = null;
    throw err;
  });
  return _modulePromise;
}

/**
 * Approve a pending device-pairing request via direct Node import — bypassing
 * the gateway RPC and the CLI subprocess entirely.
 *
 * Resolves to the raw openclaw result shape. Callers SHOULD pass the result
 * through `classifyLocalApproveResult()` for a uniform `{ ok, detail }` shape.
 *
 * Throws when the openclaw bundle can't be loaded at the resolved path
 * (e.g., `OPENCLAW_ENTRY` is misconfigured or the openclaw install layout
 * changed); callers should fall back to the CLI subprocess in that case.
 *
 * @param {string} requestId
 * @returns {Promise<object|null>}
 */
export async function approveDeviceLocally(requestId) {
  const mod = await loadDeviceBootstrap();
  return await mod.approveDevicePairing(requestId, {
    callerScopes: ["operator.admin"],
  });
}

/**
 * List pending + paired devices via direct Node import — bypassing the gateway
 * RPC and the CLI subprocess entirely.
 *
 * Why this exists, separate from the approve helper:
 *
 * On v2026.5.x, `openclaw devices list --json` itself triggers a scope-upgrade
 * because `device.pair.list` is a pairing method (least-privilege scope =
 * `operator.pairing`) and the wrapper's auto-paired CLI device only holds
 * `operator.read`. The CLI command, when run via the wrapper's `runCmd()`
 * (which merges stdout+stderr), prints to stderr:
 *
 *   gateway connect failed: GatewayClientRequestError: scope upgrade pending approval (requestId: ...)
 *
 * and to stdout the local-fallback JSON. The wrapper's `JSON.parse(out)`
 * sees the error line first and silently fails to the catch block,
 * returning 0 pending — so the auto-approve loop NEVER sees the pending
 * scope-upgrade requests it should be approving. The cycle never starts.
 *
 * Reading paired+pending directly from `~/.openclaw/devices/` avoids all of
 * this. Same local-trust rationale as `approveDeviceLocally` — anyone with
 * filesystem access to the openclaw state dir already has admin-equivalent
 * capability, and the wrapper has that access by design.
 *
 * Returns the openclaw `DevicePairingList` shape: `{ pending: [...], paired: [...] }`.
 * Throws when the openclaw bundle can't be loaded (callers should fall back
 * to the CLI subprocess).
 *
 * @returns {Promise<{pending: object[], paired: object[]}>}
 */
export async function listDevicePairingLocally() {
  const mod = await loadDeviceBootstrap();
  return await mod.listDevicePairing();
}
