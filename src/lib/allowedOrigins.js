/**
 * Resolve the `gateway.controlUi.allowedOrigins` list the wrapper writes
 * into `openclaw.json`.
 *
 * Background: OpenClaw v2026.5.x classifies `client.id=webchat-ui` and
 * `client.mode=webchat` connections as "webchat" and enforces a strict
 * Origin allowlist (`src/gateway/origin-check.ts`). Origin parsing runs
 * BEFORE the allowlist is consulted: a missing/null Origin is rejected
 * at step 1 with `CONTROL_UI_ORIGIN_NOT_ALLOWED` (1008). The agent-bridge
 * therefore sends a fixed sentinel Origin on every south dial; the wrapper
 * must include the same sentinel here so the two sides match.
 *
 * The sentinel value is NOT a code constant — this is a public repo, and
 * embedding the coordination string here would leak it. Operators supply
 * `AGENT_BRIDGE_ORIGIN` at deploy time; the orchestrator + agent-bridge
 * read the same env var (or its equivalent) on their sides. When unset,
 * the sentinel slot is omitted from the allowlist entirely — webchat
 * dials will fail until the env var is provided.
 *
 * Defaults the resolver auto-adds, in order:
 *   1. `AGENT_BRIDGE_ORIGIN` — the bridge coordination value. Load-bearing
 *      for the bridge → openclaw chat path. Omitted when unset.
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
 * Contract: `AGENT_BRIDGE_ORIGIN` MUST be the same value on the wrapper's
 * deploy env, the orchestrator's deploy env, and the agent-bridge's
 * outbound `Origin` header. Mismatch breaks every bridge connect with
 * "INVALID_REQUEST: origin not allowed".
 *
 * @param {NodeJS.ProcessEnv|Record<string,string>} [env]
 * @returns {string[]}
 */
export function resolveAllowedOrigins(env = process.env) {
  const out = new Set();

  // Bridge sentinel — load-bearing for the agent-bridge chat path.
  // Sourced from env (no hardcoded default) because the wrapper repo is
  // public; the coordination string lives only at the deployment surface.
  const sentinel = (env.AGENT_BRIDGE_ORIGIN ?? "").trim();
  if (sentinel) out.add(sentinel);

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
