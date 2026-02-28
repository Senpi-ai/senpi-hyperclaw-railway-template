/**
 * Entry point: composes config, auth, gateway, onboarding, setup routes, and proxy.
 */

import fs from "node:fs";

import express from "express";
import {
  PORT,
  configPath,
  isConfigured,
  SETUP_PASSWORD,
} from "./lib/config.js";
import { resolveGatewayToken } from "./lib/auth.js";
import { getGatewayProcess, restartGateway } from "./gateway.js";
import { stopAutoApprovalLoop } from "./lib/deviceAuth.js";
import {
  autoOnboard,
  canAutoOnboard,
  shouldReOnboardDueToEnvChange,
  isOnboardingInProgress,
  AUTO_ONBOARD_FINGERPRINT_FILE,
} from "./onboard.js";
import { bootstrapOpenClaw } from "./bootstrap.mjs";
import { createSetupRouter } from "./routes/setup.js";
import {
  controlUiMiddleware,
  controlUiHandler,
  catchAllMiddleware,
  attachUpgrade,
} from "./routes/proxy.js";

if (!SETUP_PASSWORD) {
  console.error("================================================================");
  console.error("WARNING: SETUP_PASSWORD is not configured.");
  console.error("  /setup and gateway routes (/, /openclaw) will be disabled.");
  console.error("  Set SETUP_PASSWORD in Railway Variables to enable the setup");
  console.error("  wizard and Control UI access.");
  console.error("================================================================");
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// Setup wizard and API
app.use("/setup", createSetupRouter());

// Control UI (/, /openclaw) — intercept HTML and inject token script
app.get(
  ["/", "/openclaw", "/openclaw/"],
  controlUiMiddleware,
  controlUiHandler
);

// Everything else → proxy to gateway (with auth and onboarding redirect)
app.use(catchAllMiddleware);

const server = app.listen(PORT, () => {
  console.log(`[wrapper] listening on port ${PORT}`);
  console.log(`[wrapper] setup wizard: http://localhost:${PORT}/setup`);
  console.log(`[wrapper] configured: ${isConfigured()}`);

  if (isConfigured() && shouldReOnboardDueToEnvChange()) {
    console.log(
      "[wrapper] Env vars changed since last auto-onboard — re-onboarding with current Variables..."
    );
    try {
      fs.unlinkSync(configPath());
      try {
        fs.unlinkSync(AUTO_ONBOARD_FINGERPRINT_FILE);
      } catch {
        /* ignore */
      }
    } catch (e) {
      console.error(`[wrapper] Failed to remove old config: ${e.message}`);
    }
    autoOnboard(OPENCLAW_GATEWAY_TOKEN).catch((err) => {
      console.error(`[wrapper] Re-onboard failed: ${err}`);
    });
  } else if (canAutoOnboard()) {
    console.log("[wrapper] Auto-onboarding from environment variables...");
    autoOnboard(OPENCLAW_GATEWAY_TOKEN).catch((err) => {
      console.error(`[wrapper] Auto-onboard failed: ${err}`);
    });
  } else if (isConfigured()) {
    console.log(
      "[wrapper] Already configured, syncing configs and starting gateway..."
    );
    try {
      bootstrapOpenClaw();
    } catch (err) {
      console.error(`[wrapper] Bootstrap sync error (non-fatal): ${err}`);
    }
    // Restart gateway so it picks up bootstrap patch (e.g. dangerouslyDisableDeviceAuth for cron without pairing)
    restartGateway(OPENCLAW_GATEWAY_TOKEN).catch((err) => {
      console.error(`[wrapper] Gateway startup failed: ${err}`);
    });
  }
});

attachUpgrade(server);

process.on("SIGTERM", () => {
  stopAutoApprovalLoop();
  try {
    const proc = getGatewayProcess();
    if (proc) proc.kill("SIGTERM");
  } catch {
    // ignore
  }
  process.exit(0);
});
