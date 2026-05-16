/**
 * Resolve the `gateway.controlUi.allowedOrigins` list the wrapper writes
 * into `openclaw.json`.
 *
 * Background: OpenClaw v2026.5.x classifies `client.id=webchat-ui` and
 * `client.mode=webchat` connections as "webchat" and enforces a strict
 * Origin allowlist (`src/gateway/origin-check.ts`). A bridge connecting
 * from outside the container — including the agent-bridge in
 * Senpi-ai/agent-bridge (`v3/go-rewrite`) — must send an `Origin` header
 * that matches one of these entries (or the gateway returns
 * `CONTROL_UI_ORIGIN_NOT_ALLOWED`).
 *
 * Defaults the wrapper auto-adds, in order:
 *   1. `https://<RAILWAY_PUBLIC_DOMAIN>`  — the deployment's own public URL,
 *      so the bridge can echo the gateway domain as its Origin.
 *   2. `http://localhost:<PORT>` / `http://127.0.0.1:<PORT>` — local-dev
 *      browser-based Control UI when the wrapper is run via
 *      `npm run dev` on a developer laptop.
 *
 * Operators add more via `AGENT_BRIDGE_ALLOWED_ORIGINS` (CSV). An entry
 * of `*` is accepted by OpenClaw as wildcard (any origin); use sparingly.
 *
 * Returns [] when there's nothing to write — caller should skip the
 * config-set call entirely (writing `[]` would lock out the wrapper's
 * own control UI on first boot).
 *
 * @param {NodeJS.ProcessEnv|Record<string,string>} [env]
 * @returns {string[]}
 */
export function resolveAllowedOrigins(env = process.env) {
  const out = new Set();

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
