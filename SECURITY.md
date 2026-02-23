# Security audit (OpenClaw Railway Template)

This document summarizes how this template aligns with [OpenClaw’s security guidance](https://docs.openclaw.ai/gateway/security) and notes findings and recommendations.

## Trust model

- The **wrapper** (this app) is the reverse proxy in front of the OpenClaw gateway. It enforces **Basic auth** with `SETUP_PASSWORD` on `/setup`, Control UI (`/`, `/openclaw`), and all proxy/WebSocket traffic. Only after auth does it inject the gateway bearer token and proxy to the gateway.
- The **gateway** runs with `gateway.bind: "loopback"` and `gateway.auth.mode: "token"`. It is not exposed directly; all access goes through the wrapper.
- OpenClaw assumes the host and config boundary are trusted. This template runs a single gateway per deployment; multi-tenant or mutually untrusted operators should use separate gateways (see [Security – Deployment assumption](https://docs.openclaw.ai/gateway/security)).

---

## What we do well (aligned with OpenClaw security)

| Area | Implementation | Reference |
|------|----------------|-----------|
| **Gateway bind** | `gateway.bind: "loopback"` — gateway only listens on localhost | [Network exposure](https://docs.openclaw.ai/gateway/security#04-network-exposure-bind--port--firewall) |
| **Gateway auth** | Token auth required; token synced from wrapper to `openclaw.json`; no `auth.mode: "none"` | [Lock down Gateway WebSocket](https://docs.openclaw.ai/gateway/security#05-lock-down-the-gateway-websocket-local-auth) |
| **Reverse proxy** | `gateway.trustedProxies: ["127.0.0.1", "::1"]` so the wrapper is trusted; we do **not** set `allowRealIpFallback` | [Reverse Proxy Configuration](https://docs.openclaw.ai/gateway/security#reverse-proxy-configuration) |
| **Wrapper auth** | All proxy and Control UI routes require Basic auth with `SETUP_PASSWORD`; 401/500 when unset | [Security architecture](https://docs.openclaw.ai/gateway/security) |
| **Token injection** | Gateway token injected by wrapper only after request is authenticated; clients never need to know it (Control UI gets it via server-side fetch + script injection) | Same |
| **Token logging** | Only fingerprint (hash prefix) and length are logged; actual token is redacted in command logs | [Logs + redaction](https://docs.openclaw.ai/gateway/security#08-logs--transcripts-redaction--retention) |
| **Token strength** | Auto-generated token is 32 bytes (64 hex chars); short tokens from env/file are warned (see below) | [hooks.token_too_short](https://docs.openclaw.ai/gateway/security#security-audit-glossary) |
| **Debug endpoint** | `GET /setup/api/debug` returns 404 unless `OPENCLAW_TEMPLATE_DEBUG=true` **and** requires setup auth; response does not include the gateway token | [Insecure/dangerous flags](https://docs.openclaw.ai/gateway/security#insecure-or-dangerous-flags-summary) |
| **Backup export** | `/setup/export` excludes sensitive paths: `gateway.token`, `openclaw.json`, `mcporter.json` | [Secrets on disk](https://docs.openclaw.ai/gateway/security#07-secrets-on-disk-whats-sensitive) |
| **Senpi token API** | `POST /setup/api/senpi-token` is restricted to localhost (`127.0.0.1`, `::1`) | Reduce blast radius |
| **Control UI token** | `/setup/api/gateway-token` is protected by `requireSetupAuth` and `Cache-Control: no-store` | — |

---

## Known / intentional choices (warn in OpenClaw audit)

| Item | Why we use it | Doc |
|------|----------------|-----|
| **`gateway.controlUi.allowInsecureAuth: true`** | Required so the Control UI works behind our reverse proxy without device pairing. The wrapper already enforces Basic auth and injects the gateway token; device identity is not needed. | [Control UI over HTTP](https://docs.openclaw.ai/gateway/security#control-ui-over-http), [gateway.control_ui.insecure_auth](https://docs.openclaw.ai/gateway/security#security-audit-glossary) |
| **`gateway.controlUi.dangerouslyDisableDeviceAuth: true`** | Headless deployment: there is no device to pair. Internal clients (Telegram provider, cron, session WebSocket) connect from 127.0.0.1 with the gateway token from config; without this they get `code=1008 reason=connect failed` / "pairing required" and cron/notifications fail. | [gateway.control_ui.device_auth_disabled](https://docs.openclaw.ai/gateway/security#security-audit-glossary) |

Running `openclaw security audit` in the container will flag both. Treat them as accepted for this deployment pattern (wrapper auth + token injection; no local CLI/device).

---

## Findings and recommendations

### 1. **Health check unauthenticated** (low)

- **What:** `GET /setup/healthz` returns `{ "ok": true }` with no authentication. It does not expose config or tokens.
- **Risk:** A platform or attacker can confirm the service is up; no access to gateway or setup is granted.
- **Recommendation:** Acceptable for most deployments (Railway/load balancers often need an unauthenticated health URL). If you need to hide liveness, add Basic auth to healthz and configure your platform with the same credentials.

### 2. **Short gateway token** (low)

- **What:** If `OPENCLAW_GATEWAY_TOKEN` or the persisted token is very short (e.g. &lt; 32 characters), brute force is easier.
- **Recommendation:** Use a long random token (e.g. `openssl rand -hex 32`). The wrapper now **warns** at startup when the token length is below a minimum (see `src/lib/auth.js`). Set `OPENCLAW_GATEWAY_TOKEN` in production to a strong value.

### 3. **SETUP_PASSWORD unset**

- **What:** If `SETUP_PASSWORD` is not set, the wrapper logs a prominent warning and disables `/setup` and gateway routes (returns 500). This is fail-closed for those routes.
- **Recommendation:** Always set `SETUP_PASSWORD` in production (and use a strong password or generated secret).

### 4. **File permissions**

- **What:** The template does not set `openclaw.json` or `STATE_DIR` to `600`/`700` after writing. In Docker/Railway the process usually runs as a single user, but permissions could be looser than desired.
- **Recommendation:** For extra hardening, run `openclaw doctor` (or equivalent) in the image or at startup to tighten permissions on `~/.openclaw` and config; or ensure the volume is mounted with restrictive permissions.

### 5. **Tools / exec**

- **What:** `bootstrap.mjs` sets `tools.exec.security: "full"` and `ask: "off"` so MCP and tools don’t wait for manual approval in a headless environment. This broadens the blast radius of prompt injection if an attacker can reach the agent.
- **Recommendation:** Align with [Prompt injection](https://docs.openclaw.ai/gateway/security#prompt-injection-what-it-is-why-it-matters): restrict who can message the bot (pairing/allowlists), use a strong model, and consider denying high-risk tools for untrusted channels. The template does not change tool allow/deny lists; configure those in OpenClaw config or workspace prompts as needed.

---

## Checklist (production)

- [ ] Set **SETUP_PASSWORD** (strong; e.g. from a secret generator).
- [ ] Set **OPENCLAW_GATEWAY_TOKEN** to a long random value (e.g. `openssl rand -hex 32`) so it is stable across redeploys and not weak.
- [ ] Use a **persistent volume** at `/data` and set `OPENCLAW_STATE_DIR` / `OPENCLAW_WORKSPACE_DIR` to paths under `/data`.
- [ ] Do **not** set `OPENCLAW_TEMPLATE_DEBUG=true` in production (keeps `/setup/api/debug` disabled).
- [ ] Run **openclaw security audit** (e.g. in CI or after deploy) and treat `gateway.control_ui.insecure_auth` as accepted for this architecture; fix any other findings.

---

## Reporting security issues

For issues in this template or the wrapper code, open a confidential report per your organization’s policy. For issues in OpenClaw itself, see [Reporting Security Issues](https://docs.openclaw.ai/gateway/security#reporting-security-issues).
