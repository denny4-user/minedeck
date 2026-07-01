'use strict';

const crypto = require('crypto');
const mysql = require('mysql2/promise');
const config = require('./config');

const SYSTEM_SCHEMAS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);
const NAME_RE = /^[a-zA-Z0-9_]{1,32}$/;

function mysqlCfg() {
  return config.get().databases.mysql;
}

function validName(name) {
  if (!NAME_RE.test(String(name || ''))) {
    throw Object.assign(new Error('Имя может содержать только латиницу, цифры и _ (до 32 символов).'), { status: 400 });
  }
  return name;
}

function connOptions(extra = {}) {
  const c = mysqlCfg();
  const opts = {
    user: c.adminUser || 'root',
    password: c.adminPassword || '',
    connectTimeout: 8000,
    ...extra,
  };
  if (c.socketPath) opts.socketPath = c.socketPath;
  else { opts.host = c.host || '127.0.0.1'; opts.port = parseInt(c.port, 10) || 3306; }
  return opts;
}

async function withConn(fn, extra) {
  const conn = await mysql.createConnection(connOptions(extra));
  try { return await fn(conn); }
  finally { try { await conn.end(); } catch (_) {} }
}

async function testConnection() {
  return withConn(async (conn) => {
    const [rows] = await conn.query('SELECT VERSION() AS version');
    return { ok: true, version: rows[0].version };
  });
}

// Public status used by the UI: connection health + database list.
async function status() {
  const c = mysqlCfg();
  const info = {
    mysql: { host: c.host, port: c.port, adminUser: c.adminUser, socketPath: c.socketPath, grantHost: c.grantHost, hasPassword: !!c.adminPassword },
    connection: { ok: false },
    databases: [],
  };
  try {
    const ver = await testConnection();
    info.connection = ver;
    info.databases = await list();
  } catch (err) {
    info.connection = { ok: false, error: err.message };
  }
  return info;
}

async function list() {
  return withConn(async (conn) => {
    const [sizes] = await conn.query(
      `SELECT table_schema AS name,
              ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS sizeMB,
              COUNT(*) AS tables
       FROM information_schema.tables GROUP BY table_schema`
    );
    const [all] = await conn.query('SHOW DATABASES');
    const sizeMap = new Map(sizes.map((r) => [r.name, r]));
    const created = config.get().databases.created;
    const out = [];
    for (const row of all) {
      const name = row.Database || row.database || Object.values(row)[0];
      if (SYSTEM_SCHEMAS.has(name)) continue;
      const s = sizeMap.get(name) || {};
      const meta = created.find((x) => x.name === name);
      out.push({
        name,
        sizeMB: s.sizeMB != null ? Number(s.sizeMB) : 0,
        tables: s.tables != null ? Number(s.tables) : 0,
        managed: !!meta,
        user: meta ? meta.user : null,
        password: meta ? meta.password : null,
        host: meta ? meta.connHost : (mysqlCfg().host || '127.0.0.1'),
        port: meta ? meta.port : (mysqlCfg().port || 3306),
        createdAt: meta ? meta.createdAt : null,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  });
}

function genPassword() {
  return crypto.randomBytes(18).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
}

async function create(name) {
  validName(name);
  const c = mysqlCfg();
  const grantHost = c.grantHost || '%';
  const user = ('md_' + name).slice(0, 32);
  const password = genPassword();
  const connHost = c.host && c.host !== '127.0.0.1' && c.host !== 'localhost' ? c.host : '127.0.0.1';

  await withConn(async (conn) => {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
    await conn.query(`CREATE USER IF NOT EXISTS ${conn.escape(user)}@${conn.escape(grantHost)} IDENTIFIED BY ${conn.escape(password)}`);
    // Ensure the password is set even if the user already existed.
    await conn.query(`ALTER USER ${conn.escape(user)}@${conn.escape(grantHost)} IDENTIFIED BY ${conn.escape(password)}`);
    await conn.query(`GRANT ALL PRIVILEGES ON \`${name}\`.* TO ${conn.escape(user)}@${conn.escape(grantHost)}`);
    await conn.query('FLUSH PRIVILEGES');
  });

  const record = { name, user, password, grantHost, connHost, port: parseInt(c.port, 10) || 3306, createdAt: Date.now() };
  const created = config.get().databases.created;
  const idx = created.findIndex((x) => x.name === name);
  if (idx >= 0) created[idx] = record; else created.push(record);
  config.save();
  return record;
}

async function remove(name) {
  validName(name);
  const created = config.get().databases.created;
  const meta = created.find((x) => x.name === name);
  await withConn(async (conn) => {
    await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
    if (meta && meta.user) {
      await conn.query(`DROP USER IF EXISTS ${conn.escape(meta.user)}@${conn.escape(meta.grantHost || '%')}`);
    }
    await conn.query('FLUSH PRIVILEGES');
  });
  const idx = created.findIndex((x) => x.name === name);
  if (idx >= 0) { created.splice(idx, 1); config.save(); }
  return { name };
}

// Run arbitrary SQL against a specific database (the "enter DB" console).
async function query(name, sql) {
  validName(name);
  if (!sql || !String(sql).trim()) throw Object.assign(new Error('Пустой SQL-запрос.'), { status: 400 });
  return withConn(async (conn) => {
    const [result, fields] = await conn.query(sql);
    if (Array.isArray(result)) {
      const columns = (fields || []).map((f) => f.name);
      const rows = result.slice(0, 500).map((r) => columns.map((col) => {
        const v = r[col];
        if (v === null || v === undefined) return null;
        if (Buffer.isBuffer(v)) return v.toString('utf8');
        if (typeof v === 'object') return JSON.stringify(v);
        return v;
      }));
      return { type: 'rows', columns, rows, total: result.length, truncated: result.length > 500 };
    }
    return { type: 'ok', affectedRows: result.affectedRows, info: result.info || '' };
  }, { database: name, multipleStatements: true });
}

async function info(name) {
  validName(name);
  return withConn(async (conn) => {
    const [tables] = await conn.query(
      `SELECT table_name AS name, table_rows AS rows,
              ROUND((data_length + index_length) / 1024 / 1024, 3) AS sizeMB
       FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
      [name]
    );
    return { name, tables: tables.map((t) => ({ name: t.name, rows: Number(t.rows) || 0, sizeMB: Number(t.sizeMB) || 0 })) };
  });
}

function saveConfig(patch) {
  const cur = mysqlCfg();
  const next = {
    host: typeof patch.host === 'string' && patch.host.trim() ? patch.host.trim() : cur.host,
    port: patch.port != null ? (parseInt(patch.port, 10) || cur.port) : cur.port,
    adminUser: typeof patch.adminUser === 'string' && patch.adminUser.trim() ? patch.adminUser.trim() : cur.adminUser,
    adminPassword: patch.adminPassword != null ? String(patch.adminPassword) : cur.adminPassword,
    socketPath: patch.socketPath != null ? String(patch.socketPath).trim() : cur.socketPath,
    grantHost: typeof patch.grantHost === 'string' && patch.grantHost.trim() ? patch.grantHost.trim() : cur.grantHost,
  };
  config.update({ databases: { mysql: next } });
  return next;
}

module.exports = { status, list, create, remove, query, info, testConnection, saveConfig };
