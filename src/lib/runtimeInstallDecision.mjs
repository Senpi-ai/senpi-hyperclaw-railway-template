/**
 * Pure decision logic for the Senpi runtime plugin (re)install in bootstrap.mjs.
 *
 * Extracted from `installSenpiRuntimePluginIfNeeded` so the wipe/reinstall
 * trigger can be unit-tested in isolation — see the "scope mismatch ⇒ wipe on
 * every boot" failure mode this guards against (fleet-update spec §4.2) and the
 * production incident where hoisted transitive deps never downgraded because the
 * old spec-mismatch path only removed the plugin dir, not the whole tree (§2).
 *
 * Two independent triggers, both compared against what was last recorded on the
 * volume (`cfg.plugins.installs["runtime"]` in STATE_DIR/openclaw.json):
 *
 *   1. Spec change   — recorded `spec` !== configured `SENPI_RUNTIME_NPM_SPEC`.
 *   2. Reinstall nonce — recorded `nonce` !== configured
 *      `SENPI_RUNTIME_REINSTALL_NONCE`, but ONLY when the configured nonce is
 *      non-empty. Absent and empty-string are treated identically and mean
 *      "never force". The nonce is a one-shot latch: the volume records the last
 *      value acted on, so only *inequality* fires — the same value on the next
 *      boot no-ops, and removing the nonce from the env after it was recorded
 *      also no-ops (empty configured nonce never triggers).
 *
 * A spec change (or nonce trigger) on an existing install returns
 * `wipeAndInstall`: the caller wipes the ENTIRE managed node_modules tree
 * (not just the plugin dir) so transitive deps re-resolve from scratch and can
 * downgrade. A missing install record returns `install` (fresh volume / scope
 * change with no record to compare) — nothing to wipe.
 *
 * @typedef {Object} InstallRecord
 * @property {boolean} exists  Whether cfg.plugins.installs["runtime"] is present.
 * @property {string} [spec]   Recorded npm spec of the last install.
 * @property {string} [nonce]  Recorded reinstall nonce of the last install.
 *
 * @typedef {Object} InstallEnv
 * @property {string} spec     Configured SENPI_RUNTIME_NPM_SPEC.
 * @property {string} [nonce]  Configured SENPI_RUNTIME_REINSTALL_NONCE.
 *
 * @typedef {Object} InstallDecision
 * @property {"none"|"install"|"wipeAndInstall"} action
 * @property {string} reason   Human-readable, safe to log.
 */

/**
 * Normalize a nonce for comparison: absent (null/undefined) and empty/whitespace
 * are all collapsed to "" so they compare equal. Trimming also defends against a
 * stray newline injected by the env layer masquerading as a "new" value.
 *
 * @param {unknown} v
 * @returns {string}
 */
export function normalizeNonce(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

/**
 * Decide what the runtime installer should do given the recorded install state
 * and the configured environment. Pure: no I/O, no env reads.
 *
 * @param {{ record?: InstallRecord|null, env: InstallEnv }} args
 * @returns {InstallDecision}
 */
export function decideRuntimeInstall({ record, env } = {}) {
  const configuredSpec = env?.spec;
  const configuredNonce = normalizeNonce(env?.nonce);
  const recordedNonce = normalizeNonce(record?.nonce);

  // A configured nonce only forces when it's non-empty AND differs from what was
  // recorded. Empty configured nonce = never force (removing it after a record
  // was written no-ops).
  const nonceForces = configuredNonce !== "" && configuredNonce !== recordedNonce;

  // No recorded install: fresh volume, or a scope change whose record was lost.
  // Nothing on the tree to wipe — install cleanly.
  if (!record || !record.exists) {
    return {
      action: "install",
      reason: "no install record (fresh volume or missing record)",
    };
  }

  // Spec change takes precedence — the recorded install is for a different spec.
  if (record.spec !== configuredSpec) {
    return {
      action: "wipeAndInstall",
      reason:
        `spec changed (recorded=${JSON.stringify(record.spec)} ` +
        `configured=${JSON.stringify(configuredSpec)})`,
    };
  }

  if (nonceForces) {
    return {
      action: "wipeAndInstall",
      reason:
        `reinstall nonce changed (recorded=${JSON.stringify(recordedNonce)} ` +
        `configured=${JSON.stringify(configuredNonce)})`,
    };
  }

  return {
    action: "none",
    reason: "spec and nonce match recorded install",
  };
}
