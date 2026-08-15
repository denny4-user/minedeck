'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const multer = require('multer');
const files = require('../files');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 1024 * 1024 * 1024, files: 20000 }, // 1 GB per file
});

function handle(res, promise) {
  promise.then((data) => res.json({ ok: true, ...data })).catch((err) => {
    res.status(err.status || 500).json({ error: err.message });
  });
}

router.get('/list', (req, res) => {
  handle(res, files.list(req.query.path || ''));
});

router.get('/read', (req, res) => {
  handle(res, files.readText(req.query.path || ''));
});

router.post('/write', (req, res) => {
  const { path: p, content } = req.body || {};
  handle(res, files.writeText(p, content == null ? '' : String(content)));
});

router.post('/mkdir', (req, res) => {
  handle(res, files.mkdir((req.body || {}).path || ''));
});

router.post('/delete', (req, res) => {
  handle(res, files.remove((req.body || {}).path || ''));
});

router.post('/rename', (req, res) => {
  const { path: p, newName } = req.body || {};
  handle(res, files.rename(p, newName));
});

// Upload one or more files (and whole folders via drag-and-drop) into a
// target directory. Optional `relpaths` (JSON array, aligned with the files)
// preserves folder structure by carrying each file's path relative to dest.
router.post('/upload', upload.array('files'), async (req, res) => {
  try {
    const dest = req.body.path || '';
    const destAbs = files.resolveSafe(dest);
    const st = fs.existsSync(destAbs) ? fs.statSync(destAbs) : null;
    if (!st || !st.isDirectory()) {
      throw Object.assign(new Error('Целевая папка не найдена.'), { status: 400 });
    }
    let relpaths = [];
    if (req.body.relpaths) {
      try { relpaths = JSON.parse(req.body.relpaths); } catch (_) { relpaths = []; }
    }
    const saved = [];
    const list = req.files || [];
    for (let i = 0; i < list.length; i++) {
      const file = list[i];
      const rel = (Array.isArray(relpaths) && relpaths[i]) ? relpaths[i] : file.originalname;
      const targetAbs = files.resolveSafe(path.join(dest, rel)); // guards against traversal
      await fs.promises.mkdir(path.dirname(targetAbs), { recursive: true });
      await fs.promises.rename(file.path, targetAbs).catch(async () => {
        // rename across devices fails -> copy
        await fs.promises.copyFile(file.path, targetAbs);
        await fs.promises.unlink(file.path).catch(() => {});
      });
      saved.push(rel);
    }
    res.json({ ok: true, saved, count: saved.length });
  } catch (err) {
    // Clean up temp files on failure.
    for (const file of req.files || []) fs.promises.unlink(file.path).catch(() => {});
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Download a single file, or a directory as a streamed tar.gz.
router.get('/download', async (req, res) => {
  try {
    const info = await files.statInfo(req.query.path || '');
    if (info.isDir) {
      const name = (info.name || 'folder') + '.tar.gz';
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
      const proc = spawn('tar', ['-czf', '-', '-C', path.dirname(info.abs), info.name]);
      proc.stdout.pipe(res);
      proc.stderr.resume();
      proc.on('error', () => { if (!res.headersSent) res.status(500).end(); });
      req.on('close', () => proc.kill('SIGKILL'));
    } else {
      res.download(info.abs, info.name);
    }
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Archive selected entries (direct children of `dir`) into a .tar.gz in `dir`.
router.post('/archive', (req, res) => {
  try {
    const { dir, items, name } = req.body || {};
    const dirAbs = files.resolveSafe(dir || '');
    if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) {
      return res.status(400).json({ error: 'Целевая папка не найдена.' });
    }
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Не выбраны файлы для архивации.' });
    }
    const names = [];
    for (const it of items) {
      const base = String(it).split('/').pop();
      if (!base || base === '.' || base === '..') return res.status(400).json({ error: 'Некорректный элемент.' });
      files.resolveSafe(path.join(dir || '', base)); // stay inside base dir
      if (!fs.existsSync(path.join(dirAbs, base))) return res.status(400).json({ error: `Не найден: ${base}` });
      names.push(base);
    }
    const p2 = (n) => String(n).padStart(2, '0');
    const d = new Date();
    const ts = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
    const safe = (name ? String(name).replace(/[^a-zA-Z0-9_\-.]/g, '') : '') || ('archive_' + ts);
    const fileName = safe.endsWith('.tar.gz') ? safe : safe + '.tar.gz';
    const outAbs = files.resolveSafe(path.join(dir || '', fileName));
    const proc = spawn('tar', ['-czf', outAbs, '-C', dirAbs, ...names]);
    let stderr = '';
    proc.stderr.on('data', (d0) => (stderr += d0.toString()));
    proc.on('error', (err) => { if (!res.headersSent) res.status(500).json({ error: err.message }); });
    proc.on('exit', (code) => {
      if (res.headersSent) return;
      if (code === 0) res.json({ ok: true, name: fileName });
      else res.status(500).json({ error: 'tar: ' + stderr.slice(0, 300) });
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Extraction runs as a background job (large archives take minutes) so the HTTP
// request doesn't hang/time out. The client polls /extract-status for progress.
const extractJobs = new Map(); // jobId -> { status, error, extracted, total, name, startedAt, finishedAt }

router.post('/extract', async (req, res) => {
  try {
    const info = await files.statInfo((req.body || {}).path);
    if (info.isDir) return res.status(400).json({ error: 'Это папка, а не архив.' });
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
    else return res.status(400).json({ error: 'Неподдерживаемый формат архива.' });

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
      setTimeout(() => extractJobs.delete(jobId), 5 * 60 * 1000);
    });

    res.json({ ok: true, jobId, total: job.total });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/extract-status', (req, res) => {
  const job = extractJobs.get(String(req.query.id || ''));
  if (!job) return res.status(404).json({ error: 'Задача распаковки не найдена (возможно, уже завершена).' });
  res.json({ status: job.status, error: job.error, extracted: job.extracted, total: job.total, name: job.name });
});

// ---- Chunked upload (for large files, resumable per chunk) ----------------
const UPLOAD_TMP = '.minedeck-uploads';
function uploadTmpDir() {
  const dir = path.join(files.baseDir(), UPLOAD_TMP);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const MAX_CHUNK = 64 * 1024 * 1024; // safety cap (client uses 16 MB chunks)

router.post('/upload-chunk', (req, res) => {
  const uploadId = String(req.headers['x-upload-id'] || '');
  const index = parseInt(req.headers['x-chunk-index'], 10);
  const total = parseInt(req.headers['x-total-chunks'], 10);
  const offset = parseInt(req.headers['x-offset'], 10) || 0;
  const decode = (h) => { try { return Buffer.from(String(req.headers[h] || ''), 'base64').toString('utf8'); } catch (_) { return ''; } };
  const dest = decode('x-dest');
  const relPath = decode('x-rel-path');

  if (!/^[a-zA-Z0-9_]{6,64}$/.test(uploadId) || !Number.isInteger(index) || !Number.isInteger(total) || index < 0 || total < 1) {
    return res.status(400).json({ error: 'Некорректные параметры чанка.' });
  }
  let targetAbs;
  try {
    files.resolveSafe(dest);
    targetAbs = files.resolveSafe(path.join(dest, relPath));
  } catch (err) { return res.status(err.status || 400).json({ error: err.message }); }

  const tmpPath = path.join(uploadTmpDir(), uploadId + '.part');
  const parts = [];
  let size = 0;
  let over = false;
  req.on('data', (d) => { size += d.length; if (size <= MAX_CHUNK) parts.push(d); else over = true; });
  req.on('error', () => { if (!res.headersSent) res.status(400).json({ error: 'Ошибка приёма чанка.' }); });
  req.on('end', () => {
    if (res.headersSent) return;
    if (over) return res.status(413).json({ error: 'Чанк слишком большой.' });
    try {
      const buf = Buffer.concat(parts);
      const fd = fs.openSync(tmpPath, index === 0 ? 'w' : 'r+');
      try { fs.writeSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
      if (index === total - 1) {
        fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
        fs.renameSync(tmpPath, targetAbs); // same filesystem -> atomic, no copy
        return res.json({ ok: true, done: true });
      }
      res.json({ ok: true, done: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

router.post('/upload-abort', (req, res) => {
  const uploadId = String((req.body || {}).uploadId || '');
  if (!/^[a-zA-Z0-9_]{6,64}$/.test(uploadId)) return res.status(400).json({ error: 'Некорректный id.' });
  try { fs.unlinkSync(path.join(uploadTmpDir(), uploadId + '.part')); } catch (_) {}
  res.json({ ok: true });
});

module.exports = router;
