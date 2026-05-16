/**
 * Resolve whether the wrapper writes
 * `gateway.controlUi.dangerouslyDisableDeviceAuth=true` into `openclaw.json`.
 *
 * Why this exists (revised — Quirk #15 in CLAUDE.md):
 *
 *   OpenClaw v2026.5.7's `connect-policy.ts:25-34, 122-130` gates the
 *   flag on `isControlUi && role === "operator"`. Two things follow:
 *
 *   (a) **Internal clients** (Telegram provider, cron, session WS) are
 *       NOT controlUi, so the flag never engages for them. They pass
 *       through `shouldSkipLocalBackendSelfPairing` (`handshake-auth-helpers.ts:252-272`),
 *       an unrelated code path. The old Quirk #7 claim that the flag
 *       was load-bearing for internal clients was stale on v2026.5.x.
 *
 *   (b) **The bridge** (agent-bridge `client.id=webchat-ui`,
 *       `mode=webchat`) is classified as `isWebchat`, not `isControlUi`
 *       (`utils/message-channel.ts`). Same conclusion: flag never engages.
 *       Smoke against `fresh-openclaw-deploy` (PR #59) confirmed the
 *       wrapper's `isAgentBridgeRequest` auto-approval is what unblocks
 *       the bridge — not the flag.
 *
 *   The flag's ONLY real effect is admitting a **remote Control UI
 *   browser** without device pairing. The product surface is moving to
 *   senpi-web → agent-bridge → openclaw; Control UI is a debugging
 *   convenience that the operator can recover via `railway ssh` + the
 *   openclaw CLI from inside the container. So we default-OFF and let
 *   anyone who still wants browser Control UI opt back in.
 *
 * Semantics (new default):
 *   - Default (env var unset OR any value other than "true" / "1" /
 *     "yes" / "on"): omit the flag from `openclaw.json`. Drops the
 *     `[gateway] security warning: dangerous config flags enabled: …`
 *     line from boot logs.
 *   - Set `OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH=true` to restore
 *     the old behaviour (required if you need remote Control UI
 *     access from a browser without pairing).
 *
 * @param {NodeJS.ProcessEnv|Record<string,string>} [env]
 * @returns {boolean}
 */
export function shouldSetDangerousDeviceAuthFlag(env = process.env) {
  const raw = (env.OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH ?? "")
    .trim()
    .toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes" || raw === "on") {
    return true;
  }
  return false;
}
