# Refactoring plan: from monolith to maintainable modules

The main server logic used to live in a single large file (`server.js`), which was hard to understand, modify, and test. This document describes the current state and the intended direction.

## Current state (after Phase 1)

### New modules

- **`src/lib/config.js`** – Environment and paths
  - Constants: `PORT`, `STATE_DIR`, `WORKSPACE_DIR`, `GATEWAY_TARGET`, `INTERNAL_GATEWAY_PORT`, `GATEWAY_READY_TIMEOUT_MS`, `OPENCLAW_ENTRY`, `OPENCLAW_NODE`
  - Env-derived: `SETUP_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_USERNAME`, `AI_PROVIDER`, `AI_API_KEY`, `PROVIDER_TO_AUTH_CHOICE`
  - Helpers: `stripBearer()`, `validateEnvVars()`, `configPath()`, `isConfigured()`
  - **Testable:** Pure functions and values; no gateway or HTTP.

- **`src/lib/auth.js`** – Auth and token helpers
  - `tokenLogSafe(token)` – Safe fingerprint for logs
  - `secureCompare(a, b)` – Timing-safe string comparison
  - `resolveGatewayToken(stateDir?)` – Resolve or generate gateway token (reads env + file, may write file)
  - **Testable:** `tokenLogSafe` and `secureCompare` are pure; `resolveGatewayToken` can be tested with a temp dir.

- **`src/lib/runCmd.js`** – Run a command with env
  - `runCmd(cmd, args, opts?)` – Spawns process, returns `{ code, output }`; injects `OPENCLAW_STATE_DIR` and `OPENCLAW_WORKSPACE_DIR` from config.
  - **Testable:** Can mock `child_process.spawn` or run real commands in tests.

### Still in `server.js`

- Gateway lifecycle: `startGateway`, `ensureGatewayRunning`, `restartGateway`, `waitForGatewayReady`, `clawArgs`, `sleep`
- Onboarding: `autoOnboard`, `canAutoOnboard`, `resolveTelegramAndWriteUserMd`, `buildOnboardArgs`, `envFingerprintForOnboard`, `shouldReOnboardDueToEnvChange`
- Middleware: `requireSetupAuth`, `checkProxyAuth`
- All routes: `/setup/*`, `/setup/api/*`, proxy and Control UI interception, WebSocket upgrade
- Express app creation, `server.listen`, SIGTERM handler

So `server.js` is still the composition root and holds most of the “core logic,” but config, auth, and runCmd are extracted and reusable.

## Completed phases (Phase 2)

1. **gateway.js** – `startGateway(gatewayToken)`, `ensureGatewayRunning(gatewayToken)`, `restartGateway(gatewayToken)`, `waitForGatewayReady()`, `clawArgs()`, `getGatewayProcess()`.

2. **onboard.js** – `autoOnboard(gatewayToken)`, `canAutoOnboard()`, `resolveTelegramAndWriteUserMd()`, `buildOnboardArgs(payload, gatewayToken)`, `envFingerprintForOnboard()`, `shouldReOnboardDueToEnvChange()`, `isOnboardingInProgress()`, `AUTO_ONBOARD_FINGERPRINT_FILE`.

3. **routes/setup.js** – `createSetupRouter()` returns Express router for `/setup`, `/setup/healthz`, `/setup/api/*`.

4. **routes/proxy.js** – `controlUiMiddleware`, `controlUiHandler`, `catchAllMiddleware`, `attachUpgrade(server)`.

5. **server.js** – Thin entry: mounts setup router, Control UI, catch-all; `attachUpgrade(server)`; on listen runs re-onboard / auto-onboard / bootstrap; SIGTERM kills gateway.

## Testing

- **Unit tests** (e.g. with Node’s `node:test` or Jest):
  - `lib/config.js`: `configPath()`, `isConfigured()` with a temp dir; `stripBearer()`; `validateEnvVars()` with mocked `process.env`.
  - `lib/auth.js`: `tokenLogSafe()`, `secureCompare()`; `resolveGatewayToken()` with temp dir and env mocks.
  - `lib/runCmd.js`: `runCmd()` with mocked `child_process.spawn`.
- **Integration tests**: Start the app (or a test app that only mounts a subset of routes), hit `/setup/healthz`, proxy to a stub gateway, etc.