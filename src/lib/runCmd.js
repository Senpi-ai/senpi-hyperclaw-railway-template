/**
 * Run a command with optional env overrides. Used by gateway and onboarding.
 */

import childProcess from "node:child_process";
import { STATE_DIR, WORKSPACE_DIR } from "./config.js";

/**
 * @param {string} cmd - executable
 * @param {string[]} args - arguments
 * @param {{ cwd?: string, env?: Record<string, string> }} [opts]
 * @returns {Promise<{ code: number, output: string }>}
 */
export function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
        ...opts.env,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}
