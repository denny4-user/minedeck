'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');
const mcserver = require('../mcserver');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

// Return config without secrets.
function publicConfig() {
  const c = config.get();
  return {
    server: c.server,
    panel: { host: c.panel.host, port: c.panel.port },
    backups: { maxKeep: c.backups.maxKeep, exclude: c.backups.exclude, directory: c.backups.directory },
    aikarFlags: config.AIKAR_FLAGS.join(' '),
    cpuCount: os.cpus().length,
    hasTaskset: mcserver.HAS_TASKSET,
  };
}

router.get('/', (req, res) => {
  res.json({ ...publicConfig(), commandPreview: mcserver.describeCommand() });
});

router.post('/server', (req, res) => {
  const b = req.body || {};
  const cur = config.get().server;
  const min = b.minRamMB != null ? Math.max(128, parseInt(b.minRamMB, 10) || cur.minRamMB) : cur.minRamMB;
  let max = b.maxRamMB != null ? Math.max(256, parseInt(b.maxRamMB, 10) || cur.maxRamMB) : cur.maxRamMB;
  if (max < min) max = min;

  const cpuCores = b.cpuCores != null
    ? Math.max(0, Math.min(os.cpus().length, parseInt(b.cpuCores, 10) || 0))
    : cur.cpuCores;

  const patch = {
    server: {
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
    },
  };
  config.update(patch);
  res.json({ ok: true, server: config.get().server, commandPreview: mcserver.describeCommand() });
});

router.post('/panel', (req, res) => {
  const b = req.body || {};
  const cur = config.get().panel;
  const patch = { panel: {} };
  if (b.port != null) {
    const p = parseInt(b.port, 10);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return res.status(400).json({ error: 'Некорректный порт панели.' });
    patch.panel.port = p;
  }
  if (typeof b.host === 'string' && b.host.trim()) patch.panel.host = b.host.trim();
  config.update(patch);
  res.json({ ok: true, panel: { host: config.get().panel.host, port: config.get().panel.port }, note: 'Изменения порта/хоста вступят в силу после перезапуска панели.' });
});

// ---- server.properties ----------------------------------------------------
function propsPath() {
  return path.join(config.get().server.directory, 'server.properties');
}

router.get('/properties', (req, res) => {
  const file = propsPath();
  if (!fs.existsSync(file)) {
    return res.json({ exists: false, properties: {}, raw: '' });
  }
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const properties = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      properties[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
    }
    res.json({ exists: true, properties, raw });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/properties', (req, res) => {
  const updates = (req.body || {}).properties;
  if (!updates || typeof updates !== 'object') {
    return res.status(400).json({ error: 'Нет данных для сохранения.' });
  }
  const file = propsPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
    const remaining = { ...updates };
    lines = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      const eq = trimmed.indexOf('=');
      if (eq < 0) return line;
      const key = trimmed.slice(0, eq).trim();
      if (Object.prototype.hasOwnProperty.call(remaining, key)) {
        const val = remaining[key];
        delete remaining[key];
        return `${key}=${val}`;
      }
      return line;
    });
    for (const [key, val] of Object.entries(remaining)) {
      lines.push(`${key}=${val}`);
    }
    let out = lines.join('\n');
    if (!out.endsWith('\n')) out += '\n';
    fs.writeFileSync(file, out);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
