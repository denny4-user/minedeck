'use strict';

// Archive creation and background extraction, shared by the web API and MCP.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const files = require('./files');

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

function timestamp() {
  const p2 = (n) => String(n).padStart(2, '0');
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
}

// Pack selected entries (direct children of `dir`) into a .tar.gz in `dir`.
function archive(dir, items, name) {
  return new Promise((resolve, reject) => {
    let dirAbs;
    let outAbs;
    const names = [];
    let fileName;
    try {
      dirAbs = files.resolveSafe(dir || '');
      if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) {
        throw badRequest('Целевая папка не найдена.');
      }
      if (!Array.isArray(items) || !items.length) {
        throw badRequest('Не выбраны файлы для архивации.');
      }
      for (const it of items) {
        const base = String(it).split('/').pop();
        if (!base || base === '.' || base === '..') throw badRequest('Некорректный элемент.');
        files.resolveSafe(path.join(dir || '', base)); // stay inside base dir
        if (!fs.existsSync(path.join(dirAbs, base))) throw badRequest(`Не найден: ${base}`);
        names.push(base);
      }
      const safe = (name ? String(name).replace(/[^a-zA-Z0-9_\-.]/g, '') : '') || ('archive_' + timestamp());
      fileName = safe.endsWith('.tar.gz') ? safe : safe + '.tar.gz';
      outAbs = files.resolveSafe(path.join(dir || '', fileName));
    } catch (err) {
      reject(err);
      return;
    }

    const proc = spawn('tar', ['-czf', outAbs, '-C', dirAbs, ...names]);
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve({ name: fileName, path: files.relOf(outAbs) });
      else reject(new Error('tar: ' + stderr.slice(0, 300)));
    });
  });
}

// Extraction runs as a background job (large archives take minutes); callers
// poll extractStatus() for progress.
const extractJobs = new Map(); // jobId -> { status, error, extracted, total, name, startedAt, finishedAt }

async function startExtract(relPath) {
  const info = await files.statInfo(relPath);
  if (info.isDir) throw badRequest('Это папка, а не архив.');
  const destDir = path.dirname(info.abs);
  const lower = info.name.toLowerCase();
  let cmd;
  let args;
  let kind;
  // -v adds a per-file line to stdout/stderr we count for progress.
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) { cmd = 'tar'; args = ['-xzvf', info.abs, '-C', destDir]; kind = 'tar'; }
  else if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) { cmd = 'tar'; args = ['-xjvf', info.abs, '-C', destDir]; kind = 'tar'; }
  else if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) { cmd = 'tar'; args = ['-xJvf', info.abs, '-C', destDir]; kind = 'tar'; }
  else if (lower.endsWith('.tar')) { cmd = 'tar'; args = ['-xvf', info.abs, '-C', destDir]; kind = 'tar'; }
  else if (lower.endsWith('.zip')) { cmd = 'unzip'; args = ['-o', info.abs, '-d', destDir]; kind = 'zip'; }
  else if (lower.endsWith('.gz')) { cmd = 'gunzip'; args = ['-kf', info.abs]; kind = 'gz'; }
  else throw badRequest('Неподдерживаемый формат архива.');

  const jobId = crypto.randomBytes(8).toString('hex');
  const job = { status: 'running', error: '', extracted: 0, total: 0, name: info.name, startedAt: Date.now(), finishedAt: 0 };
  extractJobs.set(jobId, job);

  // Fast entry count for zip (reads the central directory, not the data).
  if (kind === 'zip') {
    try {
      const out = execFileSync('zipinfo', ['-t', info.abs], { timeout: 20000, maxBuffer: 1024 * 1024 }).toString();
      const m = out.match(/(\d+)\s+files?/i);
      if (m) job.total = parseInt(m[1], 10);
    } catch (_) { /* no total -> UI shows a running count */ }
  }

  const proc = spawn(cmd, args);
  let stderr = '';
  const countLine = (line) => {
    if (kind === 'zip') { if (/^\s*(inflating|extracting|creating|linking):/.test(line)) job.extracted++; }
    else if (kind === 'tar') { if (line.trim()) job.extracted++; }
  };
  let outBuf = '';
  let errBuf = '';
  proc.stdout.on('data', (d0) => { outBuf += d0.toString(); let i; while ((i = outBuf.indexOf('\n')) >= 0) { countLine(outBuf.slice(0, i)); outBuf = outBuf.slice(i + 1); } });
  proc.stderr.on('data', (d0) => {
    const s = d0.toString(); stderr += s;
    if (kind === 'tar') { errBuf += s; let i; while ((i = errBuf.indexOf('\n')) >= 0) { countLine(errBuf.slice(0, i)); errBuf = errBuf.slice(i + 1); } }
  });
  proc.on('error', (err) => {
    job.status = 'error'; job.finishedAt = Date.now();
    job.error = err.code === 'ENOENT' ? `Утилита «${cmd}» не установлена на сервере (apt install ${cmd}).` : err.message;
  });
  proc.on('exit', (code) => {
    if (job.status === 'error') return;
    if (code === 0) { job.status = 'done'; }
    else { job.status = 'error'; job.error = `${cmd} завершился с кодом ${code}: ${(stderr || '').trim().slice(-300)}`; }
    job.finishedAt = Date.now();
    setTimeout(() => extractJobs.delete(jobId), 5 * 60 * 1000).unref();
  });

  return { jobId, total: job.total, name: info.name };
}

function extractStatus(jobId) {
  return extractJobs.get(String(jobId || '')) || null;
}

module.exports = { archive, startExtract, extractStatus };
