/**
 * Tests for `resolveNotificationsSessionKey` — the helper that hands the
 * orchestrator a stable key for the OpenClaw notifications session.
 *
 * Requirement: the key MUST survive container restarts. If we generated
 * fresh in-memory on every boot, every Railway redeploy would invalidate
 * the orchestrator's stored value and break the bridge's notifications
 * stream. We persist to `<STATE_DIR>/notifications-session-key`,
 * analogous to the existing `<STATE_DIR>/gateway.token` pattern in
 * `src/lib/auth.js`.
 *
 * Run:
 *   node --test src/lib/__tests__/notificationsSessionKey.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { resolveNotificationsSessionKey } from "../notificationsSessionKey.js";

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "notif-key-"));
}

test("creates a stable UUID and persists it on first call", () => {
  const dir = freshDir();
  const key = resolveNotificationsSessionKey(dir);
  // UUIDv4-ish: 36 chars with 4 hyphens.
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  // File written.
  const onDisk = fs.readFileSync(path.join(dir, "notifications-session-key"), "utf8").trim();
  assert.equal(onDisk, key);
});

test("returns the same key on subsequent calls (file round-trip)", () => {
  const dir = freshDir();
  const a = resolveNotificationsSessionKey(dir);
  const b = resolveNotificationsSessionKey(dir);
  const c = resolveNotificationsSessionKey(dir);
  assert.equal(a, b);
  assert.equal(b, c);
});

test("honours a pre-seeded file (operator may want to pin the value)", () => {
  const dir = freshDir();
  const pinned = "deadbeef-cafe-babe-feed-1234567890ab";
  fs.writeFileSync(path.join(dir, "notifications-session-key"), pinned);
  assert.equal(resolveNotificationsSessionKey(dir), pinned);
});

test("trims whitespace from the persisted file", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "notifications-session-key"), "  abc-123  \n");
  assert.equal(resolveNotificationsSessionKey(dir), "abc-123");
});

test("treats an empty/whitespace file as missing — regenerates", () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "notifications-session-key"), "   \n");
  const key = resolveNotificationsSessionKey(dir);
  assert.match(key, /^[0-9a-f-]{36}$/i);
  // The file should now contain the freshly minted key.
  const onDisk = fs.readFileSync(path.join(dir, "notifications-session-key"), "utf8").trim();
  assert.equal(onDisk, key);
});

test("creates the state dir if it doesn't exist (mirrors auth.js behaviour)", () => {
  const dir = path.join(freshDir(), "nested", "state");
  // Don't pre-create — the helper must mkdir -p.
  assert.equal(fs.existsSync(dir), false);
  const key = resolveNotificationsSessionKey(dir);
  assert.match(key, /^[0-9a-f-]{36}$/i);
  assert.equal(fs.existsSync(path.join(dir, "notifications-session-key")), true);
});

test("file is written with 0600 permissions (it's not strictly a secret, but consistent with sibling files)", () => {
  const dir = freshDir();
  resolveNotificationsSessionKey(dir);
  const mode = fs.statSync(path.join(dir, "notifications-session-key")).mode & 0o777;
  assert.equal(mode, 0o600);
});
