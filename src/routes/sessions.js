/**
 * Internal sessions API: exposes session data from the local OpenClaw instance.
 *
 * GET /internal/sessions              — list all sessions (via CLI)
 * GET /internal/sessions/:sessionId   — chat transcript for a session (reads JSONL file)
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Router } from "express";
import { runCmd } from "../lib/runCmd.js";
import { STATE_DIR, isConfigured } from "../lib/config.js";
import { ensureGatewayRunning } from "../gateway.js";

const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || "";

export function createSessionsRouter() {
  const router = Router();

  router.use(async (_req, res, next) => {
    if (!isConfigured()) {
      return res.status(503).json({ error: "not configured" });
    }
    try {
      await ensureGatewayRunning(gatewayToken);
    } catch {
      return res.status(503).json({ error: "gateway not ready" });
    }
    next();
  });

  router.get("/", async (_req, res) => {
    const { code, output } = await runCmd("openclaw", [
      "sessions",
      "--all-agents",
      "--json",
    ]);
    if (code !== 0) {
      return res.status(502).json({ error: "session list failed", detail: output.slice(0, 500) });
    }
    try {
      const parsed = JSON.parse(output);
      return res.json(parsed);
    } catch {
      return res.status(502).json({ error: "invalid session response" });
    }
  });

  router.get("/:sessionId", async (req, res) => {
    const { sessionId } = req.params;
    if (!sessionId) {
      return res.status(400).json({ error: "missing session ID" });
    }

    const { code, output } = await runCmd("openclaw", [
      "sessions",
      "--all-agents",
      "--json",
    ]);
    if (code !== 0) {
      return res.status(502).json({ error: "session lookup failed" });
    }

    let sessionList;
    try {
      sessionList = JSON.parse(output);
    } catch {
      return res.status(502).json({ error: "invalid session response" });
    }

    const sessions = sessionList.sessions || [];
    const match = sessions.find(
      (s) => s.sessionId === sessionId || s.key === sessionId
    );
    if (!match) {
      return res.status(404).json({ error: "session not found" });
    }

    const keyParts = (match.key || "").split(":");
    const agentId = keyParts.length >= 2 ? keyParts[1] : "main";

    const transcriptPath = path.join(
      STATE_DIR,
      "agents",
      agentId,
      "sessions",
      `${match.sessionId}.jsonl`
    );

    if (!fs.existsSync(transcriptPath)) {
      return res.json({ key: match.key, sessionId: match.sessionId, messages: [] });
    }

    try {
      const messages = await readTranscript(transcriptPath);
      return res.json({
        key: match.key,
        sessionId: match.sessionId,
        messages,
      });
    } catch (err) {
      console.error(`[sessions] transcript read error: ${err.message}`);
      return res.status(502).json({ error: "transcript read failed" });
    }
  });

  return router;
}

async function readTranscript(filePath) {
  const messages = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.role && entry.content !== undefined) {
        messages.push({
          role: entry.role,
          content: typeof entry.content === "string"
            ? entry.content
            : JSON.stringify(entry.content),
          timestamp: entry.timestamp || entry.ts || entry.createdAt || null,
        });
      }
    } catch {
      // skip malformed lines
    }
  }
  return messages;
}
