/**
 * Tests for the allowed-origins resolver used by all four
 * `openclaw.json` write-sites (bootstrap.mjs, onboard.js, gateway.js,
 * setup.js).
 *
 * OpenClaw v2026.5.x rejects webchat-class connections (including the
 * agent-bridge from Senpi-ai/agent-bridge `v3/go-rewrite`) when the
 * `Origin` header is missing or not in `gateway.controlUi.allowedOrigins`.
 * The bridge sends a fixed `BRIDGE_ORIGIN_SENTINEL`; we always emit the
 * same sentinel in this allowlist so the two sides match.
 *
 * Run:
 *   node --test src/lib/__tests__/allowedOrigins.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveAllowedOrigins,
  BRIDGE_ORIGIN_SENTINEL,
} from "../allowedOrigins.js";

test("BRIDGE_ORIGIN_SENTINEL value is pinned (must match agent-bridge-go)", () => {
  // Any change here requires a lock-step update in
  // agent-bridge-go (`server.BridgeOriginSentinel`). This test catches
  // accidental edits to one half of the contract.
  assert.equal(BRIDGE_ORIGIN_SENTINEL, "https://senpi.agent-bridge.invalid");
});

test("defaults: no env → sentinel + localhost dev fallbacks", () => {
  // No RAILWAY_PUBLIC_DOMAIN (e.g. local Docker run). We still want the
  // browser-based Control UI on the dev host to work, AND the bridge
  // sentinel always present.
  const out = resolveAllowedOrigins({});
  assert.deepEqual(out, [
    BRIDGE_ORIGIN_SENTINEL,
    "http://localhost:8080",
    "http://127.0.0.1:8080",
  ]);
});

test("RAILWAY_PUBLIC_DOMAIN appears after sentinel, before localhost", () => {
  const out = resolveAllowedOrigins({
    RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
  });
  assert.deepEqual(out, [
    BRIDGE_ORIGIN_SENTINEL,
    "https://app.up.railway.app",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
  ]);
});

test("PORT override is reflected in the dev fallbacks", () => {
  const out = resolveAllowedOrigins({ PORT: "3000" });
  assert.deepEqual(out, [
    BRIDGE_ORIGIN_SENTINEL,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ]);
});

test("AGENT_BRIDGE_ALLOWED_ORIGINS extras are appended after defaults", () => {
  const out = resolveAllowedOrigins({
    RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
    AGENT_BRIDGE_ALLOWED_ORIGINS: "https://senpi.ai,https://example.com",
  });
  assert.deepEqual(out, [
    BRIDGE_ORIGIN_SENTINEL,
    "https://app.up.railway.app",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "https://senpi.ai",
    "https://example.com",
  ]);
});

test("AGENT_BRIDGE_ALLOWED_ORIGINS trims whitespace and drops empties", () => {
  const out = resolveAllowedOrigins({
    AGENT_BRIDGE_ALLOWED_ORIGINS: "  https://a , , https://b ",
  });
  assert.ok(out.includes("https://a"));
  assert.ok(out.includes("https://b"));
  // Empty CSV entry (",,") must not become a literal empty string.
  assert.ok(!out.includes(""));
});

test("duplicates across defaults + extras are deduped", () => {
  // Operator overlaps the railway-domain entry — should appear once.
  const out = resolveAllowedOrigins({
    RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
    AGENT_BRIDGE_ALLOWED_ORIGINS: "https://app.up.railway.app",
  });
  const occurrences = out.filter((o) => o === "https://app.up.railway.app");
  assert.equal(occurrences.length, 1);
});

test("operator-supplied sentinel via extras is deduped (still appears once)", () => {
  // Defensive: if an operator copies the sentinel into the env var by
  // accident, the output must not contain it twice.
  const out = resolveAllowedOrigins({
    AGENT_BRIDGE_ALLOWED_ORIGINS: BRIDGE_ORIGIN_SENTINEL,
  });
  const occurrences = out.filter((o) => o === BRIDGE_ORIGIN_SENTINEL);
  assert.equal(occurrences.length, 1);
});

test("wildcard '*' is preserved verbatim (OpenClaw treats it as any-origin)", () => {
  // Per `src/gateway/origin-check.ts`, allowlist containing `*` accepts
  // any origin. We pass it through unchanged so an operator who
  // deliberately opens this up gets the intended behaviour. Sentinel
  // still present alongside — the wildcard does not displace it.
  const out = resolveAllowedOrigins({
    AGENT_BRIDGE_ALLOWED_ORIGINS: "*",
  });
  assert.ok(out.includes("*"));
  assert.ok(out.includes(BRIDGE_ORIGIN_SENTINEL));
});

test("RAILWAY_PUBLIC_DOMAIN trimming + no scheme assumption", () => {
  // RAILWAY_PUBLIC_DOMAIN is bare hostname; the helper always prefixes
  // `https://` (Railway terminates TLS in front).
  const out = resolveAllowedOrigins({
    RAILWAY_PUBLIC_DOMAIN: "  app.up.railway.app  ",
  });
  assert.ok(out.includes("https://app.up.railway.app"));
  // No accidental "https://  app.up.railway.app".
  assert.ok(!out.some((o) => o.includes("  ")));
});

test("sentinel is always first in the output array", () => {
  // Order matters: the sentinel is the load-bearing entry for the
  // bridge chat path. OpenClaw error messages quote the allowlist in
  // operator-facing diagnostics; sentinel-first makes the contract
  // visible at a glance.
  const cases = [
    {},
    { RAILWAY_PUBLIC_DOMAIN: "deploy.up.railway.app" },
    { AGENT_BRIDGE_ALLOWED_ORIGINS: "https://x.example,https://y.example" },
    {
      RAILWAY_PUBLIC_DOMAIN: "deploy.up.railway.app",
      AGENT_BRIDGE_ALLOWED_ORIGINS: "https://later.example",
      PORT: "9000",
    },
  ];
  for (const env of cases) {
    const out = resolveAllowedOrigins(env);
    assert.equal(out[0], BRIDGE_ORIGIN_SENTINEL, `env=${JSON.stringify(env)}`);
  }
});

test("sentinel survives an empty env CSV (existing behaviour for extras)", () => {
  // AGENT_BRIDGE_ALLOWED_ORIGINS="" used to "lock pairings out" by
  // yielding zero extras — but the sentinel + defaults remain.
  const out = resolveAllowedOrigins({ AGENT_BRIDGE_ALLOWED_ORIGINS: "" });
  assert.ok(out.includes(BRIDGE_ORIGIN_SENTINEL));
  assert.ok(out.includes("http://localhost:8080"));
});
