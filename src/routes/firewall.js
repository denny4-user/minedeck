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

// Address the panel is being opened from — used by the "Мой IP" button so the
// user does not have to look it up. IPv4-mapped IPv6 (::ffff:1.2.3.4) is
// unwrapped because ufw wants the plain form.
router.get('/client-ip', (req, res) => {
  const raw = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  let ip = null;
  try { ip = firewall.validateAddress(raw); } catch (_) { ip = null; }
  res.json({ ok: true, ip });
});

router.post('/allow', (req, res) => {
  const { port, proto, from } = req.body || {};
  wrap(firewall.allow(port, proto, from), res);
});

router.post('/deny', (req, res) => {
  const { port, proto, from } = req.body || {};
  wrap(firewall.deny(port, proto, from), res);
});

router.post('/delete', (req, res) => {
  const { port, proto, action, from } = req.body || {};
  wrap(firewall.delRule(port, proto, action, from), res);
});

module.exports = router;
