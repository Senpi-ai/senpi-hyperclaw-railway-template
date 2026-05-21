/**
 * Tests for src/routes/issue-bootstrap-token.js.
 *
 * Uses node:test + the built-in node:http stack to drive the express
 * route against an injected loadPluginSDK stub. No vitest, no supertest —
 * the wrapper repo's test runner is `node --test`.
 *
 * Run from repo root:
 *   node --test src/routes/__tests__/issue-bootstrap-token.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { createIssueBootstrapTokenRoute } from "../issue-bootstrap-token.js";

function bootApp(deps) {
  const app = express();
  app.use(express.json());
  app.use("/setup/api", createIssueBootstrapTokenRoute(deps));
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => new Promise((r) => srv.close(r)) });
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

test("issue-bootstrap-token: returns a freshly minted token on success", async (t) => {
  let calls = 0;
  const fakeIssue = async () => {
    calls += 1;
    return { token: "tok-abc", ttlSeconds: 600 };
  };
  const app = await bootApp({ loadPluginSDK: async () => ({ issueDeviceBootstrapToken: fakeIssue }) });
  t.after(() => app.close());

  const res = await postJSON(`${app.baseUrl}/setup/api/issue-bootstrap-token`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.bootstrapToken, "tok-abc");
  assert.equal(res.body.ttlSeconds, 600);
  assert.match(res.body.issuedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(calls, 1);
});

test("issue-bootstrap-token: returns 503 if plugin-SDK module fails to load", async (t) => {
  const app = await bootApp({
    loadPluginSDK: async () => {
      throw new Error("ENOENT");
    },
  });
  t.after(() => app.close());

  const res = await postJSON(`${app.baseUrl}/setup/api/issue-bootstrap-token`, {});
  assert.equal(res.status, 503);
  assert.match(res.body.error, /plugin-sdk/i);
});

test("issue-bootstrap-token: returns 500 if issueDeviceBootstrapToken throws", async (t) => {
  const fakeIssue = async () => {
    throw new Error("boom");
  };
  const app = await bootApp({ loadPluginSDK: async () => ({ issueDeviceBootstrapToken: fakeIssue }) });
  t.after(() => app.close());

  const res = await postJSON(`${app.baseUrl}/setup/api/issue-bootstrap-token`, {});
  assert.equal(res.status, 500);
  assert.match(res.body.error, /threw/i);
});

test("issue-bootstrap-token: returns 429 once rate limit exceeded", async (t) => {
  // Inject a tight limiter (max=2) so the test does not need a clock or 60s
  // of wall time to hit the cap.
  const { createIpRateLimiter } = await import("../../lib/rateLimit.js");
  const rateLimiter = createIpRateLimiter({ windowMs: 60_000, max: 2 });
  const fakeIssue = async () => ({ token: "tok-rl", ttlSeconds: 600 });
  const app = await bootApp({
    loadPluginSDK: async () => ({ issueDeviceBootstrapToken: fakeIssue }),
    rateLimiter,
  });
  t.after(() => app.close());

  let res = await postJSON(`${app.baseUrl}/setup/api/issue-bootstrap-token`, {});
  assert.equal(res.status, 200);
  res = await postJSON(`${app.baseUrl}/setup/api/issue-bootstrap-token`, {});
  assert.equal(res.status, 200);
  res = await postJSON(`${app.baseUrl}/setup/api/issue-bootstrap-token`, {});
  assert.equal(res.status, 429);
  assert.equal(res.body.error, "rate limit exceeded");
  assert.equal(typeof res.body.retryAfterSeconds, "number");
});
