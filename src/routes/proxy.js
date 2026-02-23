/**
 * Gateway proxy: HTTP proxy, Control UI HTML interception, catch-all, WebSocket upgrade.
 */

import httpProxy from "http-proxy";
import {
  GATEWAY_TARGET,
  isConfigured,
  SETUP_PASSWORD,
  DEBUG,
} from "../lib/config.js";
import { tokenLogSafe, secureCompare, createCheckProxyAuth } from "../lib/auth.js";
import { ensureGatewayRunning } from "../gateway.js";
import { isOnboardingInProgress } from "../onboard.js";

const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const checkProxyAuth = createCheckProxyAuth(SETUP_PASSWORD);

function debug(...args) {
  if (DEBUG) console.log(...args);
}

const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, _res) => {
  console.error("[proxy]", err);
});

proxy.on("proxyReq", (proxyReq, req, res) => {
  console.log(
    `[proxy] HTTP ${req.method} ${req.url} - injecting token (fingerprint: ${tokenLogSafe(gatewayToken)})`
  );
  proxyReq.setHeader("Authorization", `Bearer ${gatewayToken}`);
});

proxy.on("proxyReqWs", (proxyReq, req, socket, options, head) => {
  proxyReq.setHeader("Authorization", `Bearer ${gatewayToken}`);
  debug(
    `[proxy-ws] WebSocket ${req.url} - injected token (fingerprint: ${tokenLogSafe(gatewayToken)})`
  );
});

const AUTO_TOKEN_SCRIPT = `
<script data-auto-token>
(function(){
  fetch("/setup/api/gateway-token", { credentials: "same-origin" })
    .then(function(r){ return r.ok ? r.json() : Promise.reject(new Error("auth required")); })
    .then(function(data){ var TOKEN = data.token; if (!TOKEN) return;

  function applyToken() {
    try {
      var keys = ["gateway-token", "gatewayToken", "openclaw-token", "token", "oc:gateway-token", "oc:token", "openclaw-gateway-token"];
      for (var i = 0; i < keys.length; i++) localStorage.setItem(keys[i], TOKEN);
    } catch(e) {}
    try {
      document.cookie = "token=" + TOKEN + "; path=/; SameSite=Lax";
      document.cookie = "gateway-token=" + TOKEN + "; path=/; SameSite=Lax";
    } catch(e) {}
  }
  applyToken();

  var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  function fill() {
    var inputs = document.querySelectorAll("input");
    var filled = false;
    for (var j = 0; j < inputs.length; j++) {
      var el = inputs[j];
      var ctx = "";
      var parent = el.closest("label, [class*=field], [class*=form-group]");
      if (parent) ctx += " " + parent.textContent.toLowerCase();
      var prev = el.previousElementSibling;
      if (prev) ctx += " " + prev.textContent.toLowerCase();
      ctx += " " + (el.placeholder || "").toLowerCase() + " " + (el.getAttribute("aria-label") || "").toLowerCase();
      var val = (el.value || "").trim();
      var isTokenField = (ctx.includes("gateway token") || ctx.includes("token")) && !ctx.includes("session") && !ctx.includes("url") && !ctx.includes("password") && !ctx.includes("websocket");
      if (val === "OPENCLAW_GATEWAY_TOKEN") isTokenField = true;
      if (isTokenField) {
        if (val !== TOKEN) {
          nativeSetter.call(el, TOKEN);
          el.dispatchEvent(new Event("input", {bubbles:true}));
          el.dispatchEvent(new Event("change", {bubbles:true}));
          filled = true;
        }
        try { el.setAttribute("type", "password"); } catch(e) {}
      }
    }
    if (filled) {
      var btns = document.querySelectorAll("button");
      for (var k = 0; k < btns.length; k++) {
        if (btns[k].textContent.trim().toLowerCase() === "connect") {
          setTimeout(function(){ btns[k].click(); }, 500);
          break;
        }
      }
    }
    return filled;
  }
  function tryFill() {
    if (!fill()) {
      var obs = new MutationObserver(function(){ if (fill()) obs.disconnect(); });
      obs.observe(document.documentElement, {childList:true, subtree:true});
      setTimeout(function(){ obs.disconnect(); }, 20000);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryFill);
  } else {
    tryFill();
  }
  var applyCount = 0;
  var interval = setInterval(function(){
    applyToken();
    fill();
    if (++applyCount >= 24) clearInterval(interval);
  }, 500);
  }).catch(function(){});
})();
</script>`;

/**
 * Control UI interception: GET /, /openclaw, /openclaw/ — fetch HTML from gateway, inject token script, send.
 */
export function controlUiMiddleware(req, res, next) {
  if (!checkProxyAuth(req, res)) return;
  next();
}

export async function controlUiHandler(req, res, next) {
  if (!isConfigured()) return next();

  try {
    await ensureGatewayRunning(gatewayToken);
  } catch {
    return next();
  }

  try {
    const upstream = await fetch(`${GATEWAY_TARGET}${req.originalUrl}`, {
      headers: { Authorization: `Bearer ${gatewayToken}` },
      redirect: "follow",
    });

    if (!upstream.ok) return next();

    const contentType = upstream.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return next();

    let html = await upstream.text();

    if (html.includes("</head>")) {
      html = html.replace("</head>", AUTO_TOKEN_SCRIPT + "\n</head>");
    } else if (html.includes("</body>")) {
      html = html.replace("</body>", AUTO_TOKEN_SCRIPT + "\n</body>");
    } else {
      html += AUTO_TOKEN_SCRIPT;
    }

    res.type("text/html").send(html);
  } catch (err) {
    console.error(`[control-ui] Token injection failed: ${err.message}`);
    return next();
  }
}

/**
 * Catch-all: require auth, then proxy to gateway (or show onboarding / redirect to /setup).
 */
export async function catchAllMiddleware(req, res) {
  if (!checkProxyAuth(req, res)) return;

  if (!isConfigured() && !req.path.startsWith("/setup")) {
    if (isOnboardingInProgress()) {
      return res
        .status(503)
        .type("text/html")
        .send(
          '<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>Setting up...</title></head>' +
            '<body style="background:#050810;color:#fff;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">' +
            '<div style="text-align:center"><h2>Setting up your bot...</h2>' +
            "<p>Auto-configuration is in progress. This page will refresh automatically.</p>" +
            "</div></body></html>"
        );
    }
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    try {
      await ensureGatewayRunning(gatewayToken);
    } catch (err) {
      return res
        .status(503)
        .type("text/plain")
        .send(`Gateway not ready: ${String(err)}`);
    }
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
}

/**
 * Attach WebSocket upgrade handler to the HTTP server.
 * @param {import("http").Server} server
 */
export function attachUpgrade(server) {
  server.on("upgrade", async (req, socket, head) => {
    if (!isConfigured()) {
      socket.destroy();
      return;
    }
    if (!SETUP_PASSWORD) {
      socket.destroy();
      return;
    }
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme !== "Basic" || !encoded) {
      socket.destroy();
      return;
    }
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const password = idx >= 0 ? decoded.slice(idx + 1) : "";
    if (!secureCompare(password, SETUP_PASSWORD)) {
      socket.destroy();
      return;
    }
    try {
      await ensureGatewayRunning(gatewayToken);
    } catch {
      socket.destroy();
      return;
    }

    if (!gatewayToken) {
      console.error(
        "[ws-upgrade] Cannot proxy WebSocket: OPENCLAW_GATEWAY_TOKEN is empty"
      );
      socket.destroy();
      return;
    }

    req.headers.authorization = `Bearer ${gatewayToken}`;
    console.log(`[ws-upgrade] Proxying WebSocket to gateway (url=${req.url})`);
    proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
  });
}

export { proxy };
