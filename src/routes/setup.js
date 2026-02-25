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

/** Lazy: server.js sets process.env.OPENCLAW_GATEWAY_TOKEN after imports. */
function getGatewayToken() {
  return process.env.OPENCLAW_GATEWAY_TOKEN || "";
}
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
    hint: "Gemini API key + OAuth",
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
    res.json({ token: getGatewayToken() });
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
        await ensureGatewayRunning(getGatewayToken());
        return res.json({
          ok: true,
          output:
            "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
        });
      }

      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

      const payload = req.body || {};
      const gatewayToken = getGatewayToken();
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
            const cfgObj = {
              enabled: true,
              dmPolicy: "pairing",
              botToken: token,
              groupPolicy: "allowlist",
              streamMode: "partial",
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
        await restartGateway(getGatewayToken());
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

      const mcporterPath =
        process.env.MCPORTER_CONFIG ||
        path.join(STATE_DIR, "config", "mcporter.json");

      let config;
      try {
        config = JSON.parse(fs.readFileSync(mcporterPath, "utf8"));
      } catch {
        config = { mcpServers: {}, imports: [] };
      }
      if (!config.mcpServers) config.mcpServers = {};

      if (
        config.mcpServers.senpi &&
        typeof config.mcpServers.senpi === "object"
      ) {
        if (!config.mcpServers.senpi.env)
          config.mcpServers.senpi.env = {};
        config.mcpServers.senpi.env.SENPI_AUTH_TOKEN = newToken;
      } else {
        const mcpUrl =
          process.env.SENPI_MCP_URL || "https://mcp.dev.senpi.ai/mcp";
        config.mcpServers.senpi = {
          command: "npx",
          args: [
            "mcp-remote",
            mcpUrl,
            "--header",
            "Authorization: Bearer ${SENPI_AUTH_TOKEN}",
          ],
          env: { SENPI_AUTH_TOKEN: newToken },
        };
      }

      fs.writeFileSync(mcporterPath, JSON.stringify(config, null, 2));
      console.log("[senpi-token] Updated mcporter.json with new token");

      try {
        const kill = await runCmd("pkill", ["-f", "mcp-remote"]);
        console.log(`[senpi-token] pkill mcp-remote: exit=${kill.code}`);
      } catch {
        // ok
      }

      return res.json({
        ok: true,
        message:
          "Token updated. mcp-remote processes killed — next MCP call will use the new token.",
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
      if (p.includes("mcporter.json")) return true;
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
