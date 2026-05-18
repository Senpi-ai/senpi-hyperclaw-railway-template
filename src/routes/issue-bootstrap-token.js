/**
 * POST /setup/api/issue-bootstrap-token
 *
 * Mints a fresh openclaw device-bootstrap token via the plugin-SDK and
 * returns it. Stateless: each call mints and returns; nothing persisted
 * in the wrapper. Auth is the existing SETUP_PASSWORD Basic Auth applied
 * at the parent router (createSetupRouter wraps with requireSetupAuth).
 */

import express from "express";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_OPENCLAW_ENTRY = "/openclaw/dist/entry.js";

function defaultLoadPluginSDK() {
  const entry = process.env.OPENCLAW_ENTRY || DEFAULT_OPENCLAW_ENTRY;
  const path = `${dirname(entry)}/plugin-sdk/device-bootstrap.js`;
  return import(pathToFileURL(path).href);
}

/**
 * Builds the issue-bootstrap-token route. `deps.loadPluginSDK` is overridable
 * in tests.
 */
export function createIssueBootstrapTokenRoute(deps = {}) {
  const loadPluginSDK = deps.loadPluginSDK || defaultLoadPluginSDK;
  const router = express.Router();

  router.post("/issue-bootstrap-token", async (_req, res) => {
    let mod;
    try {
      mod = await loadPluginSDK();
    } catch (err) {
      console.error("[issue-bootstrap-token] plugin-SDK load failed:", err);
      return res.status(503).json({ error: "plugin-sdk module not loadable", detail: String(err) });
    }
    try {
      const { token, ttlSeconds } = await mod.issueDeviceBootstrapToken();
      return res.json({
        bootstrapToken: token,
        ttlSeconds: ttlSeconds ?? 600,
        issuedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[issue-bootstrap-token] mint failed:", err);
      return res.status(500).json({ error: "issueDeviceBootstrapToken threw", detail: String(err) });
    }
  });

  return router;
}
