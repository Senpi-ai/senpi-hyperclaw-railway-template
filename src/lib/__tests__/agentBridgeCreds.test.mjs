/**
 * Tests for the agent-bridge integration-credentials helpers used by
 * `GET /setup/api/agent-bridge-creds`.
 *
 * The endpoint hands the operator three values they paste into the bridge's
 * env file:
 *
 *   OPENCLAW_GATEWAY_URL       ← buildBridgeGatewayUrl
 *   OPENCLAW_BOOTSTRAP_TOKEN   ← (the resolved gateway token; not under test here)
 *   OPENCLAW_AGENT_ID          ← resolveAgentId
 *
 * Both helpers are pure functions of env + per-request hints, so they get
 * unit tests rather than integration tests.
 *
 * Run:
 *   node --test src/lib/__tests__/agentBridgeCreds.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBridgeGatewayUrl,
  resolveAgentId,
} from "../agentBridgeCreds.js";

// ─── buildBridgeGatewayUrl ─────────────────────────────────────────────────

test("buildBridgeGatewayUrl: uses RAILWAY_PUBLIC_DOMAIN when set", () => {
  assert.equal(
    buildBridgeGatewayUrl({
      env: { RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app" },
    }),
    "wss://app.up.railway.app/openclaw/ws",
  );
});

test("buildBridgeGatewayUrl: never prepends a scheme to the domain (Railway gives bare host)", () => {
  // Sanity check: if someone wrongly sets RAILWAY_PUBLIC_DOMAIN to
  // `https://app.up.railway.app`, the resulting URL would be
  // `wss://https://...` — visibly broken. Document that the helper assumes
  // bare-domain input by failing loudly via a malformed URL in the wire.
  // (Validating defensive behaviour now would mask a misconfiguration.)
  const url = buildBridgeGatewayUrl({
    env: { RAILWAY_PUBLIC_DOMAIN: "https://app.up.railway.app" },
  });
  assert.equal(url, "wss://https://app.up.railway.app/openclaw/ws");
});

test("buildBridgeGatewayUrl: falls back to forwardedHost when env empty", () => {
  assert.equal(
    buildBridgeGatewayUrl({
      env: {},
      forwardedHost: "deploy-abc.up.railway.app",
    }),
    "wss://deploy-abc.up.railway.app/openclaw/ws",
  );
});

test("buildBridgeGatewayUrl: trims whitespace on domain", () => {
  assert.equal(
    buildBridgeGatewayUrl({
      env: { RAILWAY_PUBLIC_DOMAIN: "  app.up.railway.app  " },
    }),
    "wss://app.up.railway.app/openclaw/ws",
  );
});

test("buildBridgeGatewayUrl: respects AGENT_BRIDGE_WS_PATH override", () => {
  assert.equal(
    buildBridgeGatewayUrl({
      env: {
        RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
        AGENT_BRIDGE_WS_PATH: "/agent-bridge/v3/ws",
      },
    }),
    "wss://app.up.railway.app/agent-bridge/v3/ws",
  );
});

test("buildBridgeGatewayUrl: no usable host → null (caller surfaces 503)", () => {
  assert.equal(buildBridgeGatewayUrl({ env: {} }), null);
  assert.equal(
    buildBridgeGatewayUrl({ env: {}, forwardedHost: "" }),
    null,
  );
  assert.equal(
    buildBridgeGatewayUrl({ env: {}, forwardedHost: undefined }),
    null,
  );
});

test("buildBridgeGatewayUrl: includes port if present in host", () => {
  // Local dev: `req.headers.host` is usually `localhost:8080`. We preserve
  // it so a `make dev`-style local run can fetch the creds and connect.
  assert.equal(
    buildBridgeGatewayUrl({
      env: {},
      forwardedHost: "localhost:8080",
    }),
    "wss://localhost:8080/openclaw/ws",
  );
});

// ─── resolveAgentId ────────────────────────────────────────────────────────

test("resolveAgentId: prefers project-name + service-name when both set", () => {
  assert.equal(
    resolveAgentId({
      env: {
        RAILWAY_PROJECT_NAME: "senpi-prod",
        RAILWAY_SERVICE_NAME: "openclaw",
      },
    }),
    "senpi-prod-openclaw",
  );
});

test("resolveAgentId: falls back to project-id + service-id when names absent", () => {
  assert.equal(
    resolveAgentId({
      env: {
        RAILWAY_PROJECT_ID: "p-uuid",
        RAILWAY_SERVICE_ID: "s-uuid",
      },
    }),
    "p-uuid-s-uuid",
  );
});

test("resolveAgentId: handles only project id present", () => {
  assert.equal(
    resolveAgentId({ env: { RAILWAY_PROJECT_ID: "p-only" } }),
    "p-only",
  );
});

test("resolveAgentId: handles only service id present", () => {
  assert.equal(
    resolveAgentId({ env: { RAILWAY_SERVICE_ID: "s-only" } }),
    "s-only",
  );
});

test("resolveAgentId: trims whitespace on values", () => {
  assert.equal(
    resolveAgentId({
      env: {
        RAILWAY_PROJECT_NAME: "  senpi ",
        RAILWAY_SERVICE_NAME: " gw  ",
      },
    }),
    "senpi-gw",
  );
});

test("resolveAgentId: falls back to hostname when env empty", () => {
  assert.equal(
    resolveAgentId({ env: {}, hostname: "container-abc" }),
    "container-abc",
  );
});

test("resolveAgentId: hostname missing → \"unknown\"", () => {
  // Defensive default — never return an empty string. The bridge env-loader
  // treats empty `OPENCLAW_AGENT_ID` as missing and refuses to start.
  assert.equal(resolveAgentId({ env: {} }), "unknown");
  assert.equal(resolveAgentId({}), "unknown");
});

test("resolveAgentId: name pair wins over id pair (readability over uniqueness)", () => {
  assert.equal(
    resolveAgentId({
      env: {
        RAILWAY_PROJECT_NAME: "senpi-prod",
        RAILWAY_SERVICE_NAME: "openclaw",
        RAILWAY_PROJECT_ID: "deadbeef",
        RAILWAY_SERVICE_ID: "cafebabe",
      },
    }),
    "senpi-prod-openclaw",
  );
});

test("resolveAgentId: partial name pair (project only) falls through to IDs", () => {
  // Names take effect only when BOTH project and service names are set.
  // A solo name is less stable than the matching id-pair, so we fall through.
  assert.equal(
    resolveAgentId({
      env: {
        RAILWAY_PROJECT_NAME: "senpi-prod",
        RAILWAY_PROJECT_ID: "p-uuid",
        RAILWAY_SERVICE_ID: "s-uuid",
      },
    }),
    "p-uuid-s-uuid",
  );
});
