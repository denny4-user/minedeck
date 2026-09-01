'use strict';

const { spawn, execFileSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const config = require('./config');

const HISTORY_LIMIT = 400;

// A process that dies faster than this counts as "failed to start"; after
// MAX_FAST_FAILS such deaths in a row we stop auto-restarting instead of
// respawning a broken server forever.
const FAST_FAIL_MS = 30000;
const MAX_FAST_FAILS = 3;

// Parse a JVM size argument ("1024M", "10G", "512k", bare bytes) into MB.
function parseJvmSizeMB(v) {
  const m = /^(\d+)([kmgt]?)$/i.exec(String(v).trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  switch ((m[2] || '').toLowerCase()) {
    case 'k': return n / 1024;
    case 'm': return n;
    case 'g': return n * 1024;
    case 't': return n * 1024 * 1024;
    default: return n / (1024 * 1024); // no suffix = bytes
  }
}

// Sanity-check a launch command and return human-readable warnings. Catches the
// common footguns of a hand-edited command (e.g. -Xms typed twice instead of
// -Xmx, which pins the heap and can get the server OOM-killed).
function commandWarnings(cmdStr) {
  const str = String(cmdStr || '');
  const out = [];
  if (!/(^|\s)-jar(\s|$)/.test(str) && !/\bjava\b/.test(str)) return out;

  const xms = str.match(/-Xms\S+/gi) || [];
  const xmx = str.match(/-Xmx\S+/gi) || [];
  if (xms.length > 1) {
    out.push('В команде дважды указан -Xms — похоже на опечатку вместо -Xmx. JVM возьмёт последнее значение и жёстко зафиксирует heap на нём (память не сможет освобождаться).');
  }
  if (xms.length && !xmx.length) {
    out.push('Не указан -Xmx (максимум heap). JVM подставит своё значение — сервер может занять неожиданно много памяти.');
  }
  const sizes = [...xms, ...xmx]
    .map((f) => parseJvmSizeMB(f.replace(/^-Xm[sx]/i, '')))
    .filter((n) => n != null && n > 0);
  if (sizes.length) {
    const heapMB = Math.max(...sizes);
    const totalMB = Math.round(os.totalmem() / (1024 * 1024));
    if (totalMB > 0 && heapMB >= totalMB * 0.8) {
      out.push(`Heap ~${(heapMB / 1024).toFixed(1)} ГБ занимает почти всю ОЗУ сервера (${(totalMB / 1024).toFixed(1)} ГБ) — процесс может быть убит системой (OOM killer). Оставьте 2–4 ГБ системе.`);
    }
  }
  return out;
}

// Is `taskset` (util-linux) available for CPU-affinity based core limiting?
const HAS_TASKSET = (() => {
  try {
    execFileSync('sh', ['-c', 'command -v taskset'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
})();

// Wrap a command so the process (and its children) are pinned to `cores` CPUs
// via taskset. Affinity is inherited by children, so it works for both the
// direct java launch and a custom shell command. cores<=0 means unlimited.
function cpuAffinityWrap(cmd, args, cores, totalCores, hasTaskset) {
  let n = parseInt(cores, 10) || 0;
  if (!hasTaskset || n <= 0) return { cmd, args };
  if (n > totalCores) n = totalCores;
  const range = n === 1 ? '0' : `0-${n - 1}`;
  return { cmd: 'taskset', args: ['-c', range, cmd, ...args] };
}

class MCServer extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.state = 'stopped'; // stopped | starting | running | stopping
    this.startedAt = null;
    this.history = [];
    this.stdoutBuf = '';
    this.stderrBuf = '';
    this._intentionalStop = false;
    this._pendingRestart = false;
    this._stopTimer = null;
    this._fastFails = 0;
  }

  get pid() {
    return this.proc && this.proc.pid ? this.proc.pid : null;
  }

  status() {
    return {
      state: this.state,
      pid: this.pid,
      startedAt: this.startedAt,
      command: this.describeCommand(),
      cpuCores: parseInt(config.get().server.cpuCores, 10) || 0,
      totalCores: os.cpus().length,
    };
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('status', this.status());
  }

  pushLine(line, stream) {
    const entry = { t: Date.now(), line, stream: stream || 'out' };
    this.history.push(entry);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.emit('output', entry);
  }

  getHistory() {
    return this.history;
  }

  buildCommand(s) {
    s = s || config.get().server;
    let cmd;
    let args;
    let custom;
    if (s.customCommand && s.customCommand.trim()) {
      cmd = 'sh';
      args = ['-c', s.customCommand];
      custom = true;
    } else {
      args = [];
      args.push(`-Xms${Math.max(128, parseInt(s.minRamMB, 10) || 1024)}M`);
      args.push(`-Xmx${Math.max(256, parseInt(s.maxRamMB, 10) || 2048)}M`);
      if (s.useAikarFlags) args.push(...config.AIKAR_FLAGS);
      if (s.jvmFlags && s.jvmFlags.trim()) {
        args.push(...s.jvmFlags.trim().split(/\s+/).filter(Boolean));
      }
      args.push('-jar', s.jar || 'server.jar', 'nogui');
      cmd = s.javaPath || 'java';
      custom = false;
    }
    // Limit the server to N CPU cores (allocate N vCPU) via taskset affinity.
    const wrapped = cpuAffinityWrap(cmd, args, s.cpuCores, os.cpus().length, HAS_TASKSET);
    return { cmd: wrapped.cmd, args: wrapped.args, custom };
  }

  describeCommand(s) {
    s = s || config.get().server;
    const { cmd, args, custom } = this.buildCommand(s);
    if (custom) {
      // When taskset-wrapped, args = ['-c', RANGE, 'sh', '-c', <customCommand>].
      if (cmd === 'taskset') return `taskset -c ${args[1]} ${s.customCommand}`;
      return s.customCommand;
    }
    return `${cmd} ${args.join(' ')}`;
  }

  eulaAccepted() {
    const dir = config.get().server.directory;
    try {
      const txt = fs.readFileSync(path.join(dir, 'eula.txt'), 'utf8');
      return /^\s*eula\s*=\s*true/im.test(txt);
    } catch (_) {
      return false;
    }
  }

  acceptEula() {
    const dir = config.get().server.directory;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'eula.txt'),
      `# Accepted via MineDeck on ${new Date().toISOString()}\neula=true\n`
    );
    return true;
  }

  start() {
    if (this.state !== 'stopped') {
      throw new Error('Сервер уже запущен или запускается.');
    }
    const s = config.get().server;
    if (!fs.existsSync(s.directory)) {
      throw new Error(`Директория сервера не найдена: ${s.directory}`);
    }
    if (!s.customCommand && !fs.existsSync(path.join(s.directory, s.jar || 'server.jar'))) {
      throw new Error(`JAR-файл не найден: ${path.join(s.directory, s.jar || 'server.jar')}. Загрузите его в файловом менеджере.`);
    }
    if (!this.eulaAccepted()) {
      throw new Error('EULA не принято. Примите EULA в настройках сервера, чтобы запустить сервер.');
    }

    const { cmd, args } = this.buildCommand();
    this._intentionalStop = false;
    this.setState('starting');
    this.pushLine(`[MineDeck] Запуск: ${this.describeCommand()}`, 'sys');

    try {
      this.proc = spawn(cmd, args, {
        cwd: s.directory,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.setState('stopped');
      this.pushLine(`[MineDeck] Ошибка запуска: ${err.message}`, 'err');
      throw err;
    }

    this.startedAt = Date.now();

    this.proc.stdout.on('data', (d) => this._onData(d, 'out'));
    this.proc.stderr.on('data', (d) => this._onData(d, 'err'));

    this.proc.on('error', (err) => {
      this.pushLine(`[MineDeck] Процесс-ошибка: ${err.message}`, 'err');
    });

    this.proc.on('exit', (code, signal) => this._onExit(code, signal));

    return this.status();
  }

  _onData(chunk, stream) {
    const bufKey = stream === 'err' ? 'stderrBuf' : 'stdoutBuf';
    this[bufKey] += chunk.toString('utf8');
    let idx;
    while ((idx = this[bufKey].indexOf('\n')) >= 0) {
      const line = this[bufKey].slice(0, idx).replace(/\r$/, '');
      this[bufKey] = this[bufKey].slice(idx + 1);
      this.pushLine(line, stream);
      if (this.state === 'starting' && /\bDone\b.*For help, type/i.test(line)) {
        this.setState('running');
      }
    }
  }

  _onExit(code, signal) {
    if (this._stopTimer) {
      clearTimeout(this._stopTimer);
      this._stopTimer = null;
    }
    const wasIntentional = this._intentionalStop;
    const uptimeMs = this.startedAt ? Date.now() - this.startedAt : 0;
    this.pushLine(`[MineDeck] Сервер остановлен (code=${code}, signal=${signal || 'none'})`, 'sys');
    this.proc = null;
    this.startedAt = null;
    this.setState('stopped');

    if (this._pendingRestart) {
      this._pendingRestart = false;
      this._fastFails = 0;
      setTimeout(() => this._safeStart(), 1500);
      return;
    }
    if (wasIntentional) {
      this._intentionalStop = false;
      this._fastFails = 0;
      return;
    }

    // Crashed on its own. Count rapid failures so a server that simply cannot
    // start (bad flags, not enough RAM, OOM-kill) isn't respawned forever.
    const crashedFast = uptimeMs < FAST_FAIL_MS;
    this._fastFails = crashedFast ? this._fastFails + 1 : 0;
    const reason = signal === 'SIGKILL'
      ? 'процесс был убит (SIGKILL) — чаще всего это нехватка памяти (OOM killer). Проверьте -Xmx: heap не должен занимать почти всю ОЗУ.'
      : `код выхода ${code}${signal ? `, сигнал ${signal}` : ''}.`;

    if (crashedFast && this._fastFails >= MAX_FAST_FAILS) {
      const msg = `Сервер падает сразу после запуска ${this._fastFails} раза подряд — авто-перезапуск остановлен. ${reason}`;
      this.pushLine(`[MineDeck] ${msg}`, 'err');
      this.emit('crash', msg);
      this._fastFails = 0;
      return;
    }
    if (crashedFast) {
      const msg = `Сервер завершился через ${Math.round(uptimeMs / 1000)}с после запуска: ${reason}`;
      this.pushLine(`[MineDeck] ${msg}`, 'err');
      this.emit('crash', msg);
    }

    if (config.get().server.autoRestart) {
      this.pushLine('[MineDeck] Авто-перезапуск включён, перезапуск через 5с...', 'sys');
      setTimeout(() => this._safeStart(), 5000);
    }
  }

  _safeStart() {
    try {
      this.start();
    } catch (err) {
      this.pushLine(`[MineDeck] Не удалось перезапустить: ${err.message}`, 'err');
    }
  }

  writeCommand(command) {
    if (this.state !== 'running' && this.state !== 'starting') {
      throw new Error('Сервер не запущен.');
    }
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error('Поток ввода недоступен.');
    }
    this.pushLine(`> ${command}`, 'in');
    this.proc.stdin.write(command.replace(/\n?$/, '\n'));
    return true;
  }

  stop() {
    if (this.state === 'stopped') return this.status();
    if (!this.proc) return this.status();
    const s = config.get().server;
    this._intentionalStop = true;
    this.setState('stopping');
    this.pushLine('[MineDeck] Остановка сервера...', 'sys');
    try {
      this.proc.stdin.write(`${s.stopCommand || 'stop'}\n`);
    } catch (_) {
      /* fall through to kill timer */
    }
    const timeout = (parseInt(s.stopTimeoutSec, 10) || 45) * 1000;
    this._stopTimer = setTimeout(() => {
      if (this.proc) {
        this.pushLine('[MineDeck] Таймаут остановки — принудительное завершение (SIGKILL).', 'err');
        try { this.proc.kill('SIGKILL'); } catch (_) {}
      }
    }, timeout);
    return this.status();
  }

  restart() {
    if (this.state === 'stopped') {
      return this.start();
    }
    this._pendingRestart = true;
    return this.stop();
  }

  kill() {
    if (!this.proc) return this.status();
    this._intentionalStop = true;
    this.pushLine('[MineDeck] Принудительное завершение (SIGKILL).', 'err');
    try { this.proc.kill('SIGKILL'); } catch (_) {}
    return this.status();
  }
}

module.exports = new MCServer();
module.exports.cpuAffinityWrap = cpuAffinityWrap;
module.exports.HAS_TASKSET = HAS_TASKSET;
module.exports.commandWarnings = commandWarnings;
module.exports.parseJvmSizeMB = parseJvmSizeMB;
