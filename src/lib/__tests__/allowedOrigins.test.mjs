/**
 * Tests for src/lib/allowedOrigins.js — pure resolver from env to the
 * `gateway.controlUi.allowedOrigins` list openclaw enforces on webchat
 * connects. All inputs are pseudo-process.env objects so the resolver
 * stays deterministic across CI / local.
 *
 * Run:
 *   node --test src/lib/__tests__/allowedOrigins.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { resolveAllowedOrigins } from "../allowedOrigins.js";

test("resolveAllowedOrigins: empty env → only the localhost defaults", () => {
  const out = resolveAllowedOrigins({});
  assert.deepEqual(out, ["http://localhost:8080", "http://127.0.0.1:8080"]);
});

test("resolveAllowedOrigins: AGENT_BRIDGE_ORIGIN is added first when set", () => {
  const out = resolveAllowedOrigins({
    AGENT_BRIDGE_ORIGIN: "https://example.invalid",
  });
  assert.equal(out[0], "https://example.invalid");
});

test("resolveAllowedOrigins: AGENT_BRIDGE_ORIGIN omitted when unset (NO hardcoded default)", () => {
  // The public-repo contract: the sentinel value must not appear in source.
  // When the env var is unset, the slot is simply absent — openclaw will
  // reject the bridge connect, surfacing the misconfig at first request.
  const out = resolveAllowedOrigins({ PORT: "8080" });
  assert.ok(
    out.every((o) => !o.includes("agent-bridge")),
    "no agent-bridge sentinel should be added without AGENT_BRIDGE_ORIGIN",
  );
});

test("resolveAllowedOrigins: AGENT_BRIDGE_ORIGIN whitespace is trimmed; empty → omitted", () => {
  // Operator typo or YAML quirk shouldn't accidentally insert " ".
  const out = resolveAllowedOrigins({ AGENT_BRIDGE_ORIGIN: "   " });
  assert.ok(
    out.every((o) => o.trim() !== ""),
    "whitespace-only sentinel must not be added",
  );
});

test("resolveAllowedOrigins: includes Railway public-domain origin when set", () => {
  const out = resolveAllowedOrigins({
    RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
  });
  assert.ok(out.includes("https://app.up.railway.app"));
});

test("resolveAllowedOrigins: localhost uses PORT when set, falls back to 8080", () => {
  const out = resolveAllowedOrigins({ PORT: "3000" });
  assert.ok(out.includes("http://localhost:3000"));
  assert.ok(out.includes("http://127.0.0.1:3000"));

  const fallback = resolveAllowedOrigins({});
  assert.ok(fallback.includes("http://localhost:8080"));
});

test("resolveAllowedOrigins: AGENT_BRIDGE_ALLOWED_ORIGINS CSV is appended", () => {
  const out = resolveAllowedOrigins({
    AGENT_BRIDGE_ALLOWED_ORIGINS: "https://a.example, https://b.example",
  });
  assert.ok(out.includes("https://a.example"));
  assert.ok(out.includes("https://b.example"));
});

test("resolveAllowedOrigins: deduplicates across all sources", () => {
  // If AGENT_BRIDGE_ORIGIN matches a CSV entry, the resolver MUST emit it
  // once. Otherwise openclaw's allowlist check works fine but the wrapper
  // logs become noisy and the config diff is misleading.
  const out = resolveAllowedOrigins({
    AGENT_BRIDGE_ORIGIN: "https://dup.example",
    AGENT_BRIDGE_ALLOWED_ORIGINS: "https://dup.example,https://other.example",
  });
  assert.equal(
    out.filter((o) => o === "https://dup.example").length,
    1,
  );
});

test("resolveAllowedOrigins: AGENT_BRIDGE_ORIGIN is FIRST in the resulting list", () => {
  // Order matters for human readability when reading openclaw.json — the
  // load-bearing entry should top the list so its presence is obvious.
  const out = resolveAllowedOrigins({
    AGENT_BRIDGE_ORIGIN: "https://sentinel.example",
    RAILWAY_PUBLIC_DOMAIN: "app.up.railway.app",
    AGENT_BRIDGE_ALLOWED_ORIGINS: "https://extra.example",
  });
  assert.equal(out[0], "https://sentinel.example");
});

test("resolveAllowedOrigins: filters empty CSV slots", () => {
  // `",a, ,b,"` should become `[a, b]`, not `["", "a", "", "b", ""]`.
  const out = resolveAllowedOrigins({
    AGENT_BRIDGE_ALLOWED_ORIGINS: ",https://a.example, ,https://b.example,",
  });
  assert.ok(out.includes("https://a.example"));
  assert.ok(out.includes("https://b.example"));
  assert.ok(out.every((o) => o !== "" && o.trim() !== ""));
});

test("resolveAllowedOrigins: wildcard '*' is preserved verbatim", () => {
  // OpenClaw treats `*` as any-origin. Operators who set
  // AGENT_BRIDGE_ALLOWED_ORIGINS=* (e.g. for fully-open dev mode) must
  // get the literal character through to the openclaw config — the
  // resolver must not URL-validate or otherwise rewrite it.
  const out = resolveAllowedOrigins({
    AGENT_BRIDGE_ALLOWED_ORIGINS: "*",
  });
  assert.ok(out.includes("*"));
});

test("resolveAllowedOrigins: RAILWAY_PUBLIC_DOMAIN whitespace is trimmed", () => {
  // Mirrors the AGENT_BRIDGE_ORIGIN trim test above. A misconfigured
  // RAILWAY_PUBLIC_DOMAIN with surrounding whitespace must not produce
  // a malformed `https:// app.up.railway.app` entry in the allowlist.
  const out = resolveAllowedOrigins({
    RAILWAY_PUBLIC_DOMAIN: "  app.up.railway.app  ",
  });
  assert.ok(out.includes("https://app.up.railway.app"));
  assert.ok(
    out.every((o) => o === o.trim()),
    "all entries should be whitespace-clean",
  );
});
