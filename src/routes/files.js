'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
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

// Extract an archive (.zip/.tar.gz/.tgz/.tar/.tar.bz2/.tar.xz/.gz) into its folder.
router.post('/extract', async (req, res) => {
  try {
    const info = await files.statInfo((req.body || {}).path);
    if (info.isDir) return res.status(400).json({ error: 'Это папка, а не архив.' });
    const destDir = path.dirname(info.abs);
    const lower = info.name.toLowerCase();
    let cmd;
    let args;
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) { cmd = 'tar'; args = ['-xzf', info.abs, '-C', destDir]; }
    else if (lower.endsWith('.tar.bz2') || lower.endsWith('.tbz2')) { cmd = 'tar'; args = ['-xjf', info.abs, '-C', destDir]; }
    else if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) { cmd = 'tar'; args = ['-xJf', info.abs, '-C', destDir]; }
    else if (lower.endsWith('.tar')) { cmd = 'tar'; args = ['-xf', info.abs, '-C', destDir]; }
    else if (lower.endsWith('.zip')) { cmd = 'unzip'; args = ['-o', info.abs, '-d', destDir]; }
    else if (lower.endsWith('.gz')) { cmd = 'gunzip'; args = ['-kf', info.abs]; }
    else return res.status(400).json({ error: 'Неподдерживаемый формат архива.' });

    const proc = spawn(cmd, args);
    let stderr = '';
    proc.stderr.on('data', (d0) => (stderr += d0.toString()));
    proc.on('error', (err) => {
      if (res.headersSent) return;
      if (err.code === 'ENOENT') res.status(501).json({ error: `Утилита «${cmd}» не установлена на сервере (apt install ${cmd}).` });
      else res.status(500).json({ error: err.message });
    });
    proc.on('exit', (code) => {
      if (res.headersSent) return;
      if (code === 0) res.json({ ok: true });
      else res.status(500).json({ error: `${cmd} завершился с кодом ${code}: ${stderr.slice(0, 300)}` });
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
