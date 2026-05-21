/**
 * Tests for devicePairingNode.js — pure helpers only.
 *
 * The async approve path (`approveDeviceLocally`) is exercised by the
 * deployed wrapper against a real openclaw install; we do not mock the
 * openclaw bundle here because the bug it covers (v2026.5.x scope-upgrade
 * trap) is integration-shaped and only meaningful end-to-end. What we DO
 * cover here is the pure shape-mapping the caller depends on:
 *
 *   - resolveDeviceBootstrapUrl(env): derive the file:// URL of the
 *     `device-bootstrap.js` module from OPENCLAW_ENTRY (or the default).
 *   - classifyLocalApproveResult(raw): map the openclaw result shape to
 *     a uniform `{ ok, detail }` outcome the wrapper can log + count.
 *
 * Run from repo root:
 *   node --test src/lib/__tests__/devicePairingNode.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import {
  resolveDeviceBootstrapUrl,
  classifyLocalApproveResult,
  listDevicePairingLocally,
  approveDeviceLocally,
  __setBootstrapModuleLoaderForTest,
} from "../devicePairingNode.js";
import { STATE_DIR } from "../config.js";

// ─── resolveDeviceBootstrapUrl ─────────────────────────────────────────────

test("resolveDeviceBootstrapUrl: default OPENCLAW_ENTRY → /openclaw/dist/plugin-sdk/device-bootstrap.js", () => {
  const url = resolveDeviceBootstrapUrl({});
  assert.equal(
    url,
    pathToFileURL("/openclaw/dist/plugin-sdk/device-bootstrap.js").href,
  );
});

test("resolveDeviceBootstrapUrl: honors OPENCLAW_ENTRY override", () => {
  const url = resolveDeviceBootstrapUrl({
    OPENCLAW_ENTRY: "/opt/oc/dist/entry.js",
  });
  assert.equal(
    url,
    pathToFileURL("/opt/oc/dist/plugin-sdk/device-bootstrap.js").href,
  );
});

test("resolveDeviceBootstrapUrl: empty OPENCLAW_ENTRY falls back to default", () => {
  const url = resolveDeviceBootstrapUrl({ OPENCLAW_ENTRY: "" });
  assert.equal(
    url,
    pathToFileURL("/openclaw/dist/plugin-sdk/device-bootstrap.js").href,
  );
});

test("resolveDeviceBootstrapUrl: handles entry inside a nested dist path", () => {
  const url = resolveDeviceBootstrapUrl({
    OPENCLAW_ENTRY: "/home/node/openclaw-build/dist/entry.js",
  });
  assert.equal(
    url,
    pathToFileURL(
      "/home/node/openclaw-build/dist/plugin-sdk/device-bootstrap.js",
    ).href,
  );
});

// ─── classifyLocalApproveResult ────────────────────────────────────────────

test("classifyLocalApproveResult: { status: 'approved', device } → ok with deviceId in detail", () => {
  const outcome = classifyLocalApproveResult({
    status: "approved",
    requestId: "r1",
    device: { deviceId: "dev-abc-123", role: "operator" },
  });
  assert.deepEqual(outcome, { ok: true, detail: "device=dev-abc-123" });
});

test("classifyLocalApproveResult: approved without deviceId → ok with 'unknown'", () => {
  // Defensive: if openclaw ever returns approved with no deviceId we still
  // count the approval (the write happened) — we just can't name the device.
  const outcome = classifyLocalApproveResult({
    status: "approved",
    requestId: "r1",
    device: {},
  });
  assert.deepEqual(outcome, { ok: true, detail: "device=unknown" });
});

test("classifyLocalApproveResult: approved with null device → ok with 'unknown'", () => {
  const outcome = classifyLocalApproveResult({
    status: "approved",
    requestId: "r1",
    device: null,
  });
  assert.deepEqual(outcome, { ok: true, detail: "device=unknown" });
});

test("classifyLocalApproveResult: null → not-ok, raced detail", () => {
  // openclaw returns null when the requestId is no longer in pending —
  // common race with a fresh CLI invocation that supersedes the request.
  const outcome = classifyLocalApproveResult(null);
  assert.deepEqual(outcome, {
    ok: false,
    detail: "request no longer pending (raced)",
  });
});

test("classifyLocalApproveResult: undefined → not-ok, raced detail", () => {
  const outcome = classifyLocalApproveResult(undefined);
  assert.deepEqual(outcome, {
    ok: false,
    detail: "request no longer pending (raced)",
  });
});

test("classifyLocalApproveResult: { status: 'forbidden', reason, scope } → not-ok, formatted detail", () => {
  const outcome = classifyLocalApproveResult({
    status: "forbidden",
    reason: "caller-missing-scope",
    scope: "operator.admin",
  });
  assert.deepEqual(outcome, {
    ok: false,
    detail: "forbidden: caller-missing-scope scope=operator.admin",
  });
});

test("classifyLocalApproveResult: forbidden without scope field", () => {
  const outcome = classifyLocalApproveResult({
    status: "forbidden",
    reason: "scope-outside-requested-roles",
  });
  assert.deepEqual(outcome, {
    ok: false,
    detail: "forbidden: scope-outside-requested-roles",
  });
});

test("classifyLocalApproveResult: forbidden with missing reason → unknown-reason", () => {
  const outcome = classifyLocalApproveResult({ status: "forbidden" });
  assert.deepEqual(outcome, {
    ok: false,
    detail: "forbidden: unknown-reason",
  });
});

test("classifyLocalApproveResult: unknown status → not-ok with status echoed", () => {
  const outcome = classifyLocalApproveResult({ status: "pending" });
  assert.deepEqual(outcome, {
    ok: false,
    detail: "unexpected status: pending",
  });
});

test("classifyLocalApproveResult: non-object result → not-ok, JSON detail", () => {
  // If a future openclaw API change returns a string or number we should
  // surface that verbatim instead of silently counting it as success.
  const outcome = classifyLocalApproveResult("bogus");
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /unexpected result/);
});

// ─── baseDir forwarding (regression: wrapper must NOT let the SDK guess the
// state dir from process.env — it has none in the wrapper process, so the
// SDK falls back to ~/.openclaw and never sees the gateway's pending
// requests under /data/.openclaw). The wrapper passes its own STATE_DIR. ──

function fakeBootstrapModule() {
  const calls = { list: [], approve: [] };
  const mod = {
    listDevicePairing: async (...args) => {
      calls.list.push(args);
      return { pending: [], paired: [] };
    },
    approveDevicePairing: async (...args) => {
      calls.approve.push(args);
      return { status: "approved", device: { deviceId: "d1" } };
    },
  };
  return { mod, calls };
}

test("listDevicePairingLocally: forwards STATE_DIR as baseDir by default", async () => {
  const { mod, calls } = fakeBootstrapModule();
  __setBootstrapModuleLoaderForTest(async () => mod);
  try {
    await listDevicePairingLocally();
    assert.equal(calls.list.length, 1);
    assert.deepEqual(calls.list[0], [STATE_DIR]);
    assert.equal(calls.list[0][0], "/data/.openclaw");
  } finally {
    __setBootstrapModuleLoaderForTest(null);
  }
});

test("listDevicePairingLocally: honors an explicit baseDir override", async () => {
  const { mod, calls } = fakeBootstrapModule();
  __setBootstrapModuleLoaderForTest(async () => mod);
  try {
    await listDevicePairingLocally("/custom/state");
    assert.deepEqual(calls.list[0], ["/custom/state"]);
  } finally {
    __setBootstrapModuleLoaderForTest(null);
  }
});

test("approveDeviceLocally: passes (requestId, {callerScopes}, STATE_DIR)", async () => {
  const { mod, calls } = fakeBootstrapModule();
  __setBootstrapModuleLoaderForTest(async () => mod);
  try {
    await approveDeviceLocally("req-1");
    assert.equal(calls.approve.length, 1);
    const [reqId, options, baseDir] = calls.approve[0];
    assert.equal(reqId, "req-1");
    assert.equal(baseDir, STATE_DIR);
    assert.equal(baseDir, "/data/.openclaw");
    assert.deepEqual(options.callerScopes, [
      "operator.admin",
      "operator.approvals",
    ]);
  } finally {
    __setBootstrapModuleLoaderForTest(null);
  }
});

test("approveDeviceLocally: honors an explicit baseDir override", async () => {
  const { mod, calls } = fakeBootstrapModule();
  __setBootstrapModuleLoaderForTest(async () => mod);
  try {
    await approveDeviceLocally("req-1", "/custom/state");
    const [, , baseDir] = calls.approve[0];
    assert.equal(baseDir, "/custom/state");
  } finally {
    __setBootstrapModuleLoaderForTest(null);
  }
});

test("approveDeviceLocally: callerScopes includes BOTH admin and approvals (admin alone 403s approval-resolve)", async () => {
  const { mod, calls } = fakeBootstrapModule();
  __setBootstrapModuleLoaderForTest(async () => mod);
  try {
    await approveDeviceLocally("req-1");
    const options = calls.approve[0][1];
    assert.ok(options.callerScopes.includes("operator.admin"));
    assert.ok(options.callerScopes.includes("operator.approvals"));
  } finally {
    __setBootstrapModuleLoaderForTest(null);
  }
});
