/**
 * Setup wizard and /setup/api/* routes.
 */

import express from "express";
import fs from "node:fs";
import path from "node:path";
import * as tar from "tar";
import {
  STATE_DIR,
  WORKSPACE_DIR,
  OPENCLAW_NODE,
  INTERNAL_GATEWAY_PORT,
  GATEWAY_TARGET,
  DEBUG,
  PORT,
  OPENCLAW_ENTRY,
  configPath,
  isConfigured,
  SETUP_PASSWORD,
} from "../lib/config.js";
import { tokenLogSafe, createRequireSetupAuth } from "../lib/auth.js";
import { runCmd } from "../lib/runCmd.js";
import { clawArgs, ensureGatewayRunning, restartGateway } from "../gateway.js";
import {
  buildOnboardArgs,
  resolveTelegramAndWriteUserMd,
  isOnboardingInProgress,
} from "../onboard.js";
import { bootstrapOpenClaw } from "../bootstrap.mjs";
import { readCachedTelegramId } from "../lib/telegramId.js";
import os from "node:os";
import {
  buildBridgeGatewayUrl,
  resolveAgentId,
} from "../lib/agentBridgeCreds.js";
import { shouldSetDangerousDeviceAuthFlag } from "../lib/dangerousAuthFlag.js";
import { resolveAllowedOrigins } from "../lib/allowedOrigins.js";

const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const requireSetupAuth = createRequireSetupAuth(SETUP_PASSWORD);

const AUTH_GROUPS = [
  {
    value: "openai",
    label: "OpenAI",
    hint: "Codex OAuth + API key",
    options: [
      { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
      { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
      { value: "openai-api-key", label: "OpenAI API key" },
    ],
  },
  {
    value: "anthropic",
    label: "Anthropic",
    hint: "Claude Code CLI + API key",
    options: [
      { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
      { value: "token", label: "Anthropic token (paste setup-token)" },
      { value: "apiKey", label: "Anthropic API key" },
    ],
  },
  {
    value: "google",
    label: "Google",
    hint: "Gemini API key + Vertex AI + OAuth",
    options: [
      { value: "gemini-api-key", label: "Google Gemini API key" },
      { value: "google-antigravity", label: "Google Antigravity OAuth" },
      { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" },
    ],
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    hint: "API key",
    options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }],
  },
  {
    value: "ai-gateway",
    label: "Vercel AI Gateway",
    hint: "API key",
    options: [
      { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
    ],
  },
  {
    value: "moonshot",
    label: "Moonshot AI",
    hint: "Kimi K2 + Kimi Code",
    options: [
      { value: "moonshot-api-key", label: "Moonshot AI API key" },
      { value: "kimi-code-api-key", label: "Kimi Code API key" },
    ],
  },
  {
    value: "zai",
    label: "Z.AI (GLM 4.7)",
    hint: "API key",
    options: [{ value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }],
  },
  {
    value: "minimax",
    label: "MiniMax",
    hint: "M2.1 (recommended)",
    options: [
      { value: "minimax-api", label: "MiniMax M2.1" },
      { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" },
    ],
  },
  {
    value: "qwen",
    label: "Qwen",
    hint: "OAuth",
    options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
  },
  {
    value: "copilot",
    label: "Copilot",
    hint: "GitHub + local proxy",
    options: [
      { value: "github-copilot", label: "GitHub Copilot (GitHub device login)" },
      { value: "copilot-proxy", label: "Copilot Proxy (local)" },
    ],
  },
  {
    value: "venice",
    label: "Venice AI",
    hint: "Private & uncensored models",
    options: [{ value: "venice-api-key", label: "Venice AI API key" }],
  },
  {
    value: "synthetic",
    label: "Synthetic",
    hint: "Anthropic-compatible (multi-model)",
    options: [{ value: "synthetic-api-key", label: "Synthetic API key" }],
  },
  {
    value: "opencode-zen",
    label: "OpenCode Zen",
    hint: "API key",
    options: [
      {
        value: "opencode-zen",
        label: "OpenCode Zen (multi-model proxy)",
      },
    ],
  },
  {
    value: "venice",
    label: "Venice AI",
    hint: "Privacy-focused API key",
    options: [{ value: "venice-api-key", label: "Venice AI API key" }],
  },
];

export function createSetupRouter() {
  const router = express.Router();

  router.get("/healthz", (_req, res) => res.json({ ok: true }));

  router.get("/app.js", requireSetupAuth, (_req, res) => {
    res.type("application/javascript");
    res.sendFile(path.join(process.cwd(), "src", "public", "setup-app.js"));
  });

  router.get("/styles.css", requireSetupAuth, (_req, res) => {
    res.type("text/css");
    res.sendFile(path.join(process.cwd(), "src", "public", "styles.css"));
  });

  router.get("/", requireSetupAuth, (_req, res) => {
    res.sendFile(path.join(process.cwd(), "src", "public", "setup.html"));
  });

  router.get("/api/gateway-token", requireSetupAuth, (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json({ token: gatewayToken });
  });

  // Integration credentials for an external agent-bridge (Senpi-ai/agent-bridge,
  // `v3/go-rewrite`). Operator-only: Basic auth via SETUP_PASSWORD. Returns
  // the three env vars the bridge needs to dial the v3 device-pair handshake
  // against this Railway deployment. Audit-logged so credential reads are
  // recoverable from log history.
  router.get("/api/agent-bridge-creds", requireSetupAuth, async (req, res) => {
    console.warn(
      `[agent-bridge-creds] CREDENTIALS READ at ${new Date().toISOString()} ` +
        `(auth passed, ua=${(req.headers["user-agent"] || "").slice(0, 80)})`,
    );

    // Read the token at request time, not at module-load time. The
    // existing module-level `gatewayToken` const captures the env var
    // BEFORE `server.js` calls `resolveGatewayToken()` and reflects it
    // back into `process.env`, so on a deployment that resolved the
    // token from a persisted file (no env var set), the import-time
    // const is "" while `process.env.OPENCLAW_GATEWAY_TOKEN` is correct.
    const currentToken = process.env.OPENCLAW_GATEWAY_TOKEN || gatewayToken;
    try {
      await ensureGatewayRunning(currentToken);
    } catch (err) {
      res.set("Cache-Control", "no-store");
      return res.status(503).json({
        error: "gateway_not_ready",
        detail: String(err?.message || err),
      });
    }

    const forwardedHost =
      typeof req.headers.host === "string" ? req.headers.host : undefined;
    const gatewayUrl = buildBridgeGatewayUrl({
      env: process.env,
      forwardedHost,
    });

    if (!gatewayUrl) {
      res.set("Cache-Control", "no-store");
      return res.status(503).json({
        error: "no_public_host",
        detail:
          "RAILWAY_PUBLIC_DOMAIN is unset and the request did not include a Host header. " +
          "Enable Railway public networking, or set RAILWAY_PUBLIC_DOMAIN explicitly.",
      });
    }

    if (!currentToken) {
      res.set("Cache-Control", "no-store");
      return res.status(503).json({
        error: "gateway_token_unresolved",
        detail:
          "Gateway token is not yet resolved. The wrapper may still be starting; retry shortly.",
      });
    }

    // Surface the Origin OpenClaw will accept on the bridge's south WS
    // dial. The bridge MUST send `Origin: <requiredOrigin>` or the
    // gateway returns CONTROL_UI_ORIGIN_NOT_ALLOWED for webchat-class
    // clients. Derived from the same domain as `gatewayUrl` so they
    // always agree.
    const allowedOrigins = resolveAllowedOrigins(process.env);
    const requiredOrigin = `wss://${process.env.RAILWAY_PUBLIC_DOMAIN?.trim() || forwardedHost}`
      .replace(/^wss:/, "https:");

    res.set("Cache-Control", "no-store");
    res.json({
      gatewayUrl,
      bootstrapToken: currentToken,
      agentId: resolveAgentId({
        env: process.env,
        hostname: os.hostname(),
      }),
      requiredOrigin,
      allowedOrigins,
    });
  });

  router.get("/api/status", requireSetupAuth, async (_req, res) => {
    const version = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
    const channelsHelp = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["channels", "add", "--help"])
    );
    res.json({
      configured: isConfigured(),
      gatewayTarget: GATEWAY_TARGET,
      openclawVersion: version.output.trim(),
      channelsAddHelp: channelsHelp.output,
      authGroups: AUTH_GROUPS,
    });
  });

  router.post("/api/run", requireSetupAuth, async (req, res) => {
    try {
      if (isOnboardingInProgress()) {
        return res.status(409).json({
          ok: false,
          output:
            "Onboarding is already in progress (auto-onboard). Please wait.",
        });
      }

      if (isConfigured()) {
        await ensureGatewayRunning(gatewayToken);
        return res.json({
          ok: true,
          output:
            "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
        });
      }

      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

      const payload = req.body || {};
      const onboardArgs = buildOnboardArgs(payload, gatewayToken);

      console.log(`[onboard] ========== TOKEN DIAGNOSTIC START ==========`);
      console.log(
        `[onboard] Wrapper token fingerprint: ${tokenLogSafe(gatewayToken)} (length: ${gatewayToken.length})`
      );
      const cmdForLog = clawArgs(onboardArgs)
        .join(" ")
        .replace(gatewayToken, "<redacted>");
      console.log(`[onboard] Full onboard command: node ${cmdForLog}`);

      const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

      let extra = "";
      const ok = onboard.code === 0 && isConfigured();

      if (ok) {
        try {
          const configAfterOnboard = JSON.parse(
            fs.readFileSync(configPath(), "utf8")
          );
          const tokenAfterOnboard = configAfterOnboard?.gateway?.auth?.token;
          console.log(
            `[onboard] Token in config AFTER onboard: fingerprint ${tokenLogSafe(tokenAfterOnboard)}`
          );
          if (tokenAfterOnboard !== gatewayToken) {
            console.log(
              `[onboard] ⚠️  PROBLEM: onboard command ignored --gateway-token flag and wrote its own token!`
            );
            extra += `\n[WARNING] onboard wrote different token than expected\n`;
          }
        } catch (err) {
          console.error(`[onboard] Could not check config after onboard: ${err}`);
        }
      }

      if (ok) {
        console.log(
          `[onboard] Now syncing wrapper token to config (fingerprint: ${tokenLogSafe(gatewayToken)})`
        );

        await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "gateway.mode", "local"])
        );
        await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "gateway.auth.mode", "token"])
        );

        const setTokenResult = await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "gateway.auth.token",
            gatewayToken,
          ])
        );

        console.log(
          `[onboard] config set gateway.auth.token result: exit code ${setTokenResult.code}`
        );
        if (setTokenResult.code !== 0) {
          extra += `\n[WARNING] Failed to set gateway token in config: ${setTokenResult.output}\n`;
        }

        try {
          const config = JSON.parse(fs.readFileSync(configPath(), "utf8"));
          const configToken = config?.gateway?.auth?.token;
          if (configToken !== gatewayToken) {
            extra += `\n[ERROR] Token verification failed! Config has different token than wrapper.\n`;
          } else {
            extra += `\n[onboard] ✓ Gateway token synced successfully\n`;
          }
        } catch (err) {
          extra += `\n[ERROR] Could not verify token: ${String(err)}\n`;
        }

        await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "set", "gateway.bind", "loopback"])
        );
        await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "gateway.port",
            String(INTERNAL_GATEWAY_PORT),
          ])
        );
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
        if (shouldSetDangerousDeviceAuthFlag()) {
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
        } else {
          // Lock-step with bootstrap.mjs / gateway.js / onboard.js: strip
          // a stale `true` from any prior deploy so the wizard run honours
          // the flipped env var. No-op on a fresh openclaw.json.
          await runCmd(
            OPENCLAW_NODE,
            clawArgs([
              "config",
              "unset",
              "gateway.controlUi.dangerouslyDisableDeviceAuth",
            ])
          );
          console.log(
            "[setup/run] OPENCLAW_DANGEROUSLY_DISABLE_DEVICE_AUTH=false — skipped dangerouslyDisableDeviceAuth write"
          );
        }
        await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "--json",
            "gateway.trustedProxies",
            JSON.stringify(["127.0.0.1", "::1"]),
          ])
        );

        // Origin allowlist for webchat-class clients (agent-bridge). See
        // src/lib/allowedOrigins.js for the rationale.
        {
          const allowed = resolveAllowedOrigins();
          if (allowed.length > 0) {
            await runCmd(
              OPENCLAW_NODE,
              clawArgs([
                "config",
                "set",
                "--json",
                "gateway.controlUi.allowedOrigins",
                JSON.stringify(allowed),
              ])
            );
          }
        }

        const channelsHelp = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["channels", "add", "--help"])
        );
        const helpText = channelsHelp.output || "";
        const supports = (name) => helpText.includes(name);

        if (payload.telegramToken?.trim()) {
          if (!supports("telegram")) {
            extra +=
              "\n[telegram] skipped (this openclaw build does not list telegram in `channels add --help`)\n";
          } else {
            const token = payload.telegramToken.trim();
            const resolvedId = readCachedTelegramId();
            let existingAllowFrom = [];
            try {
              const existingCfg = JSON.parse(fs.readFileSync(configPath(), "utf8")).channels?.telegram;
              existingAllowFrom = Array.isArray(existingCfg?.allowFrom) ? existingCfg.allowFrom : [];
            } catch {}
            const rawMerged = resolvedId
              ? [...new Set([...existingAllowFrom, resolvedId])]
              : [...existingAllowFrom];
            const mergedAllowFrom = rawMerged.some((id) => id !== "*") ? rawMerged.filter((id) => id !== "*") : rawMerged;
            const cfgObj = {
              enabled: true,
              dmPolicy: mergedAllowFrom.length > 0 ? "allowlist" : "pairing",
              ...(mergedAllowFrom.length > 0 ? { allowFrom: mergedAllowFrom } : {}),
              botToken: token,
              groupPolicy: "allowlist",
              streaming: { mode: "block", block: { enabled: true } },
            };
            const set = await runCmd(
              OPENCLAW_NODE,
              clawArgs([
                "config",
                "set",
                "--json",
                "channels.telegram",
                JSON.stringify(cfgObj),
              ])
            );
            await runCmd(
              OPENCLAW_NODE,
              clawArgs([
                "config",
                "set",
                "--json",
                "plugins.entries.telegram",
                JSON.stringify({ enabled: true }),
              ])
            );
            const doctor = await runCmd(
              OPENCLAW_NODE,
              clawArgs(["doctor", "--fix"])
            );
            extra += `\n[telegram config] exit=${set.code}\n`;
            extra += `\n[telegram doctor] exit=${doctor.code}\n`;
          }
        }

        if (payload.discordToken?.trim()) {
          if (!supports("discord")) {
            extra +=
              "\n[discord] skipped (this openclaw build does not list discord in `channels add --help`)\n";
          } else {
            const token = payload.discordToken.trim();
            const cfgObj = {
              enabled: true,
              token,
              groupPolicy: "allowlist",
              dm: { policy: "pairing" },
            };
            const set = await runCmd(
              OPENCLAW_NODE,
              clawArgs([
                "config",
                "set",
                "--json",
                "channels.discord",
                JSON.stringify(cfgObj),
              ])
            );
            extra += `\n[discord config] exit=${set.code}\n`;
          }
        }

        if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
          if (!supports("slack")) {
            extra +=
              "\n[slack] skipped (this openclaw build does not list slack in `channels add --help`)\n";
          } else {
            const cfgObj = {
              enabled: true,
              botToken: payload.slackBotToken?.trim() || undefined,
              appToken: payload.slackAppToken?.trim() || undefined,
            };
            const set = await runCmd(
              OPENCLAW_NODE,
              clawArgs([
                "config",
                "set",
                "--json",
                "channels.slack",
                JSON.stringify(cfgObj),
              ])
            );
            extra += `\n[slack config] exit=${set.code}\n`;
          }
        }

        await resolveTelegramAndWriteUserMd();
        bootstrapOpenClaw();
        await restartGateway(gatewayToken);
      }

      return res.status(ok ? 200 : 500).json({
        ok,
        output: `${onboard.output}${extra}`,
      });
    } catch (err) {
      console.error("[/setup/api/run] error:", err);
      return res
        .status(500)
        .json({ ok: false, output: `Internal error: ${String(err)}` });
    }
  });

  router.get("/api/debug", requireSetupAuth, async (_req, res) => {
    if (!DEBUG) {
      return res.status(404).json({ error: "Not Found" });
    }
    const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
    const help = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["channels", "add", "--help"])
    );
    res.json({
      wrapper: {
        node: process.version,
        port: PORT,
        stateDir: STATE_DIR,
        workspaceDir: WORKSPACE_DIR,
        configPath: configPath(),
        gatewayTokenFromEnv: Boolean(
          process.env.OPENCLAW_GATEWAY_TOKEN?.trim()
        ),
        gatewayTokenPersisted: fs.existsSync(
          path.join(STATE_DIR, "gateway.token")
        ),
        railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
      },
      openclaw: {
        entry: OPENCLAW_ENTRY,
        node: OPENCLAW_NODE,
        version: v.output.trim(),
        channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
      },
    });
  });

  router.post("/api/pairing/approve", requireSetupAuth, async (req, res) => {
    const { channel, code } = req.body || {};
    if (!channel || !code) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing channel or code" });
    }
    const r = await runCmd(
      OPENCLAW_NODE,
      clawArgs(["pairing", "approve", String(channel), String(code)])
    );
    return res
      .status(r.code === 0 ? 200 : 500)
      .json({ ok: r.code === 0, output: r.output });
  });

  router.post("/api/senpi-token", async (req, res) => {
    const remoteIp = req.ip || req.socket?.remoteAddress || "";
    const isLocal =
      remoteIp === "127.0.0.1" ||
      remoteIp === "::1" ||
      remoteIp === "::ffff:127.0.0.1";
    if (!isLocal) {
      return res.status(403).json({ ok: false, error: "Localhost only" });
    }

    const { token } = req.body || {};
    if (!token || typeof token !== "string" || !token.trim()) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing or empty token" });
    }

    const newToken = token.trim();

    try {
      process.env.SENPI_AUTH_TOKEN = newToken;

      const configDir = path.join(STATE_DIR, "config");
      const senpiTokenPath = path.join(configDir, "senpi.token");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(senpiTokenPath, newToken);
      console.log("[senpi-token] Persisted token to config/senpi.token");

      const mcpUrl =
        process.env.SENPI_MCP_URL || "https://mcp.dev.senpi.ai/mcp";
      const senpiConfig = JSON.stringify({
        url: mcpUrl,
        transport: "streamable-http",
        headers: { Authorization: `Bearer ${newToken}` },
      });
      const mcpSet = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["mcp", "set", "senpi", senpiConfig])
      );
      if (mcpSet.code !== 0) {
        console.error(
          `[senpi-token] openclaw mcp set senpi failed: exit=${mcpSet.code} output=${mcpSet.output.trim()}`
        );
        return res.status(500).json({
          ok: false,
          error: `openclaw mcp set failed: ${mcpSet.output.trim()}`,
        });
      }
      console.log("[senpi-token] Updated Senpi MCP config via openclaw mcp set");

      return res.json({
        ok: true,
        message: "Token updated. Senpi MCP reconfigured.",
      });
    } catch (err) {
      console.error(`[senpi-token] Error: ${err}`);
      return res
        .status(500)
        .json({ ok: false, error: String(err) });
    }
  });

  router.post("/api/reset", requireSetupAuth, async (_req, res) => {
    try {
      fs.rmSync(configPath(), { force: true });
      res
        .type("text/plain")
        .send("OK - deleted config file. You can rerun setup now.");
    } catch (err) {
      res.status(500).type("text/plain").send(String(err));
    }
  });

  router.get("/export", requireSetupAuth, async (_req, res) => {
    console.warn(
      `[export] BACKUP EXPORT requested at ${new Date().toISOString()} (auth passed, sensitive files excluded)`
    );

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    res.setHeader("content-type", "application/gzip");
    res.setHeader(
      "content-disposition",
      `attachment; filename="openclaw-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"`
    );

    const stateAbs = path.resolve(STATE_DIR);
    const workspaceAbs = path.resolve(WORKSPACE_DIR);
    const dataRoot = "/data";
    const underData = (p) => p === dataRoot || p.startsWith(dataRoot + path.sep);

    let cwd = "/";
    let paths = [stateAbs, workspaceAbs].map((p) => p.replace(/^\//, ""));

    if (underData(stateAbs) && underData(workspaceAbs)) {
      cwd = dataRoot;
      paths = [
        path.relative(dataRoot, stateAbs) || ".",
        path.relative(dataRoot, workspaceAbs) || ".",
      ];
    }

    const sensitivePath = (entryPath) => {
      const p = entryPath.replace(/\\/g, "/");
      if (p.includes("gateway.token") || p.endsWith(".token")) return true;
      if (p.includes("openclaw.json")) return true;
      return false;
    };

    const stream = tar.c(
      {
        gzip: true,
        portable: true,
        noMtime: true,
        cwd,
        onwarn: () => {},
        filter: (entryPath) => !sensitivePath(entryPath),
      },
      paths
    );

    stream.on("error", (err) => {
      console.error("[export]", err);
      if (!res.headersSent) res.status(500);
      res.end(String(err));
    });

    stream.pipe(res);
  });

  return router;
}
