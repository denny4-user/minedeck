'use strict';

// Launch-settings read/update/preview, shared by the web API and MCP.

const os = require('os');
const config = require('./config');
const mcserver = require('./mcserver');

// Shared normalization between the real save and the dry-run preview, so both
// apply identical clamping/validation rules.
function normalizeServerPatch(b, cur) {
  const min = b.minRamMB != null ? Math.max(128, parseInt(b.minRamMB, 10) || cur.minRamMB) : cur.minRamMB;
  let max = b.maxRamMB != null ? Math.max(256, parseInt(b.maxRamMB, 10) || cur.maxRamMB) : cur.maxRamMB;
  if (max < min) max = min;

  const cpuCores = b.cpuCores != null
    ? Math.max(0, Math.min(os.cpus().length, parseInt(b.cpuCores, 10) || 0))
    : cur.cpuCores;

  return {
    directory: typeof b.directory === 'string' && b.directory.trim() ? b.directory.trim() : cur.directory,
    jar: typeof b.jar === 'string' && b.jar.trim() ? b.jar.trim() : cur.jar,
    javaPath: typeof b.javaPath === 'string' && b.javaPath.trim() ? b.javaPath.trim() : cur.javaPath,
    minRamMB: min,
    maxRamMB: max,
    cpuCores,
    jvmFlags: typeof b.jvmFlags === 'string' ? b.jvmFlags : cur.jvmFlags,
    useAikarFlags: b.useAikarFlags != null ? !!b.useAikarFlags : cur.useAikarFlags,
    customCommand: typeof b.customCommand === 'string' ? b.customCommand : cur.customCommand,
    stopCommand: typeof b.stopCommand === 'string' && b.stopCommand.trim() ? b.stopCommand.trim() : cur.stopCommand,
    stopTimeoutSec: b.stopTimeoutSec != null ? Math.max(5, parseInt(b.stopTimeoutSec, 10) || cur.stopTimeoutSec) : cur.stopTimeoutSec,
    autoStart: b.autoStart != null ? !!b.autoStart : cur.autoStart,
    autoRestart: b.autoRestart != null ? !!b.autoRestart : cur.autoRestart,
  };
}

// Config without secrets, plus the resulting launch command.
function get() {
  const c = config.get();
  return {
    server: c.server,
    panel: { host: c.panel.host, port: c.panel.port },
    backups: { maxKeep: c.backups.maxKeep, exclude: c.backups.exclude, directory: c.backups.directory },
    aikarFlags: config.AIKAR_FLAGS.join(' '),
    cpuCount: os.cpus().length,
    hasTaskset: mcserver.HAS_TASKSET,
    commandPreview: mcserver.describeCommand(),
  };
}

function update(body) {
  config.update({ server: normalizeServerPatch(body || {}, config.get().server) });
  const commandPreview = mcserver.describeCommand();
  return { server: config.get().server, commandPreview, warnings: mcserver.commandWarnings(commandPreview) };
}

// Resulting command for hypothetical (unsaved) values — nothing is persisted.
function preview(body) {
  const hypothetical = normalizeServerPatch(body || {}, config.get().server);
  const commandPreview = mcserver.describeCommand(hypothetical);
  return { commandPreview, warnings: mcserver.commandWarnings(commandPreview) };
}

module.exports = { normalizeServerPatch, get, update, preview };
