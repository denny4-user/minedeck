'use strict';

const express = require('express');
const firewall = require('../firewall');
const { requireAuth } = require('../auth');

const router = express.Router();
router.use(requireAuth);

function wrap(promise, res) {
  promise.then((data) => res.json({ ok: true, ...data })).catch((err) => {
    res.status(err.status || 500).json({ error: err.message });
  });
}

router.get('/', (req, res) => wrap(firewall.status(), res));
router.post('/enable', (req, res) => wrap(firewall.enable(), res));
router.post('/disable', (req, res) => wrap(firewall.disable(), res));

router.post('/allow', (req, res) => {
  const { port, proto } = req.body || {};
  wrap(firewall.allow(port, proto), res);
});

router.post('/deny', (req, res) => {
  const { port, proto } = req.body || {};
  wrap(firewall.deny(port, proto), res);
});

router.post('/delete', (req, res) => {
  const { port, proto, action } = req.body || {};
  wrap(firewall.delRule(port, proto, action), res);
});

module.exports = router;
