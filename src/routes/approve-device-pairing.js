/**
 * POST /setup/api/approve-device-pairing
 *
 * Synchronously approves a pending openclaw device-pairing request
 * identified by `{deviceId, publicKey}`. Designed for the orchestrator's
 * pair flow:
 *
 *   1. orchestrator POSTs /setup/api/issue-bootstrap-token
 *   2. orchestrator opens WS /ws and runs the v3 handshake
 *   3. openclaw rejects with NOT_PAIRED, having queued a pending entry
 *   4. orchestrator POSTs /setup/api/approve-device-pairing  ← THIS ROUTE
 *   5. orchestrator re-opens WS /ws → openclaw issues a deviceToken
 *
 * Why this exists instead of a polling auto-approver: the orchestrator
 * KNOWS exactly which pending it caused and exactly when it caused it.
 * A coordinated approval is a single HTTP round-trip; a polling loop
 * would add 3–60s of latency-for-no-reason and keep wrapper-side state
 * (binding registry, TTL accounting) we don't need.
 *
 * SECURITY MODEL — to call this route a caller must hold:
 *
 *   1. SETUP_PASSWORD — gates Basic Auth on every /setup/api/* route
 *      via the wrapper's `requireSetupAuth`. This is the same secret
 *      that gates `/setup/api/issue-bootstrap-token`, so a caller who
 *      can drive openclaw to queue a pending pair can also approve it.
 *      No new privilege is granted by this route's existence.
 *   2. The exact `deviceId` of the pending request. deviceId is
 *      sha256(rawPublicKey), so an attacker who guesses one cannot
 *      produce a valid Ed25519 signature on the connect.req that
 *      created the pending in the first place.
 *   3. The exact `publicKey` that derives the deviceId. The pending
 *      lookup compares BOTH fields — a stolen-deviceId-with-fresh-keypair
 *      attack fails the match.
 *
 * No-pending case is an intentional success path: the orchestrator's
 * retry path may end up here after openclaw silently resolved the
 * pending some other way (e.g., a wrapper internal auto-approve already
 * fired, or a previous approve call won the race). Returning 200 with
 * status="no-pending" lets the orchestrator try its reconnect path
 * uniformly without special-casing the "approved by someone else"
 * outcome.
 */

import express from "express";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_OPENCLAW_ENTRY = "/openclaw/dist/entry.js";

// Tight charset so a bad client gets a 400 before we ever touch the
// openclaw bundle. deviceId is base16 (sha256), publicKey is base64url —
// both fit `[A-Za-z0-9_-]` and never include `/` or `+` in practice.
const IDENTITY_FIELD = /^[A-Za-z0-9_-]{1,256}$/;

function defaultLoadPluginSDK() {
  const entry = process.env.OPENCLAW_ENTRY || DEFAULT_OPENCLAW_ENTRY;
  const path = `${dirname(entry)}/plugin-sdk/device-bootstrap.js`;
  return import(pathToFileURL(path).href);
}

/**
 * Builds the approve-device-pairing route. `deps.loadPluginSDK` is
 * overridable in tests.
 *
 * @param {{ loadPluginSDK?: () => Promise<{ listDevicePairing: Function, approveDevicePairing: Function }> }} [deps]
 * @returns {import('express').Router}
 */
export function createApproveDevicePairingRoute(deps = {}) {
  const loadPluginSDK = deps.loadPluginSDK || defaultLoadPluginSDK;
  const router = express.Router();

  router.post("/approve-device-pairing", async (req, res) => {
    const body = req.body || {};
    const { deviceId, publicKey } = body;
    if (!IDENTITY_FIELD.test(String(deviceId || ""))) {
      return res.status(400).json({
        error: "invalid_request",
        detail: "deviceId must match ^[A-Za-z0-9_-]{1,256}$",
      });
    }
    if (!IDENTITY_FIELD.test(String(publicKey || ""))) {
      return res.status(400).json({
        error: "invalid_request",
        detail: "publicKey must match ^[A-Za-z0-9_-]{1,256}$",
      });
    }

    let mod;
    try {
      mod = await loadPluginSDK();
    } catch (err) {
      console.error("[approve-device-pairing] plugin-SDK load failed:", err);
      return res
        .status(503)
        .json({ error: "plugin_sdk_not_loadable", detail: String(err) });
    }

    let pending;
    try {
      const list = await mod.listDevicePairing();
      pending = (list?.pending || []).find(
        (p) => p.deviceId === deviceId && p.publicKey === publicKey
      );
    } catch (err) {
      console.error("[approve-device-pairing] listDevicePairing threw:", err);
      return res.status(500).json({
        error: "list_pending_failed",
        detail: String(err),
      });
    }

    if (!pending) {
      // Already-paired, expired, or never-queued. Idempotent success —
      // the orchestrator's reconnect path will surface the real state.
      console.log(
        `[approve-device-pairing] no pending match deviceId=${deviceId}`
      );
      return res.json({ status: "no-pending" });
    }

    try {
      // callerScopes: ['operator.admin'] is the standard wrapper-side
      // approval scope, sufficient to grant the BOOTSTRAP_HANDOFF_OPERATOR
      // scope cohort openclaw bound to the pending. See
      // src/lib/devicePairingNode.js's docstring for why this avoids
      // openclaw v2026.5.x's scope-escalation refusal.
      const result = await mod.approveDevicePairing(pending.requestId, {
        callerScopes: ["operator.admin"],
      });
      if (!result) {
        // null = request resolved between list + approve (raced).
        console.log(
          `[approve-device-pairing] race: pending resolved between list+approve deviceId=${deviceId} requestId=${pending.requestId}`
        );
        return res.json({ status: "no-pending" });
      }
      if (result.status === "approved") {
        // `approveDevicePairing` already minted the deviceToken and
        // persisted it into paired.json — surface it back to the
        // caller so the orchestrator skips the otherwise-redundant
        // reconnect-just-to-read-hello-ok step. openclaw v2026.5.x
        // keys per-role tokens; our pair flow only ever asks for
        // `operator`, so that's the one we expose. If the field is
        // missing (unexpected — would mean openclaw silently changed
        // its result shape), the orchestrator falls back to its
        // RunHandshake path.
        const deviceToken = result.device?.tokens?.operator?.token;
        if (!deviceToken) {
          console.warn(
            `[approve-device-pairing] approved without operator deviceToken in result deviceId=${deviceId} requestId=${pending.requestId}`
          );
        }
        console.log(
          `[approve-device-pairing] approved deviceId=${deviceId} requestId=${pending.requestId}`
        );
        return res.json({
          status: "approved",
          deviceId: result.device?.deviceId,
          requestId: pending.requestId,
          deviceToken,
        });
      }
      // status === "forbidden" with `reason`+optional `scope`. Surface as 422
      // so the orchestrator can log and not silently retry forever.
      console.warn(
        `[approve-device-pairing] forbidden deviceId=${deviceId} reason=${result.reason} scope=${result.scope || ""}`
      );
      return res.status(422).json({
        error: "approve_forbidden",
        reason: result.reason,
        scope: result.scope,
      });
    } catch (err) {
      console.error(
        `[approve-device-pairing] approveDevicePairing threw deviceId=${deviceId}:`,
        err
      );
      return res
        .status(500)
        .json({ error: "approve_failed", detail: String(err) });
    }
  });

  return router;
}
