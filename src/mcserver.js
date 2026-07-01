'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const config = require('./config');

const HISTORY_LIMIT = 400;

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

  buildCommand() {
    const s = config.get().server;
    if (s.customCommand && s.customCommand.trim()) {
      return { cmd: 'sh', args: ['-c', s.customCommand], custom: true };
    }
    const args = [];
    args.push(`-Xms${Math.max(128, parseInt(s.minRamMB, 10) || 1024)}M`);
    args.push(`-Xmx${Math.max(256, parseInt(s.maxRamMB, 10) || 2048)}M`);
    if (s.useAikarFlags) args.push(...config.AIKAR_FLAGS);
    if (s.jvmFlags && s.jvmFlags.trim()) {
      args.push(...s.jvmFlags.trim().split(/\s+/).filter(Boolean));
    }
    args.push('-jar', s.jar || 'server.jar', 'nogui');
    return { cmd: s.javaPath || 'java', args, custom: false };
  }

  describeCommand() {
    const { cmd, args, custom } = this.buildCommand();
    if (custom) return config.get().server.customCommand;
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
    this.pushLine(`[MineDeck] Сервер остановлен (code=${code}, signal=${signal || 'none'})`, 'sys');
    this.proc = null;
    this.startedAt = null;
    this.setState('stopped');

    if (this._pendingRestart) {
      this._pendingRestart = false;
      setTimeout(() => this._safeStart(), 1500);
      return;
    }
    const s = config.get().server;
    if (!wasIntentional && s.autoRestart) {
      this.pushLine('[MineDeck] Авто-перезапуск включён, перезапуск через 5с...', 'sys');
      setTimeout(() => this._safeStart(), 5000);
    }
    this._intentionalStop = false;
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
