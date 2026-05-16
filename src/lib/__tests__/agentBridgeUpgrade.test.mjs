/**
 * Tests for the agent-bridge upgrade-path predicate.
 *
 * The wrapper attaches an `upgrade` handler that ordinarily requires
 * Basic auth (SETUP_PASSWORD) on every WebSocket upgrade and then
 * injects `Authorization: Bearer <gatewayToken>` into the proxied
 * request. For the v3 device-pair handshake the Go agent-bridge in
 * Senpi-ai/agent-bridge (`v3/go-rewrite`) needs the opposite:
 *
 *   1. No Basic auth — the bridge authenticates via `auth.token` in its
 *      `connect` request, not via HTTP headers.
 *   2. No injected Authorization — the wrapper-injected bearer token
 *      would crowd out the bridge's own auth.
 *
 * We carve a dedicated path (default `/openclaw/ws`, overridable via
 * `AGENT_BRIDGE_WS_PATH`) that the upgrade handler diverts to a
 * pass-through proxy.
 *
 * Run:
 *   node --test src/lib/__tests__/agentBridgeUpgrade.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isAgentBridgeUpgradePath, resolveAgentBridgeWsPath } from "../proxyPaths.js";

// ─── resolveAgentBridgeWsPath ──────────────────────────────────────────────

test("resolveAgentBridgeWsPath: default is /openclaw/ws", () => {
  assert.equal(resolveAgentBridgeWsPath({}), "/openclaw/ws");
});

test("resolveAgentBridgeWsPath: env override wins", () => {
  assert.equal(
    resolveAgentBridgeWsPath({ AGENT_BRIDGE_WS_PATH: "/agent-bridge/ws" }),
    "/agent-bridge/ws",
  );
});

test("resolveAgentBridgeWsPath: trims whitespace", () => {
  assert.equal(
    resolveAgentBridgeWsPath({ AGENT_BRIDGE_WS_PATH: "  /custom  " }),
    "/custom",
  );
});

test("resolveAgentBridgeWsPath: empty string falls back to default", () => {
  // An operator who unintentionally sets the var blank shouldn't lose the
  // route — default keeps the bridge reachable.
  assert.equal(
    resolveAgentBridgeWsPath({ AGENT_BRIDGE_WS_PATH: "" }),
    "/openclaw/ws",
  );
});

test("resolveAgentBridgeWsPath: missing leading slash is normalized", () => {
  assert.equal(
    resolveAgentBridgeWsPath({ AGENT_BRIDGE_WS_PATH: "openclaw/ws" }),
    "/openclaw/ws",
  );
});

// ─── isAgentBridgeUpgradePath ──────────────────────────────────────────────

test("isAgentBridgeUpgradePath: exact match → true", () => {
  assert.equal(isAgentBridgeUpgradePath("/openclaw/ws", "/openclaw/ws"), true);
});

test("isAgentBridgeUpgradePath: match with query string → true", () => {
  assert.equal(
    isAgentBridgeUpgradePath("/openclaw/ws?protocol=v3", "/openclaw/ws"),
    true,
  );
});

test("isAgentBridgeUpgradePath: mismatched path → false", () => {
  assert.equal(isAgentBridgeUpgradePath("/openclaw", "/openclaw/ws"), false);
  assert.equal(isAgentBridgeUpgradePath("/ws", "/openclaw/ws"), false);
});

test("isAgentBridgeUpgradePath: trailing slash mismatch → false", () => {
  // Exact pathname match — `/openclaw/ws` and `/openclaw/ws/` are distinct
  // upgrade targets. Be conservative; operators set the env var deliberately.
  assert.equal(
    isAgentBridgeUpgradePath("/openclaw/ws/", "/openclaw/ws"),
    false,
  );
});

test("isAgentBridgeUpgradePath: prefix-only match → false (no traversal)", () => {
  // `/openclaw/ws/extra` is NOT the bridge path.
  assert.equal(
    isAgentBridgeUpgradePath("/openclaw/ws/extra", "/openclaw/ws"),
    false,
  );
});

test("isAgentBridgeUpgradePath: empty / non-string url → false", () => {
  assert.equal(isAgentBridgeUpgradePath("", "/openclaw/ws"), false);
  assert.equal(isAgentBridgeUpgradePath(undefined, "/openclaw/ws"), false);
  assert.equal(isAgentBridgeUpgradePath(null, "/openclaw/ws"), false);
  assert.equal(isAgentBridgeUpgradePath(42, "/openclaw/ws"), false);
});

test("isAgentBridgeUpgradePath: malformed url falls back to literal compare", () => {
  // A degenerate URL like just "openclaw/ws" (no leading slash) should not
  // accidentally match. The implementation parses against a dummy base; a
  // relative-without-slash URL pathname becomes /openclaw/ws — but the
  // PATH we configured is `/openclaw/ws`, so this is a true match. Document
  // the parsing semantics explicitly so future readers don't trip on it.
  assert.equal(
    isAgentBridgeUpgradePath("openclaw/ws", "/openclaw/ws"),
    true,
  );
});

test("isAgentBridgeUpgradePath: configured path empty → false (defensive)", () => {
  // If config resolution somehow yields empty, the predicate must reject
  // EVERY url — never accidentally enable a bypass on every upgrade.
  assert.equal(isAgentBridgeUpgradePath("/openclaw/ws", ""), false);
  assert.equal(isAgentBridgeUpgradePath("/openclaw/ws", undefined), false);
});

test("isAgentBridgeUpgradePath: nested path config (operator-chosen)", () => {
  // Custom path like `/agent-bridge/v3/ws` must match exactly.
  assert.equal(
    isAgentBridgeUpgradePath("/agent-bridge/v3/ws", "/agent-bridge/v3/ws"),
    true,
  );
  assert.equal(
    isAgentBridgeUpgradePath("/agent-bridge/v3", "/agent-bridge/v3/ws"),
    false,
  );
});
