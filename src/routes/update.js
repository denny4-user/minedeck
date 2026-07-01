'use strict';

const express = require('express');
const updater = require('../updater');
const mcserver = require('../mcserver');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

router.get('/version', async (req, res) => {
  try {
    res.json(await updater.localVersion());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/check', async (req, res) => {
  try {
    res.json({ ok: true, ...(await updater.checkUpdate()) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/apply', (req, res) => {
  try {
    const result = updater.runUpdate();
    mcserver.pushLine('[MineDeck] Запущено обновление панели из репозитория — панель перезапустится.', 'sys');
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
