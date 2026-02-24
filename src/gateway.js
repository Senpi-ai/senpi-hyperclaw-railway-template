/**
 * Gateway lifecycle: start, ensure running, restart, wait for ready.
 * State: single process (gatewayProc) and startup promise (gatewayStarting).
 */

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  STATE_DIR,
  WORKSPACE_DIR,
  GATEWAY_TARGET,
  INTERNAL_GATEWAY_PORT,
  GATEWAY_READY_TIMEOUT_MS,
  OPENCLAW_ENTRY,
  OPENCLAW_NODE,
  configPath,
  isConfigured,
} from "./lib/config.js";
import { tokenLogSafe } from "./lib/auth.js";
import { runCmd } from "./lib/runCmd.js";

let gatewayProc = null;
let gatewayStarting = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Remove stale session lock files left by a previous gateway process (e.g. after restart).
 * Prevents "session file locked (timeout 10000ms)" when the new process starts.
 */
function clearStaleSessionLocks() {
  const agentsDir = path.join(STATE_DIR, "agents");
  if (!fs.existsSync(agentsDir)) return;
  let removed = 0;
  try {
    for (const agent of fs.readdirSync(agentsDir)) {
      const sessionsDir = path.join(agentsDir, agent, "sessions");
      if (!fs.existsSync(sessionsDir)) continue;
      for (const name of fs.readdirSync(sessionsDir)) {
        if (name.endsWith(".lock")) {
          try {
            fs.unlinkSync(path.join(sessionsDir, name));
            removed++;
          } catch {
            // ignore
          }
        }
      }
    }
    if (removed > 0) {
      console.log(`[gateway] Cleared ${removed} stale session lock file(s)`);
    }
  } catch (err) {
    console.warn(`[gateway] clearStaleSessionLocks: ${err.message}`);
  }
}

/**
 * @param {string[]} args - openclaw CLI args (without entry)
 * @returns {string[]} full args with entry
 */
export function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

/**
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? GATEWAY_READY_TIMEOUT_MS;
  const start = Date.now();
  const endpoints = ["/openclaw", "/openclaw", "/", "/health"];

  while (Date.now() - start < timeoutMs) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${GATEWAY_TARGET}${endpoint}`, { method: "GET" });
        if (res) {
          console.log(`[gateway] ready at ${endpoint}`);
          return true;
        }
      } catch {
        // not ready
      }
    }
    await sleep(250);
  }
  console.error(`[gateway] failed to become ready after ${timeoutMs}ms`);
  return false;
}

/**
 * Start the gateway process. Idempotent if already running.
 * @param {string} gatewayToken - OPENCLAW_GATEWAY_TOKEN
 */
export async function startGateway(gatewayToken) {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  clearStaleSessionLocks();

  console.log(`[gateway] ========== GATEWAY START TOKEN SYNC ==========`);
  console.log(
    `[gateway] Syncing wrapper token to config (fingerprint: ${tokenLogSafe(gatewayToken)}, len: ${gatewayToken.length})`
  );

  const syncResult = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["config", "set", "gateway.auth.token", gatewayToken])
  );

  console.log(`[gateway] Sync result: exit code ${syncResult.code}`);
  if (syncResult.output?.trim()) {
    console.log(`[gateway] Sync output: ${syncResult.output}`);
  }

  if (syncResult.code !== 0) {
    console.error(
      `[gateway] ⚠️  WARNING: Token sync failed with code ${syncResult.code}`
    );
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const configToken = config?.gateway?.auth?.token;

    console.log(`[gateway] Token verification:`);
    console.log(
      `[gateway]   Wrapper fingerprint: ${tokenLogSafe(gatewayToken)} (len: ${gatewayToken.length})`
    );
    console.log(
      `[gateway]   Config fingerprint:  ${tokenLogSafe(configToken)} (len: ${configToken?.length || 0})`
    );

    if (configToken !== gatewayToken) {
      console.error(`[gateway] ✗ Token mismatch detected!`);
      throw new Error(
        `Token mismatch: wrapper fingerprint ${tokenLogSafe(gatewayToken)} vs config ${tokenLogSafe(configToken)}`
      );
    }
    console.log(`[gateway] ✓ Token verification PASSED`);
  } catch (err) {
    console.error(`[gateway] ERROR: Token verification failed: ${err}`);
    throw err;
  }

  console.log(`[gateway] ========== TOKEN SYNC COMPLETE ==========`);

  await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "config",
      "set",
      "--json",
      "gateway.controlUi.allowInsecureAuth",
      "true",
    ])
  );
  await runCmd(
    OPENCLAW_NODE,
    clawArgs([
      "config",
      "set",
      "--json",
      "gateway.controlUi.dangerouslyDisableDeviceAuth",
      "true",
    ])
  );
  const verify = JSON.parse(fs.readFileSync(configPath(), "utf8"));
  const devAuth = verify?.gateway?.controlUi?.dangerouslyDisableDeviceAuth;
  console.log(
    `[gateway] Set gateway.controlUi.allowInsecureAuth and dangerouslyDisableDeviceAuth=true (headless); verified: ${devAuth}`
  );
  if (devAuth !== true) {
    console.warn(
      `[gateway] WARNING: dangerouslyDisableDeviceAuth is ${devAuth} — cron/agent may get 1008 pairing required`
    );
  }

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    gatewayToken,
  ];

  let stderrTail = Buffer.alloc(0);
  const stderrMaxBytes = 4096;

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: ["inherit", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  gatewayProc.stdout?.pipe(process.stdout);
  gatewayProc.stderr?.pipe(process.stderr);
  gatewayProc.stderr?.on("data", (chunk) => {
    stderrTail = Buffer.concat([
      stderrTail,
      Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
    ]);
    if (stderrTail.length > stderrMaxBytes) {
      stderrTail = stderrTail.subarray(-stderrMaxBytes);
    }
  });

  const gatewayCmdForLog = clawArgs(args)
    .join(" ")
    .replace(gatewayToken, "<redacted>");
  console.log(`[gateway] starting with command: ${OPENCLAW_NODE} ${gatewayCmdForLog}`);
  console.log(`[gateway] STATE_DIR: ${STATE_DIR}`);
  console.log(`[gateway] WORKSPACE_DIR: ${WORKSPACE_DIR}`);
  console.log(`[gateway] config path: ${configPath()}`);

  gatewayProc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    if (code !== 0 && code != null && stderrTail.length > 0) {
      const tail = stderrTail.toString("utf8").trim();
      if (tail) {
        console.error(`[gateway] stderr before exit:\n${tail}`);
      }
    }
    gatewayProc = null;
  });
}

/**
 * Ensure gateway is running; start if not. Resolves when ready.
 * @param {string} gatewayToken
 * @returns {Promise<{ ok: boolean }>}
 */
export async function ensureGatewayRunning(gatewayToken) {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await startGateway(gatewayToken);
      const ready = await waitForGatewayReady({
        timeoutMs: GATEWAY_READY_TIMEOUT_MS,
      });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

/**
 * Restart the gateway (kill wrapper-managed + pkill, then ensure running).
 * @param {string} gatewayToken
 */
export async function restartGateway(gatewayToken) {
  console.log("[gateway] Restarting gateway...");

  if (gatewayProc) {
    console.log("[gateway] Killing wrapper-managed gateway process");
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    gatewayProc = null;
  }

  console.log(
    `[gateway] Killing any other gateway processes on port ${INTERNAL_GATEWAY_PORT}`
  );
  try {
    const killResult = await runCmd("pkill", ["-f", "openclaw-gateway"]);
    console.log(`[gateway] pkill result: exit code ${killResult.code}`);
  } catch (err) {
    console.log(`[gateway] pkill failed: ${err.message}`);
  }

  await sleep(1500);

  return ensureGatewayRunning(gatewayToken);
}

/** For SIGTERM cleanup. */
export function getGatewayProcess() {
  return gatewayProc;
}
