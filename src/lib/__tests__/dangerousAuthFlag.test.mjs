/**
 * Tests for the OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH env-var hatch.
 *
 * Default is OFF: omit `gateway.controlUi.dangerouslyDisableDeviceAuth`
 * from openclaw.json. The flag never engaged for internal clients
 * (different code path) and never engaged for the bridge (isWebchat,
 * not isControlUi). Its only real effect was admitting a remote Control
 * UI browser without pairing — a debugging convenience that operators
 * can re-enable via this env var, otherwise recover from via
 * `railway ssh` + the openclaw CLI.
 *
 * See `src/lib/dangerousAuthFlag.js` for the full rationale.
 *
 * Run:
 *   node --test src/lib/__tests__/dangerousAuthFlag.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { shouldSetDangerousDeviceAuthFlag } from "../dangerousAuthFlag.js";

test("default (var unset) → flag omitted (false)", () => {
  assert.equal(shouldSetDangerousDeviceAuthFlag({}), false);
});

test('explicit "true" → flag written (opt-in for browser Control UI)', () => {
  assert.equal(
    shouldSetDangerousDeviceAuthFlag({
      OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH: "true",
    }),
    true,
  );
});

test('explicit "1" / "yes" / "on" → true (linux-shell idioms)', () => {
  for (const v of ["1", "yes", "on", "YES", "On"]) {
    assert.equal(
      shouldSetDangerousDeviceAuthFlag({
        OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH: v,
      }),
      true,
      `value=${JSON.stringify(v)}`,
    );
  }
});

test('explicit "false" / "0" / "no" / "off" → false (same as default)', () => {
  for (const v of ["false", "0", "no", "off", "FALSE", "Off"]) {
    assert.equal(
      shouldSetDangerousDeviceAuthFlag({
        OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH: v,
      }),
      false,
      `value=${JSON.stringify(v)}`,
    );
  }
});

test("trims whitespace and lowercases input", () => {
  assert.equal(
    shouldSetDangerousDeviceAuthFlag({
      OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH: "  TRUE  ",
    }),
    true,
  );
});

test("unrecognized values (typos, garbage) → false (fail-closed)", () => {
  // Any unrecognised value stays OFF. A typo doesn't accidentally
  // re-enable a `dangerously*` flag — fail closed rather than open.
  for (const val of ["garbage", "TRUE_TYPO", "true!", "1.0", ""]) {
    assert.equal(
      shouldSetDangerousDeviceAuthFlag({
        OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH: val,
      }),
      false,
      `value=${JSON.stringify(val)}`,
    );
  }
});

test("undefined / null env values → false", () => {
  assert.equal(
    shouldSetDangerousDeviceAuthFlag({
      OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH: undefined,
    }),
    false,
  );
});
