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

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// Accepts an IPv4/IPv6 address or a CIDR block. Everything else is rejected so
// nothing unexpected can reach the ufw command line.
function validateAddress(addr) {
  const src = String(addr).trim();
  const [ip, mask] = src.split('/');
  let bits;
  if (IPV4.test(ip)) {
    if (!ip.split('.').every((o) => Number(o) <= 255 && !/^0\d/.test(o))) {
      throw Object.assign(new Error(`Некорректный адрес: ${src}`), { status: 400 });
    }
    bits = 32;
  } else if (/^[0-9a-fA-F:]+$/.test(ip) && ip.includes(':') && !/:::/.test(ip)) {
    bits = 128;
  } else {
    throw Object.assign(new Error(`Некорректный адрес: ${src}`), { status: 400 });
  }
  if (mask !== undefined) {
    const m = parseInt(mask, 10);
    if (!/^\d+$/.test(mask) || !Number.isInteger(m) || m < 0 || m > bits) {
      throw Object.assign(new Error(`Некорректная маска подсети: ${src}`), { status: 400 });
    }
  }
  return src;
}

// The UI sends a free-form list of addresses (comma / space / newline
// separated). An empty value — or the literal "any"/"Anywhere" that ufw prints
// in its own status table — means "from anywhere".
function parseSources(from) {
  if (from === undefined || from === null) return ['any'];
  const list = (Array.isArray(from) ? from : String(from).split(/[\s,;]+/))
    .map((s) => String(s).trim())
    .filter(Boolean);
  if (!list.length) return ['any'];
  if (list.some((s) => /^(any|anywhere)$/i.test(s))) return ['any'];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const addr = validateAddress(item);
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

// "allow 25565/tcp" for anywhere, the long form when a source is given.
function ruleArgs(action, port, proto, src) {
  const spec = proto === 'both' ? String(port) : `${port}/${proto}`;
  if (src === 'any') return [action, spec];
  const args = [action, 'from', src, 'to', 'any', 'port', String(port)];
  if (proto !== 'both') args.push('proto', proto);
  return args;
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
    //      "25565/tcp                  ALLOW IN    203.0.113.5"
    const m = line.match(/^\s*(\d+(?::\d+)?(?:\/(?:tcp|udp))?)\s+(ALLOW|DENY|REJECT|LIMIT)\s+(IN|OUT)?\s*(.*)$/i);
    if (m) {
      const from = (m[4] || 'Anywhere').trim();
      rules.push({
        to: m[1],
        action: m[2].toUpperCase(),
        direction: (m[3] || 'IN').toUpperCase(),
        from,
        restricted: !/^anywhere/i.test(from),
      });
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

async function applyRule(action, port, proto, from) {
  const p = validatePort(port);
  const pr = validateProto(proto);
  for (const src of parseSources(from)) {
    await run(ruleArgs(action, p, pr, src));
  }
  return status();
}

async function allow(port, proto, from) {
  return applyRule('allow', port, proto, from);
}

async function deny(port, proto, from) {
  return applyRule('deny', port, proto, from);
}

async function delRule(port, proto, action, from) {
  const p = validatePort(port);
  const pr = validateProto(proto);
  const act = action === 'deny' ? 'deny' : 'allow';
  for (const src of parseSources(from)) {
    await run(['delete', ...ruleArgs(act, p, pr, src)]);
  }
  return status();
}

module.exports = { status, enable, disable, allow, deny, delRule, parseSources, validateAddress };
