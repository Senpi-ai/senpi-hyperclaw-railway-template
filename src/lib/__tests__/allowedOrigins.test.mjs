/**
 * Tests for the allowed-origins resolver used by all four
 * `openclaw.json` write-sites (bootstrap.mjs, onboard.js, gateway.js,
 * setup.js).
 *
 * OpenClaw v2026.5.x rejects webchat-class connections (including the
 * agent-bridge from Senpi-ai/agent-bridge `v3/go-rewrite`) when the
 * `Origin` header is missing or not in `gateway.controlUi.allowedOrigins`.
 * We auto-populate Railway's public domain + localhost dev fallbacks so
 * the bridge works out-of-the-box.
 *
 * Run:
 *   node --test src/lib/__tests__/allowedOrigins.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveAllowedOrigins } from "../allowedOrigins.js";

test("defaults: no env → localhost dev fallbacks only", () => {
  // No RAILWAY_PUBLIC_DOMAIN (e.g. local Docker run). We still want the
  // browser-based Control UI on the dev host to work, so emit the
  // localhost pair.
  const out = resolveAllowedOrigins({});
  assert.deepEqual(out, ["http://localhost:8080", "http://127.0.0.1:8080"]);
});

test("RAILWAY_PUBLIC_DOMAIN is prepended as https://", () => {
  const out = resolveAllowedOrigins({
    RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
  });
  assert.deepEqual(out, [
    "https://app.up.railway.app",
    "http://localhost:8080",
    "http://127.0.0.1:8080",
  ]);
});

test("PORT override is reflected in the dev fallbacks", () => {
  const out = resolveAllowedOrigins({ PORT: "3000" });
  assert.deepEqual(out, ["http://localhost:3000", "http://127.0.0.1:3000"]);
});

test("AGENT_BRIDGE_ALLOWED_ORIGINS extras are appended", () => {
  const out = resolveAllowedOrigins({
    RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
    AGENT_BRIDGE_ALLOWED_ORIGINS: "https://senpi.ai,https://example.com",
  });
  assert.deepEqual(out, [
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
  // Defaults (localhost) followed by the two trimmed extras.
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

test("wildcard '*' is preserved verbatim (OpenClaw treats it as any-origin)", () => {
  // Per `src/gateway/origin-check.ts`, allowlist containing `*` accepts
  // any origin. We pass it through unchanged so an operator who
  // deliberately opens this up gets the intended behaviour.
  const out = resolveAllowedOrigins({
    AGENT_BRIDGE_ALLOWED_ORIGINS: "*",
  });
  assert.ok(out.includes("*"));
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

test("preserves insertion order: railway → dev fallback → extras", () => {
  // Order matters because OpenClaw documents the allowlist in this
  // sequence in operator-facing error messages.
  const out = resolveAllowedOrigins({
    RAILWAY_PUBLIC_DOMAIN: "deploy.up.railway.app",
    AGENT_BRIDGE_ALLOWED_ORIGINS: "https://later.example",
  });
  assert.equal(out[0], "https://deploy.up.railway.app");
  assert.equal(out[out.length - 1], "https://later.example");
});
