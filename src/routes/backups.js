'use strict';

const express = require('express');
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
router.post('/create', (req, res) => {
  const { jobId } = backups.startCreateJob((req.body || {}).label || '');
  res.json({ ok: true, jobId });
});

router.get('/status', (req, res) => {
  const job = backups.jobStatus(req.query.id);
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
