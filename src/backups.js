'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn, execFile } = require('child_process');
const config = require('./config');
const mcserver = require('./mcserver');

// Size of one path in KB via `du -sk` (portable: works on GNU and BSD du).
function duKB(target, cwd) {
  return new Promise((resolve) => {
    execFile('du', ['-sk', target], { cwd, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve(0);
      const kb = parseInt(String(stdout).trim().split(/\s+/)[0], 10);
      resolve(Number.isFinite(kb) ? kb : 0);
    });
  });
}

// How much data tar will actually pack: the server dir minus the excluded
// top-level entries. Used to report backup progress as a percentage.
async function measureSourceKB(srcDir, excludes) {
  let total = await duKB('.', srcDir);
  if (!total) return 0;
  for (const ex of excludes) {
    const p = path.join(srcDir, ex);
    if (!fs.existsSync(p)) continue;
    total -= await duKB(ex, srcDir);
  }
  return Math.max(0, total);
}

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
// `onProgress` is optional: when given, tar runs verbosely and progress is
// reported as { phase, files, bytesDone, totalBytes, archiveBytes }.
async function create(label, onProgress) {
  const cfg = config.get();
  const srcDir = cfg.server.directory;
  if (!fs.existsSync(srcDir)) {
    throw new Error(`Директория сервера не найдена: ${srcDir}`);
  }
  const dir = backupsDir();
  const lbl = safeName(label);
  const fileName = `backup_${timestamp()}${lbl ? '_' + lbl : ''}.tar.gz`;
  const outPath = path.join(dir, fileName);

  const excludes = [...(cfg.backups.exclude || [])];
  // Also exclude the backups dir itself if it lives inside the server dir.
  const rel = path.relative(srcDir, dir);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) excludes.push(rel);

  // Measure first so progress can be a real percentage (skipped without a
  // progress consumer, e.g. scheduled backups).
  let totalBytes = 0;
  if (onProgress) {
    onProgress({ phase: 'measuring', files: 0, bytesDone: 0, totalBytes: 0, archiveBytes: 0, name: fileName });
    totalBytes = (await measureSourceKB(srcDir, excludes)) * 1024;
    onProgress({ phase: 'packing', files: 0, bytesDone: 0, totalBytes, archiveBytes: 0, name: fileName });
  }

  const args = [onProgress ? '-czvf' : '-czf', outPath];
  for (const ex of excludes) args.push('--exclude', ex);
  args.push('-C', srcDir, '.');

  mcserver.pushLine(`[MineDeck] Создание бэкапа: ${fileName}`, 'sys');

  return new Promise((resolve, reject) => {
    const proc = spawn('tar', args);
    let stderr = '';
    let files = 0;
    let bytesDone = 0;

    if (onProgress) {
      // tar -v prints one path per packed entry. Sum their sizes in batches so
      // the event loop isn't hit with a stat() per line on large trees.
      let pending = [];
      let buf = { out: '', err: '' };
      const collect = (chunk, key) => {
        buf[key] += chunk.toString();
        let i;
        while ((i = buf[key].indexOf('\n')) >= 0) {
          let line = buf[key].slice(0, i).trim();
          buf[key] = buf[key].slice(i + 1);
          if (!line || line.startsWith('tar:')) continue;
          // GNU tar prints "./path"; BSD tar prefixes entries with "a ".
          if (!line.startsWith('./') && !line.startsWith('/')) line = line.replace(/^\S+\s+/, '');
          if (line) pending.push(line);
        }
      };
      proc.stdout.on('data', (d) => collect(d, 'out'));
      proc.stderr.on('data', (d) => { stderr += d.toString(); collect(d, 'err'); });

      const flush = () => {
        if (pending.length) {
          const batch = pending;
          pending = [];
          for (const entry of batch) {
            try {
              const st = fs.statSync(path.join(srcDir, entry));
              if (st.isFile()) { files++; bytesDone += st.size; }
            } catch (_) { /* file vanished mid-backup — ignore */ }
          }
        }
        let archiveBytes = 0;
        try { archiveBytes = fs.statSync(outPath).size; } catch (_) {}
        onProgress({ phase: 'packing', files, bytesDone, totalBytes, archiveBytes, name: fileName });
      };
      const ticker = setInterval(flush, 500);
      proc.on('exit', () => { clearInterval(ticker); flush(); });
    } else {
      proc.stderr.on('data', (d) => (stderr += d.toString()));
    }

    proc.on('error', (err) => reject(err));
    proc.on('exit', async (code) => {
      // tar exit code 1 = "some files changed while reading" (server running) — tolerate.
      if (code === 0 || code === 1) {
        try {
          const st = await fsp.stat(outPath);
          if (onProgress) onProgress({ phase: 'pruning', files, bytesDone, totalBytes, archiveBytes: st.size, name: fileName });
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
