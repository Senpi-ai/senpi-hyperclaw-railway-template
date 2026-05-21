/**
 * Tests for src/routes/approve-device-pairing.js.
 *
 * Mirrors the issue-bootstrap-token tests: node:test + node:http +
 * an injected loadPluginSDK stub.
 *
 * Run from repo root:
 *   node --test src/routes/__tests__/approve-device-pairing.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createApproveDevicePairingRoute } from "../approve-device-pairing.js";

function bootApp(deps) {
  const app = express();
  app.use(express.json());
  app.use("/setup/api", createApproveDevicePairingRoute(deps));
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
    srv.on("error", reject);
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(buf || "null") });
          } catch (err) {
            reject(new Error(`bad json: ${buf}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const DEVICE_ID = "ab65d400fdf884bf28b4226996cdac375a733d262593025d1eb3359962e14cdf";
const PUBLIC_KEY = "7jzbdlLHusGphbT3LGqsbddh84LgM-y7S3cxO7u2Rgc";

function pendingFixture(overrides = {}) {
  return {
    requestId: "req-1",
    deviceId: DEVICE_ID,
    publicKey: PUBLIC_KEY,
    role: "operator",
    scopes: ["operator.read"],
    remoteIp: "100.64.0.10",
    ...overrides,
  };
}

test("approve-device-pairing: approves a matching pending and returns the deviceId", async (t) => {
  let listCalls = 0;
  let approveCalls = 0;
  const fakeList = async () => {
    listCalls += 1;
    return { pending: [pendingFixture()], paired: [] };
  };
  const fakeApprove = async (requestId, opts) => {
    approveCalls += 1;
    assert.equal(requestId, "req-1");
    assert.deepEqual(opts, { callerScopes: ["operator.admin"] });
    return {
      status: "approved",
      requestId,
      device: { deviceId: DEVICE_ID, role: "operator" },
    };
  };
  const app = await bootApp({
    loadPluginSDK: async () => ({
      listDevicePairing: fakeList,
      approveDevicePairing: fakeApprove,
    }),
  });
  t.after(() => app.close());

  const res = await postJSON(`${app.baseUrl}/setup/api/approve-device-pairing`, {
    deviceId: DEVICE_ID,
    publicKey: PUBLIC_KEY,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "approved");
  assert.equal(res.body.deviceId, DEVICE_ID);
  assert.equal(res.body.requestId, "req-1");
  assert.equal(listCalls, 1);
  assert.equal(approveCalls, 1);
});

test("approve-device-pairing: returns no-pending when nothing matches", async (t) => {
  const app = await bootApp({
    loadPluginSDK: async () => ({
      listDevicePairing: async () => ({ pending: [], paired: [] }),
      approveDevicePairing: async () => {
        throw new Error("must not be called");
      },
    }),
  });
  t.after(() => app.close());

  const res = await postJSON(`${app.baseUrl}/setup/api/approve-device-pairing`, {
    deviceId: DEVICE_ID,
    publicKey: PUBLIC_KEY,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "no-pending");
});

test("approve-device-pairing: deviceId+publicKey must BOTH match (defense in depth)", async (t) => {
  // Pending exists with the right deviceId but a different publicKey —
  // simulate a stolen-deviceId-with-fresh-keypair attempt. Must fall
  // through to no-pending, NOT silently approve.
  const fakeList = async () => ({
    pending: [pendingFixture({ publicKey: "different-pubkey" })],
    paired: [],
  });
  let approveCalls = 0;
  const app = await bootApp({
    loadPluginSDK: async () => ({
      listDevicePairing: fakeList,
      approveDevicePairing: async () => {
        approveCalls += 1;
        return { status: "approved" };
      },
    }),
  });
  t.after(() => app.close());

  const res = await postJSON(`${app.baseUrl}/setup/api/approve-device-pairing`, {
    deviceId: DEVICE_ID,
    publicKey: PUBLIC_KEY,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "no-pending");
  assert.equal(approveCalls, 0, "approveDevicePairing must not be called on publicKey mismatch");
});

test("approve-device-pairing: races between list+approve surface as no-pending", async (t) => {
  // approveDevicePairing returns `null` when the pending was resolved by
  // a concurrent approver — wrapper-internal loops also approve, so this
  // is normal under load. Surface as no-pending so the orchestrator's
  // reconnect path doesn't treat it as an error.
  const fakeApprove = async () => null;
  const app = await bootApp({
    loadPluginSDK: async () => ({
      listDevicePairing: async () => ({ pending: [pendingFixture()], paired: [] }),
      approveDevicePairing: fakeApprove,
    }),
  });
  t.after(() => app.close());

  const res = await postJSON(`${app.baseUrl}/setup/api/approve-device-pairing`, {
    deviceId: DEVICE_ID,
    publicKey: PUBLIC_KEY,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "no-pending");
});

test("approve-device-pairing: forbidden result surfaces as 422 with reason+scope", async (t) => {
  const fakeApprove = async () => ({
    status: "forbidden",
    reason: "caller-missing-scope",
    scope: "operator.write",
  });
  const app = await bootApp({
    loadPluginSDK: async () => ({
      listDevicePairing: async () => ({ pending: [pendingFixture()], paired: [] }),
      approveDevicePairing: fakeApprove,
    }),
  });
  t.after(() => app.close());

  const res = await postJSON(`${app.baseUrl}/setup/api/approve-device-pairing`, {
    deviceId: DEVICE_ID,
    publicKey: PUBLIC_KEY,
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.error, "approve_forbidden");
  assert.equal(res.body.reason, "caller-missing-scope");
  assert.equal(res.body.scope, "operator.write");
});

test("approve-device-pairing: rejects missing deviceId with 400", async (t) => {
  const app = await bootApp({ loadPluginSDK: async () => ({}) });
  t.after(() => app.close());

  const res = await postJSON(`${app.baseUrl}/setup/api/approve-device-pairing`, {
    publicKey: PUBLIC_KEY,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "invalid_request");
  assert.match(res.body.detail, /deviceId/);
});

test("approve-device-pairing: rejects missing publicKey with 400", async (t) => {
  const app = await bootApp({ loadPluginSDK: async () => ({}) });
  t.after(() => app.close());

  const res = await postJSON(`${app.baseUrl}/setup/api/approve-device-pairing`, {
    deviceId: DEVICE_ID,
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, "invalid_request");
  assert.match(res.body.detail, /publicKey/);
});

test("approve-device-pairing: rejects shape-invalid deviceId with 400", async (t) => {
  const app = await bootApp({ loadPluginSDK: async () => ({}) });
  t.after(() => app.close());

  const res = await postJSON(`${app.baseUrl}/setup/api/approve-device-pairing`, {
    deviceId: "has spaces and /slashes",
    publicKey: PUBLIC_KEY,
  });
  assert.equal(res.status, 400);
  assert.match(res.body.detail, /deviceId/);
});

test("approve-device-pairing: returns 503 if plugin-SDK module fails to load", async (t) => {
  const app = await bootApp({
    loadPluginSDK: async () => {
      throw new Error("ENOENT");
    },
  });
  t.after(() => app.close());

  const res = await postJSON(`${app.baseUrl}/setup/api/approve-device-pairing`, {
    deviceId: DEVICE_ID,
    publicKey: PUBLIC_KEY,
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "plugin_sdk_not_loadable");
});
