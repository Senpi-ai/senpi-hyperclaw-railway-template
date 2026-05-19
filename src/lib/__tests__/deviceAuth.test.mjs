/**
 * Tests for deviceAuth.js — extracted helpers (pure functions).
 *
 * The bug being fixed:
 *
 * On OpenClaw v2026.5.x, `openclaw devices list --json` returns
 *   { "pending": [...], "paired": [...] }
 * NOT a flat array of devices like the wrapper's `deviceAuth.js` previously
 * assumed. So `JSON.parse(output)` yielded an object, `Array.isArray(devices)`
 * was false, and the auto-approval loop silently returned 0 every tick —
 * leaving "scope upgrade" / "repair" pending requests un-approved indefinitely.
 *
 * Operators had to manually run `openclaw devices clear --yes` whenever the
 * gateway requested broader scopes (the agent's exec tool needs operator.admin
 * etc. that paired devices didn't originally have).
 *
 * Fix surface (pure functions, easy to unit-test):
 *   - extractPendingRequests(parsed): handle BOTH shapes (legacy flat array,
 *     modern { pending, paired }). Returns the pending array.
 *   - isLoopbackOperatorRequest(req): predicate. True for requests we want
 *     to auto-approve (operator role + loopback IP + has requestId).
 *
 * Run from repo root:
 *   node --test src/lib/__tests__/deviceAuth.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPendingRequests,
  isLoopbackOperatorRequest,
} from "../deviceAuth.js";

// ─── extractPendingRequests ────────────────────────────────────────────────

test("extractPendingRequests: modern v2026.5.x shape { pending, paired }", () => {
  const parsed = {
    pending: [{ requestId: "abc", deviceId: "d1" }],
    paired: [{ deviceId: "p1" }],
  };
  const result = extractPendingRequests(parsed);
  assert.deepEqual(result, [{ requestId: "abc", deviceId: "d1" }]);
});

test("extractPendingRequests: modern shape with empty pending", () => {
  const parsed = { pending: [], paired: [{ deviceId: "p1" }] };
  assert.deepEqual(extractPendingRequests(parsed), []);
});

test("extractPendingRequests: legacy flat-array shape (v2026.2.x)", () => {
  const parsed = [
    { requestId: "abc", status: "pending", role: "operator" },
    { requestId: "xyz", status: "paired", role: "operator" },
  ];
  // Legacy callers MAY have used a `status` field. For backwards-compat,
  // accept flat arrays too — we filter by status === "pending" only when
  // the array came in shape #2. Modern shape doesn't have a status field.
  const result = extractPendingRequests(parsed);
  assert.deepEqual(result, [
    { requestId: "abc", status: "pending", role: "operator" },
  ]);
});

test("extractPendingRequests: missing `pending` key returns []", () => {
  assert.deepEqual(extractPendingRequests({ paired: [] }), []);
  assert.deepEqual(extractPendingRequests({}), []);
});

test("extractPendingRequests: non-object / null / undefined returns []", () => {
  assert.deepEqual(extractPendingRequests(null), []);
  assert.deepEqual(extractPendingRequests(undefined), []);
  assert.deepEqual(extractPendingRequests("string"), []);
  assert.deepEqual(extractPendingRequests(123), []);
});

test("extractPendingRequests: returns [] when pending is not an array", () => {
  assert.deepEqual(extractPendingRequests({ pending: "oops" }), []);
  assert.deepEqual(extractPendingRequests({ pending: null }), []);
});

// ─── isLoopbackOperatorRequest ─────────────────────────────────────────────

test("isLoopbackOperatorRequest: operator from 127.0.0.1 → true", () => {
  assert.equal(
    isLoopbackOperatorRequest({
      requestId: "r1",
      role: "operator",
      remoteIp: "127.0.0.1",
    }),
    true,
  );
});

test("isLoopbackOperatorRequest: operator via `roles` array → true", () => {
  assert.equal(
    isLoopbackOperatorRequest({
      requestId: "r1",
      roles: ["operator"],
      remoteIp: "127.0.0.1",
    }),
    true,
  );
});

test("isLoopbackOperatorRequest: IPv6 loopback ::1 → true", () => {
  assert.equal(
    isLoopbackOperatorRequest({
      requestId: "r1",
      role: "operator",
      remoteIp: "::1",
    }),
    true,
  );
});

test("isLoopbackOperatorRequest: IPv6-mapped IPv4 loopback → true", () => {
  assert.equal(
    isLoopbackOperatorRequest({
      requestId: "r1",
      role: "operator",
      remoteIp: "::ffff:127.0.0.1",
    }),
    true,
  );
});

test("isLoopbackOperatorRequest: scope-upgrade request still approves (regression for B1)", () => {
  // A "scope upgrade" is just a pending request with isRepair=true and
  // expanded scopes. From the wrapper's POV it's still a loopback operator
  // request that should be auto-approved.
  assert.equal(
    isLoopbackOperatorRequest({
      requestId: "r-scope-upgrade",
      role: "operator",
      remoteIp: "127.0.0.1",
      isRepair: true,
      scopes: ["operator.admin", "operator.approvals", "operator.talk.secrets"],
    }),
    true,
  );
});

test("isLoopbackOperatorRequest: missing requestId → false", () => {
  assert.equal(
    isLoopbackOperatorRequest({
      role: "operator",
      remoteIp: "127.0.0.1",
    }),
    false,
  );
});

test("isLoopbackOperatorRequest: non-loopback IP → false", () => {
  assert.equal(
    isLoopbackOperatorRequest({
      requestId: "r1",
      role: "operator",
      remoteIp: "10.0.0.5",
    }),
    false,
  );
});

test("isLoopbackOperatorRequest: non-operator role → false", () => {
  assert.equal(
    isLoopbackOperatorRequest({
      requestId: "r1",
      role: "viewer",
      remoteIp: "127.0.0.1",
    }),
    false,
  );
});

test("isLoopbackOperatorRequest: no role / no roles → false", () => {
  assert.equal(
    isLoopbackOperatorRequest({
      requestId: "r1",
      remoteIp: "127.0.0.1",
    }),
    false,
  );
});

test("isLoopbackOperatorRequest: missing remoteIp → true (v2026.5.x CLI requests omit it)", () => {
  // v2026.5.x's DevicePairingPendingRequest type declares remoteIp as
  // optional. The CLI flow (clientMode: "cli") doesn't populate it because
  // there is no remote IP — the CLI talks to the gateway in the same
  // container. Verified empirically on openclaw-drop-mcporter-test: a
  // freshly-paired scope-upgrade request comes back with NO remoteIp field.
  // Since the gateway only listens on loopback (wrapper enforces
  // `--bind loopback`), any pending request is by definition local — auto-
  // approving operator-role requests without a remoteIp is safe.
  assert.equal(
    isLoopbackOperatorRequest({
      requestId: "r1",
      role: "operator",
    }),
    true,
  );
});

test("isLoopbackOperatorRequest: empty-string remoteIp → true (same rationale)", () => {
  assert.equal(
    isLoopbackOperatorRequest({
      requestId: "r1",
      role: "operator",
      remoteIp: "",
    }),
    true,
  );
});

test("isLoopbackOperatorRequest: legacy `remote` field (back-compat)", () => {
  // Older OpenClaw builds may have emitted `remote` or `remoteAddr` instead
  // of `remoteIp`. Keep accepting them so a downgrade doesn't break us.
  assert.equal(
    isLoopbackOperatorRequest({
      requestId: "r1",
      role: "operator",
      remote: "127.0.0.1",
    }),
    true,
  );
  assert.equal(
    isLoopbackOperatorRequest({
      requestId: "r1",
      role: "operator",
      remoteAddr: "::1",
    }),
    true,
  );
});
