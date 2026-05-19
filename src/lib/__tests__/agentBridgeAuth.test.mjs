/**
 * Tests for the agent-bridge auto-approval predicate.
 *
 * Why it exists: the existing `isLoopbackOperatorRequest` predicate only
 * approves loopback operator pairings (Telegram provider, cron, session WS).
 * The Go agent-bridge (Senpi-ai/agent-bridge, v3/go-rewrite) connects from a
 * remote host with `client.id="webchat-ui" mode="webchat" role="user"
 * scopes=["chat"]`. Without a second predicate the wrapper silently ignores
 * the pending request and the bridge times out with `1008 pairing required`.
 *
 * Trust boundary: a request only reaches `pendingRequests` after OpenClaw
 * verified `auth.token` against the gateway shared secret
 * (`handshake-auth-helpers.ts`). If that token leaks, an attacker can pick
 * any `client.id`/`role` — so the allowlist is a SECOND gate, not the first.
 * Documented in CLAUDE.md Quirk #14.
 *
 * Run:
 *   node --test src/lib/__tests__/agentBridgeAuth.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isAgentBridgeRequest,
  parseAgentBridgeConfigFromEnv,
} from "../deviceAuth.js";

// ─── parseAgentBridgeConfigFromEnv ─────────────────────────────────────────

test("parseAgentBridgeConfigFromEnv: defaults when env is empty", () => {
  const cfg = parseAgentBridgeConfigFromEnv({});
  assert.deepEqual(cfg.clientIds, ["webchat-ui", "senpi-mobile", "senpi-web"]);
  assert.deepEqual(cfg.clientModes, ["webchat"]);
  assert.deepEqual(cfg.scopes, ["chat"]);
});

test("parseAgentBridgeConfigFromEnv: env overrides win", () => {
  const cfg = parseAgentBridgeConfigFromEnv({
    AGENT_BRIDGE_CLIENT_IDS: "foo,bar",
    AGENT_BRIDGE_CLIENT_MODES: "alpha,beta",
    AGENT_BRIDGE_SCOPES_ALLOWLIST: "chat,notify",
  });
  assert.deepEqual(cfg.clientIds, ["foo", "bar"]);
  assert.deepEqual(cfg.clientModes, ["alpha", "beta"]);
  assert.deepEqual(cfg.scopes, ["chat", "notify"]);
});

test("parseAgentBridgeConfigFromEnv: trims whitespace and drops empties", () => {
  const cfg = parseAgentBridgeConfigFromEnv({
    AGENT_BRIDGE_CLIENT_IDS: "  webchat-ui , , senpi-web  ",
  });
  assert.deepEqual(cfg.clientIds, ["webchat-ui", "senpi-web"]);
});

test("parseAgentBridgeConfigFromEnv: empty value → empty list (locks out everything)", () => {
  const cfg = parseAgentBridgeConfigFromEnv({
    AGENT_BRIDGE_CLIENT_IDS: "",
  });
  // Explicit empty string means "no clients" — distinct from "var unset".
  // Operators set this when they want to fully disable agent-bridge pairings.
  assert.deepEqual(cfg.clientIds, []);
});

// ─── isAgentBridgeRequest — happy paths ────────────────────────────────────

const defaultCfg = {
  clientIds: ["webchat-ui", "senpi-mobile", "senpi-web"],
  clientModes: ["webchat"],
  scopes: ["chat"],
};

function bridgeReq(overrides = {}) {
  return {
    requestId: "req-abc",
    role: "operator",
    scopes: ["chat"],
    client: { id: "webchat-ui", mode: "webchat" },
    remoteIp: "203.0.113.7",
    ...overrides,
  };
}

test("isAgentBridgeRequest: canonical webchat-ui/operator/chat → true", () => {
  // Note: role MUST be "operator", not "user" — OpenClaw v2026.5.x's
  // GatewayRole enum is exactly ["operator", "node"] (role-policy.ts:3).
  // The bridge accordingly sends role=operator (orchestrator.go).
  assert.equal(isAgentBridgeRequest(bridgeReq(), defaultCfg), true);
});

test("isAgentBridgeRequest: roles array (no role field) is accepted", () => {
  // OpenClaw's plugin-sdk listDevicePairing emits both `role` and `roles`.
  // Either being "operator" should satisfy.
  const r = bridgeReq({ roles: ["operator"] });
  delete r.role;
  assert.equal(isAgentBridgeRequest(r, defaultCfg), true);
});

test("isAgentBridgeRequest: senpi-mobile in allowlist → true", () => {
  assert.equal(
    isAgentBridgeRequest(
      bridgeReq({ client: { id: "senpi-mobile", mode: "webchat" } }),
      defaultCfg,
    ),
    true,
  );
});

test("isAgentBridgeRequest: flat client.id field (v2026.5.x list shape) → true", () => {
  // Some openclaw versions hoist `clientId`/`clientMode` instead of nesting
  // them under `client.*`. Accept both shapes.
  assert.equal(
    isAgentBridgeRequest(
      {
        requestId: "r",
        role: "operator",
        scopes: ["chat"],
        clientId: "webchat-ui",
        clientMode: "webchat",
        remoteIp: "203.0.113.7",
      },
      defaultCfg,
    ),
    true,
  );
});

test("isAgentBridgeRequest: scopes subset of allowlist → true", () => {
  // Allowlist `["chat", "notify"]`, request asks for `["chat"]` → subset OK.
  assert.equal(
    isAgentBridgeRequest(bridgeReq({ scopes: ["chat"] }), {
      ...defaultCfg,
      scopes: ["chat", "notify"],
    }),
    true,
  );
});

// ─── isAgentBridgeRequest — rejections ─────────────────────────────────────

test("isAgentBridgeRequest: role=node → false (only operator allowed for chat scope)", () => {
  // OpenClaw's other valid role is `node`, used for backend nodes that
  // serve methods, not for chat clients. Rejecting it keeps the
  // allowlist narrow to the actual bridge use-case.
  assert.equal(
    isAgentBridgeRequest(bridgeReq({ role: "node", roles: ["node"] }), defaultCfg),
    false,
  );
});

test("isAgentBridgeRequest: scope outside allowlist → false", () => {
  assert.equal(
    isAgentBridgeRequest(bridgeReq({ scopes: ["chat", "admin"] }), defaultCfg),
    false,
  );
});

test("isAgentBridgeRequest: client.id not in allowlist → false", () => {
  assert.equal(
    isAgentBridgeRequest(
      bridgeReq({ client: { id: "evil-ui", mode: "webchat" } }),
      defaultCfg,
    ),
    false,
  );
});

test("isAgentBridgeRequest: client.mode not in allowlist → false", () => {
  assert.equal(
    isAgentBridgeRequest(
      bridgeReq({ client: { id: "webchat-ui", mode: "rogue" } }),
      defaultCfg,
    ),
    false,
  );
});

test("isAgentBridgeRequest: missing requestId → false", () => {
  const r = bridgeReq();
  delete r.requestId;
  assert.equal(isAgentBridgeRequest(r, defaultCfg), false);
});

test("isAgentBridgeRequest: empty scopes array → false (no scope to satisfy)", () => {
  // A zero-scope user session is degenerate; reject conservatively.
  assert.equal(
    isAgentBridgeRequest(bridgeReq({ scopes: [] }), defaultCfg),
    false,
  );
});

test("isAgentBridgeRequest: null/undefined scopes → false", () => {
  assert.equal(
    isAgentBridgeRequest(bridgeReq({ scopes: null }), defaultCfg),
    false,
  );
  assert.equal(
    isAgentBridgeRequest(bridgeReq({ scopes: undefined }), defaultCfg),
    false,
  );
});

test("isAgentBridgeRequest: duplicate scopes still pass when each is in allowlist", () => {
  // OpenClaw may list duplicates from a re-pair flow; we accept as long as
  // the deduped set is a subset.
  assert.equal(
    isAgentBridgeRequest(bridgeReq({ scopes: ["chat", "chat"] }), defaultCfg),
    true,
  );
});

test("isAgentBridgeRequest: empty allowlist locks everything out", () => {
  const cfg = { clientIds: [], clientModes: ["webchat"], scopes: ["chat"] };
  assert.equal(isAgentBridgeRequest(bridgeReq(), cfg), false);
});

test("isAgentBridgeRequest: case-sensitive client.id matching (no fuzzing)", () => {
  // `client.id` is server-trusted metadata in the protocol — exact match,
  // no case folding, mirrors how OpenClaw treats it on the gateway side.
  assert.equal(
    isAgentBridgeRequest(
      bridgeReq({ client: { id: "Webchat-UI", mode: "webchat" } }),
      defaultCfg,
    ),
    false,
  );
});

test("isAgentBridgeRequest: malformed input → false (no throw)", () => {
  assert.equal(isAgentBridgeRequest(null, defaultCfg), false);
  assert.equal(isAgentBridgeRequest(undefined, defaultCfg), false);
  assert.equal(isAgentBridgeRequest("string", defaultCfg), false);
  assert.equal(isAgentBridgeRequest(42, defaultCfg), false);
});

test("isAgentBridgeRequest: remoteIp is irrelevant (server-to-server, behind proxies)", () => {
  // Unlike `isLoopbackOperatorRequest`, the bridge predicate does NOT key on
  // remoteIp — bridge connections originate from anywhere on the internet
  // and reach OpenClaw through the wrapper proxy. The trust gate is the
  // bootstrap token validated upstream. Both IPv4 and IPv6 must pass.
  assert.equal(
    isAgentBridgeRequest(bridgeReq({ remoteIp: "2001:db8::1" }), defaultCfg),
    true,
  );
  assert.equal(
    isAgentBridgeRequest(bridgeReq({ remoteIp: undefined }), defaultCfg),
    true,
  );
});

// ─── parseSteadyIntervalFromEnv — bugbot #da92a0c4 regression guard ────────

import { parseSteadyIntervalFromEnv } from "../deviceAuth.js";

test("parseSteadyIntervalFromEnv: default when unset", () => {
  assert.equal(parseSteadyIntervalFromEnv({}), 10000);
});

test("parseSteadyIntervalFromEnv: valid positive integer is respected", () => {
  assert.equal(
    parseSteadyIntervalFromEnv({ DEVICE_AUTH_STEADY_INTERVAL_MS: "30000" }),
    30000,
  );
});

test("parseSteadyIntervalFromEnv: non-numeric → default (would otherwise be NaN → tight loop)", () => {
  // setTimeout(fn, NaN) fires in ~1ms on Node, so an unguarded Number()
  // turns a typo into a CPU saturator. Anything that isn't a positive
  // finite integer must fall back.
  assert.equal(
    parseSteadyIntervalFromEnv({ DEVICE_AUTH_STEADY_INTERVAL_MS: "abc" }),
    10000,
  );
  assert.equal(
    parseSteadyIntervalFromEnv({ DEVICE_AUTH_STEADY_INTERVAL_MS: "10s" }),
    10000,
  );
});

test("parseSteadyIntervalFromEnv: zero / negative → default", () => {
  assert.equal(
    parseSteadyIntervalFromEnv({ DEVICE_AUTH_STEADY_INTERVAL_MS: "0" }),
    10000,
  );
  assert.equal(
    parseSteadyIntervalFromEnv({ DEVICE_AUTH_STEADY_INTERVAL_MS: "-5000" }),
    10000,
  );
});

test("parseSteadyIntervalFromEnv: empty / whitespace → default", () => {
  assert.equal(
    parseSteadyIntervalFromEnv({ DEVICE_AUTH_STEADY_INTERVAL_MS: "" }),
    10000,
  );
  assert.equal(
    parseSteadyIntervalFromEnv({ DEVICE_AUTH_STEADY_INTERVAL_MS: "   " }),
    10000,
  );
});

test("parseSteadyIntervalFromEnv: Infinity → default (degenerate, would never tick)", () => {
  assert.equal(
    parseSteadyIntervalFromEnv({ DEVICE_AUTH_STEADY_INTERVAL_MS: "Infinity" }),
    10000,
  );
});
