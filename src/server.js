'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { WebSocketServer } = require('ws');

const config = require('./config');
config.load();

const mcserver = require('./mcserver');
const scheduler = require('./scheduler');
const system = require('./system');
const FileStore = require('./sessionStore');

const app = express();
const server = http.createServer(app);

app.disable('x-powered-by');
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: true, limit: '6mb' }));

const sessionParser = session({
  name: 'minedeck.sid',
  secret: config.get().panel.sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: new FileStore(require('path').join(config.DATA_DIR, 'sessions.json')),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
});
app.use(sessionParser);

// ---- Routes ----------------------------------------------------------------
app.use('/api/auth', require('./routes/auth'));
app.use('/api/server', require('./routes/server'));
app.use('/api/files', require('./routes/files'));
app.use('/api/backups', require('./routes/backups'));
app.use('/api/schedule', require('./routes/scheduler'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/firewall', require('./routes/firewall'));
app.use('/api/system', require('./routes/system'));
app.use('/api/update', require('./routes/update'));
app.use('/api/databases', require('./routes/databases'));

app.get('/api/health', (req, res) => res.json({ ok: true, version: require('../package.json').version }));

// ---- Static SPA ------------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Generic error handler.
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Внутренняя ошибка сервера.' });
});

// ---- WebSocket (console + live stats) --------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  sessionParser(req, {}, () => {
    if (!req.session || !req.session.authed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
});

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'history', lines: mcserver.getHistory() }));
  ws.send(JSON.stringify({ type: 'status', status: mcserver.status() }));

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    try {
      if (msg.type === 'command' && msg.command) {
        mcserver.writeCommand(String(msg.command).trim());
      } else if (msg.type === 'action') {
        if (msg.action === 'start') mcserver.start();
        else if (msg.action === 'stop') mcserver.stop();
        else if (msg.action === 'restart') mcserver.restart();
        else if (msg.action === 'kill') mcserver.kill();
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });
});

mcserver.on('output', (entry) => broadcast({ type: 'output', entry }));
mcserver.on('status', (status) => broadcast({ type: 'status', status }));

// Push resource stats to all connected clients every 2 seconds.
setInterval(() => {
  if (wss.clients.size === 0) return;
  broadcast({
    type: 'stats',
    system: system.systemInfo(),
    process: system.processStats(mcserver.pid),
    server: mcserver.status(),
  });
}, 2000);

// ---- Startup ---------------------------------------------------------------
scheduler.start();

if (config.get().server.autoStart) {
  setTimeout(() => {
    try {
      mcserver.start();
    } catch (err) {
      console.error('[autostart]', err.message);
      mcserver.pushLine(`[MineDeck] Автозапуск не удался: ${err.message}`, 'err');
    }
  }, 2000);
}

const { host, port } = config.get().panel;
server.listen(port, host, () => {
  console.log(`\n  MineDeck панель запущена → http://${host === '0.0.0.0' ? 'localhost' : host}:${port}\n`);
});

function shutdown() {
  console.log('\n[MineDeck] Завершение работы...');
  try { if (mcserver.state !== 'stopped') mcserver.stop(); } catch (_) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
