/**
 * Tests for the Senpi runtime (re)install decision — the wipe/reinstall trigger
 * extracted from bootstrap.mjs (fleet-update spec §4, item 4).
 *
 * Non-negotiable coverage given the "scope mismatch ⇒ wipe on every boot"
 * failure mode (§4.2) and the transitive-dep incident (§2):
 *   - fresh volume (no record)         → install
 *   - same spec + same nonce           → none (no-op)
 *   - spec change                      → wipeAndInstall
 *   - nonce set for the first time     → wipeAndInstall
 *   - nonce change                     → wipeAndInstall
 *   - nonce removed from env after it
 *     was recorded (empty configured)  → none (latch never fires empty)
 *   - empty-string nonce == absent
 *
 * Run:
 *   node --test src/lib/__tests__/runtimeInstallDecision.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decideRuntimeInstall,
  normalizeNonce,
  NPM_WIPE_TARGETS,
} from "../runtimeInstallDecision.mjs";

const SPEC = "@senpi-ai/runtime";

test("fresh volume (no record) → install, no wipe", () => {
  const d = decideRuntimeInstall({
    record: { exists: false },
    env: { spec: SPEC },
  });
  assert.equal(d.action, "install");
  assert.match(d.reason, /no install record/);
});

test("null / undefined record → install", () => {
  for (const record of [null, undefined]) {
    const d = decideRuntimeInstall({ record, env: { spec: SPEC } });
    assert.equal(d.action, "install", `record=${JSON.stringify(record)}`);
  }
});

test("same spec + no nonce → none (fast-path no-op)", () => {
  const d = decideRuntimeInstall({
    record: { exists: true, spec: SPEC },
    env: { spec: SPEC },
  });
  assert.equal(d.action, "none");
});

test("same spec + same nonce → none (latch already recorded)", () => {
  const d = decideRuntimeInstall({
    record: { exists: true, spec: SPEC, nonce: "2026-07-depfix" },
    env: { spec: SPEC, nonce: "2026-07-depfix" },
  });
  assert.equal(d.action, "none");
});

test("spec change → wipeAndInstall", () => {
  const d = decideRuntimeInstall({
    record: { exists: true, spec: "@senpi/runtime@branch-test", nonce: "n1" },
    env: { spec: SPEC, nonce: "n1" },
  });
  assert.equal(d.action, "wipeAndInstall");
  assert.match(d.reason, /spec changed/);
});

test("spec change takes precedence over a matching nonce", () => {
  const d = decideRuntimeInstall({
    record: { exists: true, spec: "@senpi-ai/runtime@1.0.0" },
    env: { spec: "@senpi-ai/runtime@1.0.1" },
  });
  assert.equal(d.action, "wipeAndInstall");
  assert.match(d.reason, /spec changed/);
});

test("nonce set for the first time (record has no nonce) → wipeAndInstall", () => {
  const d = decideRuntimeInstall({
    record: { exists: true, spec: SPEC }, // no recorded nonce
    env: { spec: SPEC, nonce: "2026-07-depfix" },
  });
  assert.equal(d.action, "wipeAndInstall");
  assert.match(d.reason, /nonce changed/);
});

test("nonce change → wipeAndInstall", () => {
  const d = decideRuntimeInstall({
    record: { exists: true, spec: SPEC, nonce: "old" },
    env: { spec: SPEC, nonce: "new" },
  });
  assert.equal(d.action, "wipeAndInstall");
  assert.match(d.reason, /nonce changed/);
});

test("nonce removed from env after being recorded → none (never fires on empty)", () => {
  // Recorded nonce present, but the operator dropped SENPI_RUNTIME_REINSTALL_NONCE.
  // Empty/absent configured nonce means "never force" — must NOT re-wipe.
  for (const envNonce of [undefined, "", "   "]) {
    const d = decideRuntimeInstall({
      record: { exists: true, spec: SPEC, nonce: "was-set" },
      env: { spec: SPEC, nonce: envNonce },
    });
    assert.equal(
      d.action,
      "none",
      `envNonce=${JSON.stringify(envNonce)} should no-op`,
    );
  }
});

test("empty-string configured nonce == absent (no force on fresh-nonce record)", () => {
  const d = decideRuntimeInstall({
    record: { exists: true, spec: SPEC }, // no recorded nonce
    env: { spec: SPEC, nonce: "" },
  });
  assert.equal(d.action, "none");
});

test("whitespace-only nonce is treated as empty", () => {
  const d = decideRuntimeInstall({
    record: { exists: true, spec: SPEC },
    env: { spec: SPEC, nonce: "\n\t " },
  });
  assert.equal(d.action, "none");
});

test("nonce comparison is trimmed on both sides (record vs env)", () => {
  // Same logical value with stray whitespace must not spuriously trigger.
  const d = decideRuntimeInstall({
    record: { exists: true, spec: SPEC, nonce: "depfix" },
    env: { spec: SPEC, nonce: "  depfix\n" },
  });
  assert.equal(d.action, "none");
});

test("normalizeNonce: absent/empty/whitespace collapse to empty string", () => {
  assert.equal(normalizeNonce(undefined), "");
  assert.equal(normalizeNonce(null), "");
  assert.equal(normalizeNonce(""), "");
  assert.equal(normalizeNonce("   "), "");
  assert.equal(normalizeNonce("  x "), "x");
  assert.equal(normalizeNonce(123), "123");
});

test("NPM_WIPE_TARGETS: node_modules + lockfile + manifest, nothing else", () => {
  // The lockfile is load-bearing: `openclaw plugins install` runs npm install
  // with npm_config_package_lock=true (openclaw v2026.5.7
  // src/plugins/install.ts:1375-1398), so a surviving package-lock.json
  // re-pins the exact stale transitive-dep tree and the wipe accomplishes
  // nothing. The manifest merges dependencies on upsert
  // (src/infra/npm-managed-root.ts:184-224), so a stale old-scope entry would
  // be reinstalled alongside the new one. All three are regenerated on
  // install. Changing this set requires re-verifying regeneration against the
  // pinned openclaw source — see the NPM_WIPE_TARGETS doc comment.
  assert.deepEqual(
    [...NPM_WIPE_TARGETS].toSorted(),
    ["node_modules", "package-lock.json", "package.json"],
  );
});

test("NPM_WIPE_TARGETS: plain names only — no separators or traversal segments", () => {
  // bootstrap.mjs joins each target directly under STATE_DIR/npm and asserts
  // the resolved path stays there; keep the inputs trivially safe too.
  for (const target of NPM_WIPE_TARGETS) {
    assert.ok(!target.includes("/") && !target.includes("\\"), target);
    assert.notEqual(target, "..");
    assert.notEqual(target, ".");
  }
});

test("NPM_WIPE_TARGETS is frozen (no runtime mutation of the wipe set)", () => {
  assert.ok(Object.isFrozen(NPM_WIPE_TARGETS));
});
