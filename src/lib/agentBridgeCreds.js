/**
 * Pure helpers for resolving the agent-bridge integration credentials that
 * `/setup/api/agent-bridge-creds` returns to the operator.
 *
 * Kept separate from the route handler so the URL-construction and
 * agent-id derivation logic is unit-testable without spinning up Express.
 *
 * Three pieces of data the operator hands to the bridge:
 *   - `gatewayUrl`     — `wss://<host>/<path>` to dial.
 *   - `bootstrapToken` — the gateway shared secret. Goes into the bridge's
 *                       `OPENCLAW_BOOTSTRAP_TOKEN` env var.
 *   - `agentId`        — a stable identifier for this Railway deployment.
 */

import { resolveAgentBridgeWsPath } from "./proxyPaths.js";

/**
 * Build the `wss://…` URL the agent-bridge dials.
 *
 * Domain resolution (first non-empty wins):
 *   1. `env.RAILWAY_PUBLIC_DOMAIN` — Railway runtime injects this on a
 *      service with public networking.
 *   2. `forwardedHost` — extracted by the caller from `req.headers.host`
 *      when the wrapper is reached over a public URL.
 *
 * Notes:
 *   - `RAILWAY_PUBLIC_DOMAIN` is the bare domain (no scheme). We don't
 *     do scheme-swap heuristics; we always construct `wss://` because
 *     Railway terminates TLS in front of the service.
 *   - The path comes from `resolveAgentBridgeWsPath(env)` so an operator
 *     who overrode `AGENT_BRIDGE_WS_PATH` gets the matching URL back.
 *
 * @param {{env?: object, forwardedHost?: string}} input
 * @returns {string|null}  null when no usable domain is available
 */
export function buildBridgeGatewayUrl({ env = process.env, forwardedHost } = {}) {
  const railwayDomain = (env.RAILWAY_PUBLIC_DOMAIN ?? "").trim();
  const fallbackHost = typeof forwardedHost === "string" ? forwardedHost.trim() : "";
  const host = railwayDomain || fallbackHost;
  if (!host) return null;
  const path = resolveAgentBridgeWsPath(env);
  return `wss://${host}${path}`;
}

/**
 * Resolve a human-readable agent identifier.
 *
 * Priority:
 *   1. `${RAILWAY_PROJECT_NAME}-${RAILWAY_SERVICE_NAME}` when both set.
 *   2. `RAILWAY_PROJECT_ID` / `RAILWAY_SERVICE_ID` if names are missing.
 *   3. Supplied hostname (the caller passes `os.hostname()`).
 *
 * Names beat IDs because audit logs read much better with words than
 * UUIDs; we only fall back to IDs when names are unavailable.
 *
 * @param {{env?: object, hostname?: string}} input
 * @returns {string}
 */
export function resolveAgentId({ env = process.env, hostname = "" } = {}) {
  const proj = (env.RAILWAY_PROJECT_NAME ?? "").trim();
  const svc = (env.RAILWAY_SERVICE_NAME ?? "").trim();
  if (proj && svc) return `${proj}-${svc}`;

  const projId = (env.RAILWAY_PROJECT_ID ?? "").trim();
  const svcId = (env.RAILWAY_SERVICE_ID ?? "").trim();
  if (projId && svcId) return `${projId}-${svcId}`;
  if (projId) return projId;
  if (svcId) return svcId;

  return hostname || "unknown";
}
