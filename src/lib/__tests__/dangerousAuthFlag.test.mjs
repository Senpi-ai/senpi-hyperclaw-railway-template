/**
 * Tests for the OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH env-var hatch.
 *
 * The wrapper used to unconditionally write
 * `gateway.controlUi.dangerouslyDisableDeviceAuth=true`. The hatch keeps
 * that as the default (so existing deployments are unaffected) and lets
 * an operator opt out by setting the env var to `false` / `0`.
 *
 * See `src/lib/dangerousAuthFlag.js` for the trust-boundary rationale.
 *
 * Run:
 *   node --test src/lib/__tests__/dangerousAuthFlag.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { shouldSetDangerousDeviceAuthFlag } from "../dangerousAuthFlag.js";

test("default (var unset) → keep flag on (true)", () => {
  assert.equal(shouldSetDangerousDeviceAuthFlag({}), true);
});

test("explicit \"true\" → true", () => {
  assert.equal(
    shouldSetDangerousDeviceAuthFlag({
      OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH: "true",
    }),
    true,
  );
});

test("explicit \"false\" → false (omit flag)", () => {
  assert.equal(
    shouldSetDangerousDeviceAuthFlag({
      OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH: "false",
    }),
    false,
  );
});

test("explicit \"0\" → false", () => {
  assert.equal(
    shouldSetDangerousDeviceAuthFlag({
      OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH: "0",
    }),
    false,
  );
});

test("explicit \"no\" / \"off\" → false (linux-shell idioms)", () => {
  assert.equal(
    shouldSetDangerousDeviceAuthFlag({
      OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH: "no",
    }),
    false,
  );
  assert.equal(
    shouldSetDangerousDeviceAuthFlag({
      OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH: "off",
    }),
    false,
  );
});

test("trims whitespace and lowercases input", () => {
  assert.equal(
    shouldSetDangerousDeviceAuthFlag({
      OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH: "  FALSE  ",
    }),
    false,
  );
});

test("unrecognized values (typos, garbage) → keep flag on (safe default)", () => {
  // Conservative default: if an operator typos the env var, we keep the
  // current behaviour rather than silently disabling the flag. Better to
  // be loudly unchanged than quietly different.
  for (const val of ["1", "yes", "garbage", "FALSE_TYPO", "true!", ""]) {
    assert.equal(
      shouldSetDangerousDeviceAuthFlag({
        OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH: val,
      }),
      true,
      `value=${JSON.stringify(val)}`,
    );
  }
});
