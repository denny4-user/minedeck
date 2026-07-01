'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const mcserver = require('./mcserver');

function backupsDir() {
  const dir = config.get().backups.directory;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function safeName(name) {
  return String(name || '').replace(/[^a-zA-Z0-9_\-.]/g, '');
}

async function list() {
  const dir = backupsDir();
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch (_) {
    return [];
  }
  const items = [];
  for (const name of names) {
    if (!name.endsWith('.tar.gz')) continue;
    try {
      const st = await fsp.stat(path.join(dir, name));
      items.push({ name, size: st.size, created: st.mtimeMs });
    } catch (_) {}
  }
  items.sort((a, b) => b.created - a.created);
  return items;
}

// Create a tar.gz of the whole server directory (minus excludes).
function create(label) {
  return new Promise((resolve, reject) => {
    const cfg = config.get();
    const srcDir = cfg.server.directory;
    if (!fs.existsSync(srcDir)) {
      return reject(new Error(`Директория сервера не найдена: ${srcDir}`));
    }
    const dir = backupsDir();
    const lbl = safeName(label);
    const fileName = `backup_${timestamp()}${lbl ? '_' + lbl : ''}.tar.gz`;
    const outPath = path.join(dir, fileName);

    const args = ['-czf', outPath];
    for (const ex of cfg.backups.exclude || []) {
      args.push('--exclude', ex);
    }
    // Also exclude the backups dir itself if it lives inside the server dir.
    const rel = path.relative(srcDir, dir);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      args.push('--exclude', rel);
    }
    args.push('-C', srcDir, '.');

    mcserver.pushLine(`[MineDeck] Создание бэкапа: ${fileName}`, 'sys');
    const proc = spawn('tar', args);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => reject(err));
    proc.on('exit', async (code) => {
      // tar exit code 1 = "some files changed while reading" (server running) — tolerate.
      if (code === 0 || code === 1) {
        try {
          const st = await fsp.stat(outPath);
          await prune();
          mcserver.pushLine(`[MineDeck] Бэкап готов: ${fileName} (${(st.size / 1048576).toFixed(1)} МБ)`, 'sys');
          resolve({ name: fileName, size: st.size, created: st.mtimeMs });
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error(`tar завершился с кодом ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

async function prune() {
  const max = parseInt(config.get().backups.maxKeep, 10) || 0;
  if (max <= 0) return;
  const items = await list();
  if (items.length <= max) return;
  const toDelete = items.slice(max);
  for (const item of toDelete) {
    try {
      await fsp.unlink(path.join(backupsDir(), item.name));
      mcserver.pushLine(`[MineDeck] Удалён старый бэкап: ${item.name}`, 'sys');
    } catch (_) {}
  }
}

function pathFor(name) {
  const safe = safeName(name);
  if (!safe.endsWith('.tar.gz')) throw Object.assign(new Error('Недопустимое имя бэкапа.'), { status: 400 });
  const p = path.join(backupsDir(), safe);
  if (!fs.existsSync(p)) throw Object.assign(new Error('Бэкап не найден.'), { status: 404 });
  return p;
}

async function remove(name) {
  const p = pathFor(name);
  await fsp.unlink(p);
  return { name: safeName(name) };
}

// Restore a backup into the server directory. Server must be stopped.
function restore(name) {
  return new Promise((resolve, reject) => {
    if (mcserver.state !== 'stopped') {
      return reject(Object.assign(new Error('Остановите сервер перед восстановлением бэкапа.'), { status: 409 }));
    }
    let src;
    try {
      src = pathFor(name);
    } catch (err) {
      return reject(err);
    }
    const destDir = config.get().server.directory;
    fs.mkdirSync(destDir, { recursive: true });
    mcserver.pushLine(`[MineDeck] Восстановление из бэкапа: ${safeName(name)}`, 'sys');
    const proc = spawn('tar', ['-xzf', src, '-C', destDir]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', (err) => reject(err));
    proc.on('exit', (code) => {
      if (code === 0) {
        mcserver.pushLine('[MineDeck] Восстановление завершено.', 'sys');
        resolve({ name: safeName(name) });
      } else {
        reject(new Error(`tar завершился с кодом ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

module.exports = {
  backupsDir,
  list,
  create,
  prune,
  remove,
  restore,
  pathFor,
};
