'use strict';

const { execFile } = require('child_process');

function run(args) {
  return new Promise((resolve, reject) => {
    execFile('ufw', args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        // ufw not installed
        if (err.code === 'ENOENT') {
          return reject(Object.assign(new Error('ufw не установлен на сервере.'), { status: 501 }));
        }
        return reject(new Error((stderr || stdout || err.message).trim()));
      }
      resolve(stdout);
    });
  });
}

function validatePort(port) {
  const p = parseInt(port, 10);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw Object.assign(new Error('Некорректный номер порта.'), { status: 400 });
  }
  return p;
}

function validateProto(proto) {
  if (proto && !['tcp', 'udp', 'both'].includes(proto)) {
    throw Object.assign(new Error('Некорректный протокол.'), { status: 400 });
  }
  return proto || 'both';
}

async function status() {
  try {
    const out = await run(['status', 'verbose']);
    const active = /Status:\s*active/i.test(out);
    return { installed: true, active, raw: out.trim(), rules: parseRules(out) };
  } catch (err) {
    if (err.status === 501) return { installed: false, active: false, raw: '', rules: [] };
    throw err;
  }
}

function parseRules(out) {
  const rules = [];
  const lines = out.split('\n');
  for (const line of lines) {
    // e.g. "25565/tcp                  ALLOW IN    Anywhere"
    const m = line.match(/^\s*(\d+(?::\d+)?(?:\/(?:tcp|udp))?)\s+(ALLOW|DENY|REJECT|LIMIT)\s+(IN|OUT)?\s*(.*)$/i);
    if (m) {
      rules.push({ to: m[1], action: m[2].toUpperCase(), direction: (m[3] || 'IN').toUpperCase(), from: (m[4] || 'Anywhere').trim() });
    }
  }
  return rules;
}

async function enable() {
  // --force avoids the interactive "may disrupt ssh" confirmation prompt.
  await run(['--force', 'enable']);
  return status();
}

async function disable() {
  await run(['disable']);
  return status();
}

async function allow(port, proto) {
  const p = validatePort(port);
  const pr = validateProto(proto);
  if (pr === 'both') {
    await run(['allow', String(p)]);
  } else {
    await run(['allow', `${p}/${pr}`]);
  }
  return status();
}

async function deny(port, proto) {
  const p = validatePort(port);
  const pr = validateProto(proto);
  if (pr === 'both') {
    await run(['deny', String(p)]);
  } else {
    await run(['deny', `${p}/${pr}`]);
  }
  return status();
}

async function delRule(port, proto, action) {
  const p = validatePort(port);
  const pr = validateProto(proto);
  const act = action === 'deny' ? 'deny' : 'allow';
  if (pr === 'both') {
    await run(['delete', act, String(p)]);
  } else {
    await run(['delete', act, `${p}/${pr}`]);
  }
  return status();
}

module.exports = { status, enable, disable, allow, deny, delRule };
