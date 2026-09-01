'use strict';

const express = require('express');
const crypto = require('crypto');
const backups = require('../backups');
const config = require('../config');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  backups.list().then((items) => {
    res.json({ backups: items, settings: config.get().backups });
  }).catch((err) => res.status(500).json({ error: err.message }));
});

// Backing up tens of GB takes minutes, so it runs as a background job and the
// client polls /status for progress (same pattern as archive extraction).
const backupJobs = new Map();

router.post('/create', (req, res) => {
  const jobId = crypto.randomBytes(8).toString('hex');
  const job = { status: 'running', phase: 'measuring', files: 0, bytesDone: 0, totalBytes: 0, archiveBytes: 0, name: '', error: '' };
  backupJobs.set(jobId, job);

  backups.create((req.body || {}).label || '', (p) => Object.assign(job, p))
    .then((b) => {
      Object.assign(job, { status: 'done', phase: 'done', name: b.name, archiveBytes: b.size });
      setTimeout(() => backupJobs.delete(jobId), 5 * 60 * 1000);
    })
    .catch((err) => {
      Object.assign(job, { status: 'error', error: err.message });
      setTimeout(() => backupJobs.delete(jobId), 5 * 60 * 1000);
    });

  res.json({ ok: true, jobId });
});

router.get('/status', (req, res) => {
  const job = backupJobs.get(String(req.query.id || ''));
  if (!job) return res.status(404).json({ error: 'Задача бэкапа не найдена (возможно, уже завершена).' });
  res.json(job);
});

router.post('/restore', (req, res) => {
  backups.restore((req.body || {}).name)
    .then((r) => res.json({ ok: true, restored: r }))
    .catch((err) => res.status(err.status || 500).json({ error: err.message }));
});

router.post('/delete', (req, res) => {
  backups.remove((req.body || {}).name)
    .then((r) => res.json({ ok: true, deleted: r }))
    .catch((err) => res.status(err.status || 500).json({ error: err.message }));
});

router.get('/download', (req, res) => {
  try {
    const p = backups.pathFor(req.query.name);
    res.download(p);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/settings', (req, res) => {
  const { maxKeep, exclude } = req.body || {};
  const patch = { backups: {} };
  if (maxKeep != null) patch.backups.maxKeep = Math.max(0, parseInt(maxKeep, 10) || 0);
  if (Array.isArray(exclude)) patch.backups.exclude = exclude.map((s) => String(s).trim()).filter(Boolean);
  config.update(patch);
  res.json({ ok: true, settings: config.get().backups });
});

module.exports = router;
