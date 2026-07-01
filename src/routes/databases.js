'use strict';

const express = require('express');
const databases = require('../databases');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try { res.json(await databases.status()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/config', async (req, res) => {
  try {
    databases.saveConfig(req.body || {});
    let connection;
    try { connection = await databases.testConnection(); }
    catch (err) { connection = { ok: false, error: err.message }; }
    res.json({ ok: true, connection });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/test', async (req, res) => {
  try { res.json({ ok: true, ...(await databases.testConnection()) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/create', async (req, res) => {
  try { res.json({ ok: true, database: await databases.create((req.body || {}).name) }); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/delete', async (req, res) => {
  try { res.json({ ok: true, ...(await databases.remove((req.body || {}).name)) }); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.get('/info', async (req, res) => {
  try { res.json(await databases.info(req.query.name)); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/query', async (req, res) => {
  try {
    const { name, sql } = req.body || {};
    res.json({ ok: true, result: await databases.query(name, sql) });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

module.exports = router;
