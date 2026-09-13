'use strict';

const express = require('express');
const config = require('../config');
const properties = require('../properties');
const serverSettings = require('../serverSettings');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json(serverSettings.get());
});

router.post('/server', (req, res) => {
  res.json({ ok: true, ...serverSettings.update(req.body || {}) });
});

// Dry-run: compute the resulting launch command for hypothetical (unsaved)
// field values, without persisting anything. Used by the "reset preview to
// the auto-generated command" button in Settings.
router.post('/server/preview', (req, res) => {
  res.json(serverSettings.preview(req.body || {}));
});

router.post('/panel', (req, res) => {
  const b = req.body || {};
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
router.get('/properties', (req, res) => {
  try {
    res.json(properties.read());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/properties', (req, res) => {
  try {
    properties.write((req.body || {}).properties);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
