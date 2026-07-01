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
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB per file
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

// Upload one or more files into a target directory.
router.post('/upload', upload.array('files'), async (req, res) => {
  try {
    const dest = req.body.path || '';
    const destAbs = files.resolveSafe(dest);
    const st = fs.existsSync(destAbs) ? fs.statSync(destAbs) : null;
    if (!st || !st.isDirectory()) {
      throw Object.assign(new Error('Целевая папка не найдена.'), { status: 400 });
    }
    const saved = [];
    for (const file of req.files || []) {
      const targetAbs = files.resolveSafe(path.join(dest, file.originalname));
      await fs.promises.rename(file.path, targetAbs).catch(async () => {
        // rename across devices fails -> copy
        await fs.promises.copyFile(file.path, targetAbs);
        await fs.promises.unlink(file.path).catch(() => {});
      });
      saved.push(file.originalname);
    }
    res.json({ ok: true, saved });
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

module.exports = router;
