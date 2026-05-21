/**
 * Tests for src/lib/rateLimit.js.
 *
 * The limiter is a sliding window over a Map of timestamps. Tests inject a
 * controllable clock and key extractor so behavior is deterministic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { createIpRateLimiter } from "../rateLimit.js";

function bootApp(limiter) {
  const app = express();
  app.use(limiter);
  app.get("/", (_req, res) => res.json({ ok: true }));
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

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    http
      .request(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: "GET",
        },
        (res) => {
          let buf = "";
          res.on("data", (d) => (buf += d));
          res.on("end", () => {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: buf ? JSON.parse(buf) : null,
            });
          });
        },
      )
      .on("error", reject)
      .end();
  });
}

test("createIpRateLimiter: allows requests up to max within window", async (t) => {
  const limiter = createIpRateLimiter({ windowMs: 60_000, max: 3 });
  const app = await bootApp(limiter);
  t.after(() => app.close());

  for (let i = 0; i < 3; i++) {
    const res = await getJSON(`${app.baseUrl}/`);
    assert.equal(res.status, 200, `request ${i + 1} should pass`);
  }
});

test("createIpRateLimiter: returns 429 with Retry-After once max exceeded", async (t) => {
  const limiter = createIpRateLimiter({ windowMs: 60_000, max: 2 });
  const app = await bootApp(limiter);
  t.after(() => app.close());

  await getJSON(`${app.baseUrl}/`);
  await getJSON(`${app.baseUrl}/`);
  const res = await getJSON(`${app.baseUrl}/`);
  assert.equal(res.status, 429);
  assert.equal(res.body.error, "rate limit exceeded");
  assert.equal(typeof res.body.retryAfterSeconds, "number");
  assert.ok(res.body.retryAfterSeconds > 0);
  assert.ok(res.headers["retry-after"]);
  assert.equal(
    String(res.body.retryAfterSeconds),
    res.headers["retry-after"],
  );
});

test("createIpRateLimiter: window slides — expired entries free up slots", () => {
  let clock = 1_000_000;
  const limiter = createIpRateLimiter({
    windowMs: 1_000,
    max: 2,
    keyFn: () => "k1",
    now: () => clock,
  });

  const drive = () => {
    let status = 0;
    const req = {};
    const res = {
      set: () => res,
      status: (s) => {
        status = s;
        return res;
      },
      json: () => res,
    };
    let nextCalled = false;
    limiter(req, res, () => {
      nextCalled = true;
    });
    return { status: nextCalled ? 200 : status, nextCalled };
  };

  assert.equal(drive().status, 200);
  assert.equal(drive().status, 200);
  // Third within window → rejected.
  assert.equal(drive().status, 429);

  // Advance past the window — both prior entries expire.
  clock += 1_500;
  assert.equal(drive().status, 200);
  assert.equal(drive().status, 200);
  assert.equal(drive().status, 429);
});

test("createIpRateLimiter: keys isolated — different IPs do not share bucket", () => {
  let nextKey = "ip-a";
  const limiter = createIpRateLimiter({
    windowMs: 60_000,
    max: 1,
    keyFn: () => nextKey,
  });

  const drive = () => {
    let status = 0;
    let nextCalled = false;
    limiter(
      {},
      {
        set: function () {
          return this;
        },
        status(s) {
          status = s;
          return this;
        },
        json() {
          return this;
        },
      },
      () => {
        nextCalled = true;
      },
    );
    return nextCalled ? 200 : status;
  };

  assert.equal(drive(), 200, "ip-a: first allowed");
  assert.equal(drive(), 429, "ip-a: second rejected");

  nextKey = "ip-b";
  assert.equal(drive(), 200, "ip-b: first allowed (separate bucket)");
  assert.equal(drive(), 429, "ip-b: second rejected");
});
