/**
 * Resolve the `gateway.controlUi.allowedOrigins` list the wrapper writes
 * into `openclaw.json`.
 *
 * Background: OpenClaw v2026.5.x classifies `client.id=webchat-ui` and
 * `client.mode=webchat` connections as "webchat" and enforces a strict
 * Origin allowlist (`src/gateway/origin-check.ts`). Origin parsing runs
 * BEFORE the allowlist is consulted: a missing/null Origin is rejected
 * at step 1 with `CONTROL_UI_ORIGIN_NOT_ALLOWED` (1008). The bridge
 * (Senpi-ai/agent-bridge, `v3/go-rewrite`) therefore sends a fixed
 * sentinel Origin (`BRIDGE_ORIGIN_SENTINEL`) on every south dial; we
 * always include the same sentinel in this allowlist so the two sides
 * match by construction.
 *
 * Defaults the wrapper auto-adds, in order:
 *   1. `BRIDGE_ORIGIN_SENTINEL` — the bridge coordination value. Always
 *      first; this is the load-bearing entry for the bridge → openclaw
 *      chat path. `.invalid` TLD (RFC 2606) signals "not a real URL".
 *   2. `https://<RAILWAY_PUBLIC_DOMAIN>` — the deployment's own public URL,
 *      so browser-based Control UI works from the public domain when an
 *      operator wants it.
 *   3. `http://localhost:<PORT>` / `http://127.0.0.1:<PORT>` — local-dev
 *      browser-based Control UI when the wrapper is run via
 *      `npm run dev` on a developer laptop.
 *
 * Operators add more via `AGENT_BRIDGE_ALLOWED_ORIGINS` (CSV). An entry
 * of `*` is accepted by OpenClaw as wildcard (any origin); use sparingly.
 *
 * Contract: `BRIDGE_ORIGIN_SENTINEL` MUST stay in lock-step with the
 * `BridgeOriginSentinel` constant in
 * `senpi-ai/agent-bridge` (`internal/server/orchestrator.go`). Changing
 * one without the other breaks every Railway-hosted bridge pairing.
 *
 * @param {NodeJS.ProcessEnv|Record<string,string>} [env]
 * @returns {string[]}
 */

/**
 * Fixed origin the bridge sends in its `Origin` header. Pre-agreed
 * coordination token, not a real URL. Lock-step with agent-bridge-go
 * (`server.BridgeOriginSentinel`).
 */
export const BRIDGE_ORIGIN_SENTINEL = "https://senpi.agent-bridge.invalid";

export function resolveAllowedOrigins(env = process.env) {
  const out = new Set();

  // Bridge sentinel first — load-bearing for the agent-bridge chat path.
  out.add(BRIDGE_ORIGIN_SENTINEL);

  const railwayDomain = (env.RAILWAY_PUBLIC_DOMAIN ?? "").trim();
  if (railwayDomain) out.add(`https://${railwayDomain}`);

  const port = (env.PORT ?? "8080").trim() || "8080";
  out.add(`http://localhost:${port}`);
  out.add(`http://127.0.0.1:${port}`);

  const extras = (env.AGENT_BRIDGE_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const o of extras) out.add(o);

  return [...out];
}
