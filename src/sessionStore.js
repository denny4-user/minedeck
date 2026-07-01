'use strict';

const session = require('express-session');
const fs = require('fs');

// Lightweight file-backed session store (no extra deps) so logins survive a
// panel restart / self-update. Writes only on set/destroy; touch is in-memory.
class FileStore extends session.Store {
  constructor(file) {
    super();
    this.file = file;
    this.sessions = {};
    this.load();
    const timer = setInterval(() => this.cleanup(), 60 * 60 * 1000);
    if (timer.unref) timer.unref();
  }

  load() {
    try {
      this.sessions = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch (_) {
      this.sessions = {};
    }
  }

  persist() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.sessions));
    } catch (err) {
      console.error('[sessions] persist failed:', err.message);
    }
  }

  get(sid, cb) {
    const entry = this.sessions[sid];
    if (!entry) return cb(null, null);
    if (entry.expires && Date.now() > entry.expires) {
      delete this.sessions[sid];
      return cb(null, null);
    }
    cb(null, entry.data);
  }

  set(sid, sess, cb) {
    const maxAge = sess.cookie && sess.cookie.maxAge;
    this.sessions[sid] = {
      data: sess,
      expires: maxAge ? Date.now() + maxAge : null,
    };
    this.persist();
    if (cb) cb(null);
  }

  destroy(sid, cb) {
    delete this.sessions[sid];
    this.persist();
    if (cb) cb(null);
  }

  // Keep-alive on each request: update expiry in memory only (no disk write).
  touch(sid, sess, cb) {
    const entry = this.sessions[sid];
    if (entry) {
      const maxAge = sess.cookie && sess.cookie.maxAge;
      entry.expires = maxAge ? Date.now() + maxAge : null;
    }
    if (cb) cb(null);
  }

  cleanup() {
    const now = Date.now();
    let changed = false;
    for (const sid of Object.keys(this.sessions)) {
      const e = this.sessions[sid].expires;
      if (e && now > e) {
        delete this.sessions[sid];
        changed = true;
      }
    }
    if (changed) this.persist();
  }
}

module.exports = FileStore;
