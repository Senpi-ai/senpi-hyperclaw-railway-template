/**
 * Auth helpers: token resolution, safe comparison, logging.
 * No Express middleware here; middleware stays in server/routes and uses these helpers.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.js";

/** Returns a short fingerprint for logging; never logs the actual token. */
export function tokenLogSafe(token) {
  if (!token || typeof token !== "string") return "(none)";
  return crypto
    .createHash("sha256")
    .update(token, "utf8")
    .digest("hex")
    .slice(0, 8);
}

/** Minimum recommended length for gateway token (aligns with openclaw security audit token_too_short). */
const MIN_GATEWAY_TOKEN_LENGTH = 32;

/** Constant-time string comparison to mitigate timing attacks on password auth. */
export function secureCompare(a, b) {
  const aa = Buffer.from(String(a ?? ""), "utf8");
  const bb = Buffer.from(String(b ?? ""), "utf8");
  const maxLen = Math.max(aa.length, bb.length);
  if (maxLen === 0) return aa.length === bb.length;
  const paddedA = Buffer.alloc(maxLen);
  const paddedB = Buffer.alloc(maxLen);
  aa.copy(paddedA);
  bb.copy(paddedB);
  return aa.length === bb.length && crypto.timingSafeEqual(paddedA, paddedB);
}

/**
 * Resolve gateway token: env OPENCLAW_GATEWAY_TOKEN, else persisted file, else generate and persist.
 * @param {string} [stateDir] - defaults to STATE_DIR from config
 * @returns {string}
 */
export function resolveGatewayToken(stateDir = STATE_DIR) {
  console.log(`[token] ========== SERVER STARTUP TOKEN RESOLUTION ==========`);
  const envTok = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  console.log(
    `[token] ENV OPENCLAW_GATEWAY_TOKEN exists: ${!!process.env.OPENCLAW_GATEWAY_TOKEN}`
  );
  console.log(
    `[token] ENV value length: ${process.env.OPENCLAW_GATEWAY_TOKEN?.length || 0}`
  );
  console.log(`[token] After trim length: ${envTok?.length || 0}`);

  if (envTok) {
    console.log(
      `[token] ✓ Using token from OPENCLAW_GATEWAY_TOKEN env variable`
    );
    console.log(
      `[token]   Fingerprint: ${tokenLogSafe(envTok)} (len: ${envTok.length})`
    );
    if (envTok.length < MIN_GATEWAY_TOKEN_LENGTH) {
      console.warn(
        `[token] ⚠️  Token length ${envTok.length} < ${MIN_GATEWAY_TOKEN_LENGTH}; use a longer token (e.g. openssl rand -hex 32) for production.`
      );
    }
    return envTok;
  }

  console.log(`[token] Env variable not available, checking persisted file...`);
  const tokenPath = path.join(stateDir, "gateway.token");
  console.log(`[token] Token file path: ${tokenPath}`);

  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) {
      console.log(`[token] ✓ Using token from persisted file`);
      console.log(
        `[token]   Fingerprint: ${tokenLogSafe(existing)} (len: ${existing.length})`
      );
      if (existing.length < MIN_GATEWAY_TOKEN_LENGTH) {
        console.warn(
          `[token] ⚠️  Token length ${existing.length} < ${MIN_GATEWAY_TOKEN_LENGTH}; consider regenerating (e.g. set OPENCLAW_GATEWAY_TOKEN to openssl rand -hex 32).`
        );
      }
      return existing;
    }
  } catch (err) {
    console.log(`[token] Could not read persisted file: ${err.message}`);
  }

  const generated = crypto.randomBytes(32).toString("hex");
  console.log(
    `[token] ⚠️  Generating new random token (fingerprint: ${tokenLogSafe(generated)})`
  );
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
    console.log(`[token] Persisted new token to ${tokenPath}`);
  } catch (err) {
    console.warn(`[token] Could not persist token: ${err}`);
  }
  return generated;
}

/**
 * Express middleware: require Basic auth with the given password for /setup.
 * @param {string} [setupPassword]
 * @returns {import("express").RequestHandler}
 */
export function createRequireSetupAuth(setupPassword) {
  return (req, res, next) => {
    if (!setupPassword) {
      return res
        .status(500)
        .type("text/plain")
        .send(
          "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup."
        );
    }
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme !== "Basic" || !encoded) {
      res.set("WWW-Authenticate", 'Basic realm="Openclaw Setup"');
      return res.status(401).send("Auth required");
    }
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const password = idx >= 0 ? decoded.slice(idx + 1) : "";
    if (!secureCompare(password, setupPassword)) {
      res.set("WWW-Authenticate", 'Basic realm="Openclaw Setup"');
      return res.status(401).send("Invalid password");
    }
    return next();
  };
}

/**
 * Verify an Authorization header matches either Basic <setupPassword> or
 * Bearer <gatewayToken>. Both are accepted because the wrapper itself hands
 * the gateway token to the browser (see AUTO_TOKEN_SCRIPT in routes/proxy.js)
 * — Control UI fetches and the service worker then send it back as Bearer,
 * and the wrapper has to recognize its own token.
 *
 * @param {string} header - raw Authorization header value (may be "")
 * @param {string} setupPassword
 * @param {string} gatewayToken
 * @returns {boolean}
 */
function verifyProxyAuthHeader(header, setupPassword, gatewayToken) {
  const [scheme, encoded] = (header || "").split(" ");
  if (!scheme || !encoded) return false;
  if (scheme === "Basic") {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const password = idx >= 0 ? decoded.slice(idx + 1) : "";
    return secureCompare(password, setupPassword);
  }
  if (scheme === "Bearer") {
    if (!gatewayToken) return false;
    return secureCompare(encoded, gatewayToken);
  }
  return false;
}

/**
 * Check proxy/Control UI auth: accept Basic <SETUP_PASSWORD> or
 * Bearer <OPENCLAW_GATEWAY_TOKEN>. Sends 401/500 and returns false if not authenticated.
 * @param {string} [setupPassword]
 * @param {string} [gatewayToken]
 * @returns {(req: import("express").Request, res: import("express").Response) => boolean}
 */
export function createCheckProxyAuth(setupPassword, gatewayToken = "") {
  return (req, res) => {
    if (!setupPassword) {
      res
        .status(500)
        .type("text/plain")
        .send(
          "SETUP_PASSWORD is not set. Set it in Railway Variables to access the gateway."
        );
      return false;
    }
    if (verifyProxyAuthHeader(req.headers.authorization, setupPassword, gatewayToken)) {
      return true;
    }
    res.set("WWW-Authenticate", 'Basic realm="Openclaw"');
    res.status(401).send("Auth required");
    return false;
  };
}

/**
 * Same auth predicate as createCheckProxyAuth but for raw socket flows (WS upgrade)
 * where we can't send a 401 response — caller is expected to destroy() the socket
 * on false.
 * @param {string|undefined} header
 * @param {string} setupPassword
 * @param {string} gatewayToken
 * @returns {boolean}
 */
export function verifySocketAuth(header, setupPassword, gatewayToken) {
  if (!setupPassword) return false;
  return verifyProxyAuthHeader(header, setupPassword, gatewayToken);
}
