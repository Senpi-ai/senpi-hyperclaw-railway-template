/**
 * Resolve whether the wrapper writes
 * `gateway.controlUi.dangerouslyDisableDeviceAuth=true` into `openclaw.json`.
 *
 * Background — Quirk #7 in CLAUDE.md:
 *   The flag was set unconditionally to keep two things working:
 *     (a) Internal clients (Telegram provider, cron, session WS) connecting
 *         over loopback. On v2026.5.7 these no longer need it — they pass
 *         through OpenClaw's `shouldSkipLocalBackendSelfPairing` exemption
 *         (`handshake-auth-helpers.ts:252-272`), an unrelated code path.
 *     (b) The **Control UI browser**. The flag's effect is gated by
 *         `isControlUi && role === "operator"` in `connect-policy.ts:122-130`.
 *         On a remote Railway HTTPS host the browser CAN device-pair via
 *         SubtleCrypto, but the wrapper's auto-approval loop currently
 *         only approves loopback pairings — so a remote Control UI browser
 *         would block on a missing human approver.
 *
 *   Removing the flag is therefore safe **iff** the operator either
 *   doesn't use the Control UI from outside the container, or has a
 *   matching auto-approval extension in place. We expose this as an
 *   env-var hatch so individual deployments can opt out without forking.
 *
 * Semantics:
 *   - Default (env var unset or any value other than "false" / "0"): keep
 *     the flag in `openclaw.json`. Existing behaviour preserved.
 *   - Set `OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH=false` (or `0`): omit
 *     the flag. Remote Control UI access will require real device pairing.
 *
 * @param {NodeJS.ProcessEnv|Record<string,string>} [env]
 * @returns {boolean}
 */
export function shouldSetDangerousDeviceAuthFlag(env = process.env) {
  const raw = (env.OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH ?? "")
    .trim()
    .toLowerCase();
  if (raw === "false" || raw === "0" || raw === "no" || raw === "off") {
    return false;
  }
  return true;
}
