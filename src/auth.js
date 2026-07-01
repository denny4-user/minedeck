'use strict';

const bcrypt = require('bcryptjs');
const config = require('./config');

function isConfigured() {
  const a = config.get().auth;
  return !!(a && a.username && a.passwordHash);
}

function setup(username, password) {
  if (isConfigured()) throw Object.assign(new Error('Аккаунт уже настроен.'), { status: 409 });
  validateCredentials(username, password);
  const passwordHash = bcrypt.hashSync(password, 10);
  config.update({ auth: { username: username.trim(), passwordHash } });
  return true;
}

function validateCredentials(username, password) {
  if (!username || username.trim().length < 3) {
    throw Object.assign(new Error('Имя пользователя должно быть не короче 3 символов.'), { status: 400 });
  }
  if (!password || password.length < 6) {
    throw Object.assign(new Error('Пароль должен быть не короче 6 символов.'), { status: 400 });
  }
}

function verify(username, password) {
  const a = config.get().auth;
  if (!a || !a.username || !a.passwordHash) return false;
  if (username !== a.username) return false;
  return bcrypt.compareSync(password, a.passwordHash);
}

function changePassword(currentPassword, newPassword) {
  const a = config.get().auth;
  if (!bcrypt.compareSync(currentPassword, a.passwordHash)) {
    throw Object.assign(new Error('Текущий пароль неверен.'), { status: 403 });
  }
  if (!newPassword || newPassword.length < 6) {
    throw Object.assign(new Error('Новый пароль должен быть не короче 6 символов.'), { status: 400 });
  }
  config.update({ auth: { username: a.username, passwordHash: bcrypt.hashSync(newPassword, 10) } });
  return true;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.status(401).json({ error: 'Требуется авторизация.' });
}

module.exports = { isConfigured, setup, verify, changePassword, requireAuth };
