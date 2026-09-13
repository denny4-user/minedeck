'use strict';

// Panel-side management of the MCP endpoint (enable, read-only mode, token).

const express = require('express');
const config = require('../config');
const mcserver = require('../mcserver');
const mcp = require('../mcp');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json(mcp.status());
});

router.post('/config', (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.enabled != null) patch.enabled = !!b.enabled;
  if (b.readOnly != null) patch.readOnly = !!b.readOnly;
  if (Object.keys(patch).length) {
    config.update({ mcp: patch });
    const s = config.get().mcp;
    mcserver.pushLine(`[MineDeck] MCP ${s.enabled ? `включён${s.readOnly ? ' (только чтение)' : ''}` : 'выключен'}`, 'sys');
  }
  res.json({ ok: true, ...mcp.status() });
});

router.post('/token', (req, res) => {
  const token = mcp.generateToken();
  mcserver.pushLine('[MineDeck] MCP: выпущен новый токен, прежний больше не действует', 'sys');
  res.json({ ok: true, token, ...mcp.status() });
});

router.post('/token/revoke', (req, res) => {
  mcp.revokeToken();
  mcserver.pushLine('[MineDeck] MCP: токен отозван', 'sys');
  res.json({ ok: true, ...mcp.status() });
});

module.exports = router;
