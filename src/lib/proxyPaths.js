/**
 * Pure helpers for the wrapper proxy's path-based dispatch decisions.
 *
 * The catch-all WebSocket upgrade handler in `src/routes/proxy.js`
 * normally enforces Basic auth (`SETUP_PASSWORD`) and injects a bearer
 * token. The Go agent-bridge in Senpi-ai/agent-bridge (`v3/go-rewrite`)
 * needs neither — it authenticates via `auth.token` in its `connect`
 * request payload. We carve a dedicated WS path that bypasses both.
 *
 * Kept as a separate pure module so it's trivially unit-testable
 * (`src/lib/__tests__/agentBridgeUpgrade.test.mjs`) without spinning up
 * an HTTP server.
 */

const DEFAULT_BRIDGE_WS_PATH = "/openclaw/ws";

/**
 * Resolve the WS path the wrapper should treat as the agent-bridge
 * pass-through. Reads `AGENT_BRIDGE_WS_PATH` from the supplied env
 * object (defaults to `process.env`).
 *
 * - Empty / whitespace value → default. Operators who blank the var
 *   shouldn't lose the route silently.
 * - Missing leading slash is normalized — accept `openclaw/ws` and
 *   `/openclaw/ws` interchangeably.
 *
 * @param {NodeJS.ProcessEnv|Record<string,string>} [env]
 * @returns {string}
 */
export function resolveAgentBridgeWsPath(env = process.env) {
  const raw = (env.AGENT_BRIDGE_WS_PATH ?? "").trim();
  if (!raw) return DEFAULT_BRIDGE_WS_PATH;
  return raw.startsWith("/") ? raw : `/${raw}`;
}

/**
 * Pathname-equality predicate. True iff the upgrade request's path
 * (ignoring querystring) is exactly the configured bridge path.
 *
 * - Non-string / empty `reqUrl` → false.
 * - Empty / non-string `configuredPath` → false (defensive: an empty
 *   config must never accidentally enable bypass on every upgrade).
 * - URL parsing uses a dummy base so paths-only inputs resolve.
 * - Comparison is exact pathname match; no prefix traversal.
 *
 * @param {unknown} reqUrl           usually `req.url` from a Node http upgrade
 * @param {unknown} configuredPath   from `resolveAgentBridgeWsPath`
 * @returns {boolean}
 */
export function isAgentBridgeUpgradePath(reqUrl, configuredPath) {
  if (typeof reqUrl !== "string" || reqUrl.length === 0) return false;
  if (typeof configuredPath !== "string" || configuredPath.length === 0) {
    return false;
  }
  let pathname;
  try {
    pathname = new URL(reqUrl, "http://dummy").pathname;
  } catch {
    return false;
  }
  return pathname === configuredPath;
}
