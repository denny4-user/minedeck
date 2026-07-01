'use strict';

const express = require('express');
const scheduler = require('../scheduler');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json({ tasks: scheduler.listWithMeta(), actions: scheduler.ACTIONS, types: scheduler.TYPES });
});

router.post('/', (req, res) => {
  try {
    const task = scheduler.add(req.body || {});
    res.json({ ok: true, task });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const task = scheduler.updateTask(req.params.id, req.body || {});
    res.json({ ok: true, task });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const removed = scheduler.remove(req.params.id);
    res.json({ ok: true, removed });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
