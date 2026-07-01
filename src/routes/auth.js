'use strict';

const express = require('express');
const auth = require('../auth');
const config = require('../config');

const router = express.Router();

router.get('/status', (req, res) => {
  res.json({
    configured: auth.isConfigured(),
    authed: !!(req.session && req.session.authed),
    username: req.session && req.session.username ? req.session.username : null,
  });
});

router.post('/setup', (req, res) => {
  try {
    const { username, password } = req.body || {};
    auth.setup(username, password);
    req.session.authed = true;
    req.session.username = username.trim();
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!auth.isConfigured()) {
    return res.status(400).json({ error: 'Панель ещё не настроена.' });
  }
  if (auth.verify(username, password)) {
    req.session.authed = true;
    req.session.username = username;
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Неверное имя пользователя или пароль.' });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.post('/password', auth.requireAuth, (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    auth.changePassword(currentPassword, newPassword);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

module.exports = router;
