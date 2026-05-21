/**
 * Resolve whether the wrapper writes
 * `gateway.controlUi.dangerouslyDisableDeviceAuth=true` into `openclaw.json`.
 *
 * Default: OFF. Set OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH=true to opt in.
 *
 * Why default OFF (verified against OpenClaw v2026.5.x source):
 *
 *   The flag is gated on `isControlUi && role === "operator"` in
 *   `connect-policy.ts:25-34, 122-130`. Two consequences:
 *
 *   (a) Internal clients (Telegram provider, cron, session WS) are NOT
 *       controlUi, so the flag never engages for them — they pass through
 *       `shouldSkipLocalBackendSelfPairing`, a separate code path.
 *   (b) The bridge (`client.id=webchat-ui`, `mode=webchat`) is classified
 *       as `isWebchat`, not `isControlUi`. Same conclusion.
 *
 *   The flag's only real effect is admitting a remote Control UI browser
 *   without device pairing. The product surface is moving to
 *   senpi-web → agent-bridge → openclaw; Control UI is a debugging
 *   convenience recoverable via `railway ssh` + the openclaw CLI from
 *   inside the container, so the default flips to OFF.
 *
 * Accepted truthy values (lowercase, trimmed): "true", "1", "yes", "on".
 * Anything else — including typos — stays OFF (fail-closed for a
 * `dangerously*` flag).
 *
 * @param {NodeJS.ProcessEnv|Record<string,string>} [env]
 * @returns {boolean}
 */
export function shouldSetDangerousDeviceAuthFlag(env = process.env) {
  const raw = (env.OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH ?? "")
    .trim()
    .toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes" || raw === "on";
}
