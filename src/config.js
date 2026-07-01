'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Aikar's flags — well-known GC tuning for Minecraft servers.
const AIKAR_FLAGS = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:+AlwaysPreTouch',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1',
  '-Dusing.aikars.flags=https://mcflags.emc.gs',
  '-Daikars.new.flags=true',
];

function defaultConfig() {
  return {
    panel: {
      host: '0.0.0.0',
      port: 8080,
      sessionSecret: crypto.randomBytes(32).toString('hex'),
    },
    auth: {
      username: null,
      passwordHash: null,
    },
    server: {
      directory: '/opt/minecraft',
      jar: 'server.jar',
      javaPath: 'java',
      minRamMB: 1024,
      maxRamMB: 2048,
      cpuCores: 0,
      jvmFlags: '',
      useAikarFlags: false,
      customCommand: '',
      stopCommand: 'stop',
      stopTimeoutSec: 45,
      autoStart: false,
      autoRestart: true,
    },
    backups: {
      directory: path.join(DATA_DIR, 'backups'),
      maxKeep: 10,
      exclude: ['backups', 'cache', 'logs', 'crash-reports'],
    },
    schedule: {
      tasks: [],
    },
    databases: {
      mysql: {
        host: '127.0.0.1',
        port: 3306,
        adminUser: 'root',
        adminPassword: '',
        socketPath: '/run/mysqld/mysqld.sock',
        grantHost: '%',
      },
      created: [],
    },
  };
}

function deepMerge(base, override) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const key of Object.keys(override || {})) {
    const ov = override[key];
    if (ov && typeof ov === 'object' && !Array.isArray(ov) && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], ov);
    } else {
      out[key] = ov;
    }
  }
  return out;
}

let current = null;

function ensureDirs(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { fs.mkdirSync(cfg.backups.directory, { recursive: true }); } catch (_) {}
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let stored = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (err) {
      console.error('[config] failed to parse config.json, using defaults:', err.message);
    }
  }
  current = deepMerge(defaultConfig(), stored);
  // Persist a fresh session secret / defaults on first run.
  if (!fs.existsSync(CONFIG_FILE)) save();
  ensureDirs(current);
  return current;
}

function get() {
  if (!current) load();
  return current;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2));
  ensureDirs(current);
}

// Merge a partial update into config and persist. Never allow overriding
// sensitive/derived fields via the generic updater unless explicitly passed.
function update(partial) {
  current = deepMerge(get(), partial);
  save();
  return current;
}

module.exports = {
  ROOT,
  DATA_DIR,
  CONFIG_FILE,
  AIKAR_FLAGS,
  load,
  get,
  save,
  update,
  defaultConfig,
};
