'use strict';

const express = require('express');
const mcserver = require('../mcserver');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

router.get('/status', (req, res) => {
  res.json({ ...mcserver.status(), eula: mcserver.eulaAccepted() });
});

router.get('/history', (req, res) => {
  res.json({ history: mcserver.getHistory() });
});

function action(fn) {
  return (req, res) => {
    try {
      const result = fn();
      res.json({ ok: true, status: result });
    } catch (err) {
      res.status(err.status || 400).json({ error: err.message });
    }
  };
}

router.post('/start', action(() => mcserver.start()));
router.post('/stop', action(() => mcserver.stop()));
router.post('/restart', action(() => mcserver.restart()));
router.post('/kill', action(() => mcserver.kill()));

router.post('/command', (req, res) => {
  try {
    const { command } = req.body || {};
    if (!command || !String(command).trim()) {
      return res.status(400).json({ error: 'Пустая команда.' });
    }
    mcserver.writeCommand(String(command).trim());
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.post('/eula', (req, res) => {
  try {
    mcserver.acceptEula();
    res.json({ ok: true, eula: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
