'use strict';

// server.properties read/write, shared by the web API and MCP.

const fs = require('fs');
const path = require('path');
const config = require('./config');

const KEY_RE = /^[A-Za-z0-9._-]+$/;

function propsPath() {
  return path.join(config.get().server.directory, 'server.properties');
}

function parse(raw) {
  const properties = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    properties[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return properties;
}

function read() {
  const file = propsPath();
  if (!fs.existsSync(file)) return { exists: false, properties: {}, raw: '' };
  const raw = fs.readFileSync(file, 'utf8');
  return { exists: true, properties: parse(raw), raw };
}

// Update keys in place (comments and order are preserved); new keys are appended.
function write(updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw Object.assign(new Error('Нет данных для сохранения.'), { status: 400 });
  }
  for (const [key, val] of Object.entries(updates)) {
    if (!KEY_RE.test(key)) {
      throw Object.assign(new Error(`Недопустимый ключ: ${key}`), { status: 400 });
    }
    // A newline in a value would inject extra lines into the file.
    if (/[\r\n]/.test(String(val))) {
      throw Object.assign(new Error(`Значение «${key}» не должно содержать переводов строки.`), { status: 400 });
    }
  }
  const file = propsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
  const remaining = { ...updates };
  lines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = trimmed.indexOf('=');
    if (eq < 0) return line;
    const key = trimmed.slice(0, eq).trim();
    if (Object.prototype.hasOwnProperty.call(remaining, key)) {
      const val = remaining[key];
      delete remaining[key];
      return `${key}=${val}`;
    }
    return line;
  });
  for (const [key, val] of Object.entries(remaining)) {
    lines.push(`${key}=${val}`);
  }
  let out = lines.join('\n');
  if (!out.endsWith('\n')) out += '\n';
  fs.writeFileSync(file, out);
  return read();
}

module.exports = { propsPath, read, write };
