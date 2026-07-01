'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');
const config = require('./config');

const ROOT = config.ROOT; // install dir, e.g. /opt/minedeck
const BRANCH = process.env.MINEDECK_BRANCH || 'main';
const SERVICE = process.env.MINEDECK_SERVICE || 'minedeck';

function isGit() {
  return fs.existsSync(path.join(ROOT, '.git'));
}

function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', ROOT, ...args], { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout.trim());
    });
  });
}

function hasCmd(cmd) {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

async function localVersion() {
  const pkg = require('../package.json');
  if (!isGit()) {
    return { isGit: false, version: pkg.version, service: SERVICE };
  }
  try {
    const [sha, date, subject, branch] = await Promise.all([
      git(['rev-parse', '--short', 'HEAD']),
      git(['log', '-1', '--format=%cI']),
      git(['log', '-1', '--format=%s']),
      git(['rev-parse', '--abbrev-ref', 'HEAD']),
    ]);
    return { isGit: true, version: pkg.version, sha, date, subject, branch, service: SERVICE };
  } catch (err) {
    return { isGit: true, version: pkg.version, error: err.message, service: SERVICE };
  }
}

async function checkUpdate() {
  if (!isGit()) {
    return { isGit: false, upToDate: true, behind: 0 };
  }
  await git(['fetch', '--depth', '1', 'origin', BRANCH]);
  const behind = parseInt(await git(['rev-list', '--count', `HEAD..origin/${BRANCH}`]), 10) || 0;
  let latest = null;
  try { latest = await git(['log', '-1', '--format=%h %s', `origin/${BRANCH}`]); } catch (_) {}
  return { isGit: true, behind, upToDate: behind === 0, latest, branch: BRANCH };
}

// Launch the update in a detached process that survives the service restart.
function runUpdate() {
  if (!isGit()) {
    throw Object.assign(
      new Error('Панель установлена не через git — авто-обновление недоступно. Переустановите установщиком (install.sh).'),
      { status: 400 }
    );
  }

  const script = [
    'set -e',
    `cd '${ROOT}'`,
    `git fetch --depth 1 origin ${BRANCH}`,
    `git reset --hard origin/${BRANCH}`,
    'npm install --omit=dev --no-audit --no-fund',
    `if command -v systemctl >/dev/null 2>&1; then systemctl restart ${SERVICE}; fi`,
  ].join('\n');

  let child;
  // Prefer systemd-run --scope so the updater runs in its own cgroup and is not
  // killed when the service (our own process) is restarted.
  if (hasCmd('systemd-run')) {
    child = spawn(
      'systemd-run',
      ['--scope', '--collect', `--unit=${SERVICE}-update-${Date.now()}`, 'bash', '-c', script],
      { detached: true, stdio: 'ignore' }
    );
  } else {
    child = spawn('bash', ['-c', script], { detached: true, stdio: 'ignore' });
  }
  child.unref();
  return { started: true };
}

module.exports = { isGit, localVersion, checkUpdate, runUpdate, ROOT, BRANCH, SERVICE };
