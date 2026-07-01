'use strict';

/* ======================= Helpers ======================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' Б';
  const u = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + u[i];
}
function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400); sec -= d * 86400;
  const h = Math.floor(sec / 3600); sec -= h * 3600;
  const m = Math.floor(sec / 60); sec -= m * 60;
  const parts = [];
  if (d) parts.push(d + 'д');
  if (h || d) parts.push(h + 'ч');
  parts.push(m + 'м');
  if (!d && !h) parts.push(sec + 'с');
  return parts.join(' ');
}
function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Fill static [data-icon] placeholders (sidebar, topbar) with inline SVGs.
function hydrateIcons(root = document) {
  $$('[data-icon]', root).forEach((el) => { if (!el.firstChild) el.innerHTML = icon(el.dataset.icon); });
}

/* ---- Shared markup builders (daisyUI) ---- */
const CARD = 'card bg-base-100 border border-base-300 shadow-sm';
const INPUT = 'input input-bordered w-full';
const SELECT = 'select select-bordered w-full';

function pageHead(title, sub, actions) {
  return `<div class="flex items-end justify-between gap-3 flex-wrap mb-5">
    <div><h1 class="text-xl font-extrabold tracking-tight">${esc(title)}</h1>
    <p class="text-sm text-base-content/50 mt-0.5">${esc(sub)}</p></div>
    ${actions || ''}
  </div>`;
}
function field(label, control, hint) {
  return `<label class="form-control w-full">
    <div class="label py-1"><span class="label-text font-medium">${label}</span></div>
    ${control}
    ${hint ? `<div class="label py-0.5"><span class="label-text-alt text-base-content/45 leading-snug">${hint}</span></div>` : ''}
  </label>`;
}
function settingRow(label, sub, control) {
  return `<div class="flex items-center justify-between gap-4 py-3 border-b border-base-300/50 last:border-0">
    <div class="min-w-0">
      <div class="font-medium text-sm">${label}</div>
      ${sub ? `<div class="text-xs text-base-content/40 font-mono truncate">${sub}</div>` : ''}
    </div>
    <div class="shrink-0 flex justify-end">${control}</div>
  </div>`;
}
function empty(text) {
  return `<div class="text-center text-base-content/40 py-10 text-sm">${text}</div>`;
}
function sectionTitle(t, right) {
  return `<div class="flex items-center justify-between gap-3 mb-4"><h3 class="font-bold">${t}</h3>${right || ''}</div>`;
}

function toast(msg, type = 'info') {
  const cls = type === 'error' ? 'alert-error' : type === 'success' ? 'alert-success' : 'alert-info';
  const t = document.createElement('div');
  t.className = `alert ${cls} shadow-lg py-2.5 px-4 text-sm w-auto max-w-sm`;
  t.style.animation = 'md-slidein .2s ease';
  t.innerHTML = `<span>${esc(msg)}</span>`;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; }, 3200);
  setTimeout(() => t.remove(), 3600);
}
function toastErr(err) { toast(err && err.message ? err.message : String(err), 'error'); }

function openModal({ title, body, footer, wide }) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal modal-open" id="md-overlay">
      <div class="modal-box border border-base-300 ${wide ? 'max-w-3xl' : 'max-w-lg'}">
        <div class="flex items-center justify-between mb-4">
          <h3 class="font-bold text-lg">${esc(title)}</h3>
          <button class="btn btn-sm btn-circle btn-ghost" data-close>✕</button>
        </div>
        <div>${body}</div>
        ${footer ? `<div class="modal-action mt-5">${footer}</div>` : ''}
      </div>
    </div>`;
  const overlay = $('#md-overlay', root);
  const close = () => { root.innerHTML = ''; };
  $('[data-close]', root).onclick = close;
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  return { root, close };
}

function confirmDialog(message, { danger, okText } = {}) {
  return new Promise((resolve) => {
    const m = openModal({
      title: 'Подтверждение',
      body: `<p class="leading-relaxed">${esc(message)}</p>`,
      footer: `<button class="btn btn-ghost" data-c>Отмена</button>
               <button class="btn ${danger ? 'btn-error' : 'btn-primary'}" data-ok>${esc(okText || 'OK')}</button>`,
    });
    $('[data-ok]', m.root).onclick = () => { m.close(); resolve(true); };
    $('[data-c]', m.root).onclick = () => { m.close(); resolve(false); };
  });
}

/* ======================= State ======================= */
const State = {
  authed: false,
  username: null,
  status: { state: 'stopped', pid: null, startedAt: null },
  stats: null,
  ws: null,
  view: 'dashboard',
  cmdHistory: [],
  players: new Set(),
};
try { State.cmdHistory = JSON.parse(localStorage.getItem('minedeck_cmdhist') || '[]'); } catch (_) {}

/* ======================= Auth ======================= */
async function boot() {
  hydrateIcons();
  try {
    const s = await API.authStatus();
    State.username = s.username;
    if (!s.configured) return showAuth('setup');
    if (!s.authed) return showAuth('login');
    enterApp();
  } catch (err) {
    showAuth('login');
  }
}

function showAuth(mode) {
  $('#app-shell').classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
  $('#login-form').classList.toggle('hidden', mode !== 'login');
  $('#setup-form').classList.toggle('hidden', mode !== 'setup');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#login-error').textContent = '';
  try {
    await API.login(f.username.value, f.password.value);
    State.username = f.username.value;
    enterApp();
  } catch (err) { $('#login-error').textContent = err.message; }
});

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  $('#setup-error').textContent = '';
  if (f.password.value !== f.password2.value) { $('#setup-error').textContent = 'Пароли не совпадают.'; return; }
  try {
    await API.setup(f.username.value, f.password.value);
    State.username = f.username.value;
    enterApp();
  } catch (err) { $('#setup-error').textContent = err.message; }
});

$('#logout-btn').addEventListener('click', async () => {
  try { await API.logout(); } catch (_) {}
  if (State.ws) { try { State.ws.close(); } catch (_) {} }
  location.hash = '';
  location.reload();
});

function enterApp() {
  State.authed = true;
  $('#auth-screen').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
  // Prevent the browser from opening files dropped outside the dropzone.
  ['dragover', 'drop'].forEach((ev) =>
    window.addEventListener(ev, (e) => { e.preventDefault(); }, false)
  );
  // Mobile sidebar
  const sb = $('#sidebar'), bd = $('#sidebar-backdrop');
  const closeSb = () => { sb.classList.remove('open'); bd.classList.add('hidden'); };
  $('#sidebar-toggle').onclick = () => { sb.classList.toggle('open'); bd.classList.toggle('hidden'); };
  bd.onclick = closeSb;
  $$('.nav-item').forEach((a) => a.addEventListener('click', closeSb));

  connectWS();
  bindTopbar();
  window.addEventListener('hashchange', router);
  router();
}

/* ======================= WebSocket ======================= */
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  State.ws = ws;
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.type === 'history') { State.history = msg.lines; renderConsoleHistory(msg.lines); }
    else if (msg.type === 'output') { appendConsole(msg.entry); }
    else if (msg.type === 'status') { updateStatus(msg.status); }
    else if (msg.type === 'stats') { updateStats(msg); }
    else if (msg.type === 'error') { toast(msg.message, 'error'); }
  };
  ws.onclose = () => {
    if (!State.authed) return;
    setTimeout(connectWS, 2500);
  };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}

function wsSend(obj) {
  if (State.ws && State.ws.readyState === 1) State.ws.send(JSON.stringify(obj));
}

/* ======================= Status / Stats ======================= */
const STATE_LABEL = { stopped: 'Остановлен', starting: 'Запуск…', running: 'Работает', stopping: 'Остановка…' };

function updateStatus(status) {
  State.status = status;
  const dot = $('#status-dot');
  if (dot) dot.className = 'status-dot ' + status.state;
  const txt = $('#status-text');
  if (txt) txt.textContent = STATE_LABEL[status.state] || status.state;

  const running = status.state === 'running' || status.state === 'starting';
  const setDis = (id, dis) => { const el = $('#' + id); if (el) el.disabled = dis; };
  setDis('btn-start', status.state !== 'stopped');
  setDis('btn-stop', status.state === 'stopped');
  setDis('btn-restart', status.state === 'stopped');
  setDis('btn-kill', status.state === 'stopped');

  const up = $('#uptime-text');
  if (up) up.textContent = (running && status.startedAt) ? 'аптайм ' + fmtDuration((Date.now() - status.startedAt) / 1000) : '';

  if (State.view === 'dashboard') updateDashStatusCard();
}

function updateStats(msg) {
  State.stats = msg;
  updateStatus(msg.server);
  const sys = msg.system;
  const mini = $('#sys-mini');
  if (sys && mini) {
    mini.innerHTML =
      `<span class="text-base-content/60 font-semibold">CPU</span> ${sys.cpuPercent}% &nbsp; ` +
      `<span class="text-base-content/60 font-semibold">RAM</span> ${sys.memPercent}%<br>` +
      `<span class="text-base-content/60 font-semibold">Хост</span> ${esc(sys.hostname)}`;
  }
  if (State.view === 'dashboard') updateDashStats(msg);
}

/* ======================= Console ======================= */
// Standard vanilla/Fabric 1.20.1 dedicated-server commands (for TAB completion
// of the first token). Fixed list — Fabric 1.20.1 adds no player-facing commands.
const MC_COMMANDS = ['advancement', 'attribute', 'ban', 'ban-ip', 'banlist', 'bossbar', 'clear', 'clone',
  'damage', 'data', 'datapack', 'debug', 'defaultgamemode', 'deop', 'difficulty', 'effect', 'enchant',
  'execute', 'experience', 'fill', 'fillbiome', 'forceload', 'function', 'gamemode', 'gamerule', 'give',
  'help', 'item', 'jfr', 'kick', 'kill', 'list', 'locate', 'loot', 'me', 'msg', 'op', 'pardon', 'pardon-ip',
  'particle', 'place', 'playsound', 'recipe', 'reload', 'ride', 'save-all', 'save-off', 'save-on', 'say',
  'schedule', 'scoreboard', 'seed', 'setblock', 'setidletimeout', 'setworldspawn', 'spawnpoint', 'spectate',
  'spreadplayers', 'stop', 'stopsound', 'summon', 'tag', 'team', 'teammsg', 'teleport', 'tell', 'tellraw',
  'time', 'title', 'tm', 'tp', 'trigger', 'w', 'weather', 'whitelist', 'worldborder', 'xp'];
// Sub-argument suggestions per command (falls back to online player names).
const ARG_COMPLETIONS = {
  gamemode: ['survival', 'creative', 'adventure', 'spectator'],
  defaultgamemode: ['survival', 'creative', 'adventure', 'spectator'],
  difficulty: ['peaceful', 'easy', 'normal', 'hard'],
  weather: ['clear', 'rain', 'thunder'],
  time: ['set', 'add', 'query'],
  whitelist: ['add', 'remove', 'list', 'on', 'off', 'reload'],
  datapack: ['list', 'enable', 'disable'],
  gamerule: ['keepInventory', 'doDaylightCycle', 'doMobSpawning', 'mobGriefing', 'doFireTick',
    'randomTickSpeed', 'doWeatherCycle', 'commandBlockOutput', 'doInsomnia', 'fallDamage',
    'naturalRegeneration', 'showDeathMessages', 'spawnRadius', 'doImmediateRespawn'],
};

function collectPlayers(line) {
  let m;
  if ((m = line.match(/:\s*([A-Za-z0-9_]{1,16})\s+(?:joined|left) the game/))) State.players.add(m[1]);
  else if ((m = line.match(/<([A-Za-z0-9_]{1,16})>/))) State.players.add(m[1]);
  else if ((m = line.match(/:\s*([A-Za-z0-9_]{1,16})\[\//))) State.players.add(m[1]);
  const list = line.match(/players online:\s*(.+)$/i);
  if (list) list[1].split(',').map((s) => s.trim()).forEach((n) => { if (/^[A-Za-z0-9_]{1,16}$/.test(n)) State.players.add(n); });
}

function lineClass(stream) {
  return stream === 'err' ? 'err' : stream === 'sys' ? 'sys' : stream === 'in' ? 'in' : stream === 'warn' ? 'warn' : '';
}
function renderConsoleHistory(lines) {
  const box = $('#console');
  (lines || []).forEach((e) => collectPlayers(e.line));
  if (!box) return;
  box.innerHTML = (lines || []).map((e) => `<span class="ln ${lineClass(e.stream)}">${esc(e.line)}</span>`).join('');
  box.scrollTop = box.scrollHeight;
}
function appendConsole(entry) {
  if (!State.history) State.history = [];
  State.history.push(entry);
  if (State.history.length > 400) State.history.shift();
  collectPlayers(entry.line);
  const box = $('#console');
  if (!box) return;
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const span = document.createElement('span');
  span.className = 'ln ' + lineClass(entry.stream);
  span.textContent = entry.line;
  box.appendChild(span);
  while (box.childElementCount > 400) box.removeChild(box.firstChild);
  if (near) box.scrollTop = box.scrollHeight;
}

// Command-line UX for the console input: history (↑/↓), TAB completion (commands
// + online player names + sub-args) with a small suggestion popup shown on TAB.
function setupConsoleInput(input, sendFn) {
  const suggest = $('#cmd-suggest');
  let histIdx = -1;
  let draft = '';
  let cyc = null; // active TAB cycle: { before, after, cands, idx }

  const hideSuggest = () => { cyc = null; suggest.classList.add('hidden'); suggest.innerHTML = ''; };
  const showSuggest = (cands, idx) => {
    suggest.innerHTML = cands.map((c, i) => `<span class="chip ${i === idx ? 'active' : ''}">${esc(c)}</span>`).join('');
    suggest.classList.remove('hidden');
    $$('.chip', suggest).forEach((chip, i) => chip.onclick = () => applyCandidate(i));
  };

  function currentToken() {
    const pos = input.selectionStart != null ? input.selectionStart : input.value.length;
    const left = input.value.slice(0, pos);
    const start = left.lastIndexOf(' ') + 1;
    return { start, token: left.slice(start), before: input.value.slice(0, start), after: input.value.slice(pos) };
  }
  function candidatesFor(token, before) {
    const trimmed = before.trim();
    let pool;
    if (!trimmed) {
      pool = MC_COMMANDS.slice().sort();
    } else {
      const cmd = trimmed.split(/\s+/)[0].toLowerCase().replace(/^\//, '');
      // Command's own keyword args first, then online player names.
      const players = [...State.players].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      pool = (ARG_COMPLETIONS[cmd] || []).concat(players);
    }
    const t = token.toLowerCase();
    const seen = new Set();
    return pool.filter((c) => {
      const lc = c.toLowerCase();
      if (!lc.startsWith(t) || seen.has(lc)) return false;
      seen.add(lc);
      return true;
    });
  }
  function applyCandidate(idx) {
    if (!cyc) return;
    cyc.idx = ((idx % cyc.cands.length) + cyc.cands.length) % cyc.cands.length;
    const chosen = cyc.cands[cyc.idx];
    input.value = cyc.before + chosen + cyc.after;
    const caret = (cyc.before + chosen).length;
    input.setSelectionRange(caret, caret);
    showSuggest(cyc.cands, cyc.idx);
  }
  function doTab() {
    if (cyc) { applyCandidate(cyc.idx + 1); return; }
    const { token, before, after } = currentToken();
    const cands = candidatesFor(token, before);
    if (!cands.length) return;
    if (cands.length === 1) { input.value = before + cands[0] + (after || ''); const c = (before + cands[0]).length; input.setSelectionRange(c, c); return; }
    cyc = { before, after, cands, idx: 0 };
    applyCandidate(0);
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); doTab(); return; }
    if (e.key === 'Escape') { hideSuggest(); return; }
    if (e.key === 'Enter') { hideSuggest(); const v = input.value; sendFn(); if (v.trim()) { pushHistory(v.trim()); } histIdx = -1; return; }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!State.cmdHistory.length) return;
      if (histIdx === -1) { draft = input.value; histIdx = State.cmdHistory.length; }
      histIdx = Math.max(0, histIdx - 1);
      input.value = State.cmdHistory[histIdx];
      requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
      hideSuggest();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx === -1) return;
      histIdx++;
      if (histIdx >= State.cmdHistory.length) { histIdx = -1; input.value = draft; }
      else input.value = State.cmdHistory[histIdx];
      hideSuggest();
    }
  });
  input.addEventListener('input', () => { if (cyc) hideSuggest(); });
  input.addEventListener('blur', () => setTimeout(hideSuggest, 150));
}

function pushHistory(cmd) {
  if (State.cmdHistory[State.cmdHistory.length - 1] !== cmd) {
    State.cmdHistory.push(cmd);
    if (State.cmdHistory.length > 100) State.cmdHistory.shift();
    try { localStorage.setItem('minedeck_cmdhist', JSON.stringify(State.cmdHistory)); } catch (_) {}
  }
}

/* ======================= Topbar controls ======================= */
function bindTopbar() {
  $('#btn-start').onclick = () => serverAction('start');
  $('#btn-restart').onclick = async () => { if (await confirmDialog('Перезапустить сервер?')) serverAction('restart'); };
  $('#btn-stop').onclick = async () => { if (await confirmDialog('Остановить сервер?')) serverAction('stop'); };
  $('#btn-kill').onclick = async () => { if (await confirmDialog('Принудительно завершить процесс (SIGKILL)? Возможна потеря данных.', { danger: true, okText: 'Завершить' })) serverAction('kill'); };
}
async function serverAction(action) {
  try { await API.serverAction(action); }
  catch (err) {
    if (action === 'start' && /EULA/i.test(err.message)) return promptEula();
    toastErr(err);
  }
}
async function promptEula() {
  if (await confirmDialog('Для запуска сервера нужно принять лицензионное соглашение Minecraft (EULA). Принять?', { okText: 'Принять EULA' })) {
    try { await API.acceptEula(); toast('EULA принято', 'success'); await API.serverAction('start'); }
    catch (err) { toastErr(err); }
  }
}

/* ======================= Router ======================= */
const VIEWS = ['dashboard', 'files', 'databases', 'backups', 'timers', 'properties', 'firewall', 'settings'];
function router() {
  let view = (location.hash.replace('#/', '') || 'dashboard').split('/')[0];
  if (!VIEWS.includes(view)) view = 'dashboard';
  State.view = view;
  $$('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  const c = $('#content');
  if (view === 'dashboard') renderDashboard(c);
  else if (view === 'files') renderFiles(c);
  else if (view === 'databases') renderDatabases(c);
  else if (view === 'backups') renderBackups(c);
  else if (view === 'timers') renderTimers(c);
  else if (view === 'properties') renderPropertiesPage(c);
  else if (view === 'firewall') renderFirewallPage(c);
  else if (view === 'settings') renderSettings(c);
}

/* ======================= Dashboard ======================= */
function statCard(label, valueId, valueHtml, barId) {
  return `<div class="${CARD}"><div class="card-body p-4 gap-2">
    <div class="text-xs font-semibold uppercase tracking-wide text-base-content/50">${label}</div>
    <div class="text-2xl font-extrabold tracking-tight" id="${valueId}">${valueHtml}</div>
    ${barId ? `<progress class="progress progress-success w-full h-2" id="${barId}" value="0" max="100"></progress>` : '<div id="' + valueId + '-sub" class="text-xs text-base-content/40"></div>'}
  </div></div>`;
}
function renderDashboard(c) {
  c.innerHTML = `
    ${pageHead('Панель', 'Состояние сервера и живая консоль')}
    <div class="grid gap-4 mb-4" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
      ${statCard('Статус', 'd-status', '—', null)}
      ${statCard('CPU сервера', 'd-cpu', '0<small class="text-sm font-semibold text-base-content/50"> ядр</small>', 'd-cpu-bar')}
      ${statCard('RAM сервера', 'd-mem', '0<small class="text-sm font-semibold text-base-content/50"> МБ</small>', 'd-mem-bar')}
      ${statCard('RAM системы', 'd-sysmem', '0<small class="text-sm font-semibold text-base-content/50">%</small>', 'd-sysmem-bar')}
    </div>
    <div class="${CARD}"><div class="card-body p-4">
      ${sectionTitle('Консоль сервера', '<button class="btn btn-ghost btn-xs" id="c-clear">Очистить вид</button>')}
      <div class="flex flex-col">
        <div class="console" id="console"></div>
        <div class="relative">
          <div id="cmd-suggest" class="cmd-suggest hidden"></div>
          <div class="flex gap-2 mt-2.5">
            <input type="text" id="cmd-input" placeholder="Команда сервера · ↑ история · Tab автодополнение" autocomplete="off" spellcheck="false" class="input input-bordered flex-1 font-mono" />
            <button class="btn btn-primary" id="cmd-send">Отправить</button>
          </div>
        </div>
      </div>
    </div></div>`;

  renderConsoleHistory(State.history || []);
  const input = $('#cmd-input');
  const send = () => {
    const v = input.value.trim();
    if (!v) return;
    wsSend({ type: 'command', command: v });
    input.value = '';
  };
  $('#cmd-send').onclick = () => { const v = input.value.trim(); send(); if (v) pushHistory(v); };
  setupConsoleInput(input, send);
  $('#c-clear').onclick = () => { $('#console').innerHTML = ''; };

  updateDashStatusCard();
  if (State.stats) updateDashStats(State.stats);
}

function updateDashStatusCard() {
  const el = $('#d-status');
  if (!el) return;
  el.textContent = STATE_LABEL[State.status.state] || State.status.state;
  const sub = $('#d-status-sub');
  if (sub) {
    sub.textContent = (State.status.state !== 'stopped' && State.status.startedAt)
      ? 'PID ' + (State.status.pid || '—') + ' • ' + fmtDuration((Date.now() - State.status.startedAt) / 1000)
      : '';
  }
}
function setBar(id, pct, valId, valText) {
  const bar = $('#' + id);
  if (bar) {
    const p = Math.max(0, Math.min(100, pct || 0));
    bar.value = p;
    bar.className = 'progress w-full h-2 ' + (pct > 90 ? 'progress-error' : pct > 70 ? 'progress-warning' : 'progress-success');
  }
  if (valId) { const v = $('#' + valId); if (v) v.innerHTML = valText; }
}
function updateDashStats(msg) {
  const p = msg.process || {};
  const s = msg.system || {};
  const sv = msg.server || State.status || {};
  const maxRam = (State.settings && State.settings.server && State.settings.server.maxRamMB) || s.memTotalMB || 1;
  const effCores = (sv.cpuCores && sv.cpuCores > 0) ? sv.cpuCores : (sv.totalCores || s.cpuCount || 1);
  const coresUsed = (p.cpu || 0) / 100;
  const small = (t) => `<small class="text-sm font-semibold text-base-content/50">${t}</small>`;
  setBar('d-cpu-bar', (coresUsed / effCores) * 100, 'd-cpu', `${coresUsed.toFixed(1)}${small(` / ${effCores} ${effCores === 1 ? 'ядро' : 'ядр'}`)}`);
  setBar('d-mem-bar', ((p.memMB || 0) / maxRam) * 100, 'd-mem', `${p.memMB || 0}${small(' МБ')}`);
  setBar('d-sysmem-bar', s.memPercent || 0, 'd-sysmem', `${s.memPercent || 0}${small('%')}`);
  updateDashStatusCard();
}

/* ======================= Files ======================= */
const Files = { cwd: '' };
async function renderFiles(c) {
  c.innerHTML = `
    ${pageHead('Файлы', 'Файловый менеджер — перетащите файлы или папки для загрузки')}
    <div class="${CARD} relative drop-target select-none" id="f-card">
      <div class="dropzone-hint" id="f-drop-hint">${icon('upload')} Отпустите, чтобы загрузить в текущую папку</div>
      <div class="card-body p-4">
        <div class="flex items-center gap-2 flex-wrap mb-3">
          <button class="btn btn-sm btn-ghost gap-1.5" id="f-up">${icon('up')} Вверх</button>
          <button class="btn btn-sm btn-ghost gap-1.5" id="f-refresh">${icon('refresh')} Обновить</button>
          <div class="flex-1"></div>
          <button class="btn btn-sm btn-ghost gap-1.5" id="f-newfile">${icon('file-plus')} Файл</button>
          <button class="btn btn-sm btn-ghost gap-1.5" id="f-newdir">${icon('folder-plus')} Папка</button>
          <button class="btn btn-sm gap-1.5" id="f-uploaddir">${icon('upload')} Папка</button>
          <button class="btn btn-sm btn-primary gap-1.5" id="f-upload">${icon('upload')} Файлы</button>
          <input type="file" id="f-file" multiple class="hidden" />
          <input type="file" id="f-filedir" webkitdirectory directory multiple class="hidden" />
        </div>
        <div class="breadcrumbs text-sm py-0 mb-2" id="f-crumbs"><ul></ul></div>
        <div class="overflow-x-auto" id="f-list"></div>
      </div>
    </div>`;
  $('#f-refresh').onclick = () => loadFiles(Files.cwd);
  $('#f-up').onclick = () => { const parts = Files.cwd.split('/').filter(Boolean); parts.pop(); loadFiles(parts.join('/')); };
  $('#f-newfile').onclick = () => newEntry(false);
  $('#f-newdir').onclick = () => newEntry(true);
  $('#f-upload').onclick = () => $('#f-file').click();
  $('#f-uploaddir').onclick = () => $('#f-filedir').click();
  $('#f-file').onchange = (e) => {
    const items = Array.from(e.target.files).map((f) => ({ file: f, path: f.name }));
    if (items.length) uploadItems(items);
    e.target.value = '';
  };
  $('#f-filedir').onchange = (e) => {
    const items = Array.from(e.target.files).map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
    if (items.length) uploadItems(items);
    e.target.value = '';
  };
  setupDropzone($('#f-card'));
  loadFiles(Files.cwd);
}

function setupDropzone(card) {
  let depth = 0;
  const on = (name, fn) => card.addEventListener(name, fn);
  on('dragenter', (e) => { e.preventDefault(); depth++; card.classList.add('dragover'); });
  on('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  on('dragleave', (e) => { e.preventDefault(); depth = Math.max(0, depth - 1); if (depth === 0) card.classList.remove('dragover'); });
  on('drop', async (e) => {
    e.preventDefault();
    depth = 0; card.classList.remove('dragover');
    const dt = e.dataTransfer;
    const collected = [];
    const items = dt && dt.items ? Array.from(dt.items) : [];
    const entries = [];
    if (items.length && items[0].webkitGetAsEntry) {
      for (const it of items) { const en = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (en) entries.push(en); }
    }
    if (entries.length) {
      for (const en of entries) await walkEntry(en, '', collected);
    } else if (dt && dt.files) {
      for (const f of dt.files) collected.push({ file: f, path: f.name });
    }
    if (collected.length) uploadItems(collected);
    else toast('Не удалось прочитать перетащенные файлы', 'error');
  });
}

function walkEntry(entry, prefix, out) {
  return new Promise((resolve) => {
    if (!entry) return resolve();
    if (entry.isFile) {
      entry.file((f) => { out.push({ file: f, path: prefix + entry.name }); resolve(); }, () => resolve());
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const acc = [];
      const readBatch = () => reader.readEntries(async (batch) => {
        if (!batch.length) {
          for (const child of acc) await walkEntry(child, prefix + entry.name + '/', out);
          resolve();
        } else { acc.push(...batch); readBatch(); }
      }, () => resolve());
      readBatch();
    } else { resolve(); }
  });
}

async function uploadItems(items) {
  const fd = new FormData();
  const relpaths = [];
  for (const it of items) { fd.append('files', it.file, it.file.name); relpaths.push(it.path); }
  fd.append('relpaths', JSON.stringify(relpaths));
  const label = items.length === 1 ? items[0].path : `${items.length} файл(ов)`;
  try {
    toast(`Загрузка: ${label}…`, 'info');
    const r = await API.upload(Files.cwd, fd);
    toast(`Загружено: ${r.count != null ? r.count : (r.saved || []).length}`, 'success');
    loadFiles(Files.cwd);
  } catch (err) { toastErr(err); }
}
async function loadFiles(path) {
  try {
    const data = await API.listFiles(path);
    Files.cwd = data.path;
    renderCrumbs(data.path);
    renderFileList(data.entries);
  } catch (err) { toastErr(err); }
}
function renderCrumbs(path) {
  const parts = path.split('/').filter(Boolean);
  let acc = '';
  let html = `<li><a data-p="" class="cursor-pointer gap-1.5">${icon('folder')} сервер</a></li>`;
  for (const part of parts) {
    acc += (acc ? '/' : '') + part;
    html += `<li><a data-p="${esc(acc)}" class="cursor-pointer">${esc(part)}</a></li>`;
  }
  const ul = $('#f-crumbs ul');
  ul.innerHTML = html;
  $$('a', ul).forEach((a) => (a.onclick = () => loadFiles(a.dataset.p)));
}
function openEntry(type, path, name, editable) {
  if (type === 'dir') loadFiles(path);
  else if (editable) editFile(path, name);
  else window.open(API.downloadUrl(path));
}

function renderFileList(entries) {
  closeKebab();
  const box = $('#f-list');
  if (!entries.length) { box.innerHTML = empty('Папка пуста'); return; }
  box.innerHTML = `<table class="table table-sm">
    <thead><tr><th>Имя</th><th class="w-24">Размер</th><th class="w-40">Изменён</th><th class="w-10"></th></tr></thead>
    <tbody>${
    entries.map((e) => {
      const ic = e.type === 'dir' ? `<span class="text-warning">${icon('folder')}</span>` : `<span class="text-base-content/40">${icon(e.editable ? 'file' : 'file-plain')}</span>`;
      return `<tr class="hover" data-path="${esc(e.path)}" data-type="${e.type}" data-editable="${e.editable}" data-name="${esc(e.name)}">
        <td><div class="flex items-center gap-2.5">${ic}<span class="lnk cursor-pointer hover:text-primary font-medium">${esc(e.name)}</span></div></td>
        <td class="text-base-content/50 whitespace-nowrap">${e.type === 'dir' ? '—' : fmtBytes(e.size)}</td>
        <td class="text-base-content/50 whitespace-nowrap">${e.modified ? fmtDate(e.modified) : '—'}</td>
        <td class="text-right"><button class="kebab-btn" title="Действия">${icon('kebab')}</button></td></tr>`;
    }).join('')
  }</tbody></table>`;

  $$('tr[data-path]', box).forEach((tr) => {
    const path = tr.dataset.path, type = tr.dataset.type, name = tr.dataset.name, editable = tr.dataset.editable === 'true';
    $('.lnk', tr).onclick = () => openEntry(type, path, name, editable);
    tr.ondblclick = (ev) => { if (ev.target.closest('.kebab-btn') || ev.target.closest('.kebab-menu')) return; openEntry(type, path, name, editable); };
    $('.kebab-btn', tr).onclick = (ev) => {
      ev.stopPropagation();
      const actions = [];
      if (type === 'dir') actions.push({ label: 'Открыть', icon: icon('folder-open'), onClick: () => loadFiles(path) });
      if (editable) actions.push({ label: 'Редактировать', icon: icon('edit'), onClick: () => editFile(path, name) });
      actions.push({ label: type === 'dir' ? 'Скачать (.tar.gz)' : 'Скачать', icon: icon('download'), onClick: () => window.open(API.downloadUrl(path)) });
      actions.push({ label: 'Переименовать', icon: icon('edit'), onClick: () => renameEntry(path, name) });
      actions.push({ label: 'Удалить', icon: icon('trash'), danger: true, onClick: () => deleteEntry(path, name) });
      openKebab(ev.currentTarget, actions);
    };
  });
}

// ---- Kebab dropdown menu (shared) ----
let _kebabEl = null;
function closeKebab() {
  if (_kebabEl) { _kebabEl.remove(); _kebabEl = null; }
  document.removeEventListener('mousedown', kebabOutside, true);
  window.removeEventListener('scroll', closeKebab, true);
}
function kebabOutside(e) { if (_kebabEl && !_kebabEl.contains(e.target)) closeKebab(); }
function openKebab(anchor, actions) {
  closeKebab();
  const menu = document.createElement('div');
  menu.className = 'kebab-menu';
  menu.innerHTML = actions.map((a, i) =>
    `<button class="kebab-item ${a.danger ? 'danger' : ''}" data-i="${i}"><span class="ki">${a.icon || ''}</span>${esc(a.label)}</button>`
  ).join('');
  document.body.appendChild(menu);
  _kebabEl = menu;
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  menu.style.top = top + 'px';
  menu.style.left = Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw)) + 'px';
  actions.forEach((a, i) => { menu.querySelector(`[data-i="${i}"]`).onclick = () => { closeKebab(); a.onClick(); }; });
  setTimeout(() => {
    document.addEventListener('mousedown', kebabOutside, true);
    window.addEventListener('scroll', closeKebab, true);
  }, 0);
}
async function editFile(path, name) {
  try {
    const data = await API.readFile(path);
    const m = openModal({
      title: 'Редактор — ' + name, wide: true,
      body: `<textarea id="ed-area" spellcheck="false" class="textarea textarea-bordered w-full font-mono text-xs leading-relaxed" style="height:55vh"></textarea>`,
      footer: `<button class="btn btn-ghost" data-c>Отмена</button><button class="btn btn-primary" data-s>Сохранить</button>`,
    });
    $('#ed-area', m.root).value = data.content;
    $('[data-c]', m.root).onclick = m.close;
    $('[data-s]', m.root).onclick = async () => {
      try { await API.writeFile(path, $('#ed-area', m.root).value); toast('Сохранено', 'success'); m.close(); }
      catch (err) { toastErr(err); }
    };
  } catch (err) { toastErr(err); }
}
function newEntry(isDir) {
  const m = openModal({
    title: isDir ? 'Новая папка' : 'Новый файл',
    body: field('Имя', `<input id="ne-name" class="${INPUT}" placeholder="${isDir ? 'папка' : 'файл.txt'}" />`),
    footer: `<button class="btn btn-ghost" data-c>Отмена</button><button class="btn btn-primary" data-ok>Создать</button>`,
  });
  const inp = $('#ne-name', m.root); inp.focus();
  $('[data-c]', m.root).onclick = m.close;
  $('[data-ok]', m.root).onclick = async () => {
    const name = inp.value.trim();
    if (!name) return;
    const path = (Files.cwd ? Files.cwd + '/' : '') + name;
    try {
      if (isDir) await API.mkdir(path); else await API.writeFile(path, '');
      m.close(); loadFiles(Files.cwd); toast('Создано', 'success');
    } catch (err) { toastErr(err); }
  };
}
async function renameEntry(path, name) {
  const m = openModal({
    title: 'Переименовать',
    body: field('Новое имя', `<input id="rn-name" class="${INPUT}" value="${esc(name)}" />`),
    footer: `<button class="btn btn-ghost" data-c>Отмена</button><button class="btn btn-primary" data-ok>Сохранить</button>`,
  });
  const inp = $('#rn-name', m.root); inp.focus(); inp.select();
  $('[data-c]', m.root).onclick = m.close;
  $('[data-ok]', m.root).onclick = async () => {
    try { await API.renameFile(path, inp.value.trim()); m.close(); loadFiles(Files.cwd); }
    catch (err) { toastErr(err); }
  };
}
async function deleteEntry(path, name) {
  if (!(await confirmDialog(`Удалить «${name}»? Действие необратимо.`, { danger: true, okText: 'Удалить' }))) return;
  try { await API.deleteFile(path); loadFiles(Files.cwd); toast('Удалено', 'success'); }
  catch (err) { toastErr(err); }
}

/* ======================= Backups ======================= */
async function renderBackups(c) {
  c.innerHTML = `
    ${pageHead('Бэкапы', 'Резервные копии всей директории сервера (.tar.gz)', `<button class="btn btn-primary btn-sm gap-1.5" id="b-create">${icon('plus')} Создать бэкап</button>`)}
    <div id="b-list" class="${CARD}"><div class="card-body p-4">${empty('Загрузка…')}</div></div>
    <div class="${CARD} mt-4"><div class="card-body p-5">
      ${sectionTitle('Настройки хранения')}
      <div class="grid gap-4 sm:grid-cols-2">
        ${field('Хранить последних копий', `<input type="number" id="b-max" min="0" class="${INPUT}" />`, '0 = без ограничения. Старые удаляются автоматически.')}
        ${field('Исключения (через запятую)', `<input type="text" id="b-exclude" class="${INPUT}" />`, 'Папки/файлы, не попадающие в бэкап.')}
      </div>
      <button class="btn btn-primary btn-sm mt-4" id="b-save">Сохранить настройки</button>
    </div></div>`;
  $('#b-create').onclick = createBackup;
  await loadBackups();
  $('#b-save').onclick = async () => {
    try {
      await API.backupSettings({
        maxKeep: $('#b-max').value,
        exclude: $('#b-exclude').value.split(',').map((s) => s.trim()).filter(Boolean),
      });
      toast('Настройки сохранены', 'success');
    } catch (err) { toastErr(err); }
  };
}
async function loadBackups() {
  try {
    const data = await API.backups();
    $('#b-max').value = data.settings.maxKeep;
    $('#b-exclude').value = (data.settings.exclude || []).join(', ');
    const box = $('#b-list');
    if (!data.backups.length) { box.innerHTML = `<div class="card-body p-4">${empty('Бэкапов пока нет')}</div>`; return; }
    box.innerHTML = `<div class="card-body p-4 overflow-x-auto"><table class="table table-sm">
      <thead><tr><th>Имя</th><th class="w-24">Размер</th><th class="w-40">Создан</th><th class="w-64"></th></tr></thead><tbody>${
      data.backups.map((b) => `<tr class="hover">
        <td class="font-mono text-xs">${esc(b.name)}</td>
        <td class="text-base-content/50 whitespace-nowrap">${fmtBytes(b.size)}</td>
        <td class="text-base-content/50 whitespace-nowrap">${fmtDate(b.created)}</td>
        <td class="text-right whitespace-nowrap" data-name="${esc(b.name)}">
          <button class="btn btn-ghost btn-xs gap-1" data-a="download">${icon('download')} Скачать</button>
          <button class="btn btn-warning btn-xs gap-1" data-a="restore">${icon('rotate-ccw')} Восстановить</button>
          <button class="btn btn-error btn-xs" data-a="delete">${icon('trash')}</button>
        </td></tr>`).join('')
    }</tbody></table></div>`;
    $$('td[data-name]', box).forEach((td) => {
      const name = td.dataset.name;
      $$('[data-a]', td).forEach((btn) => btn.onclick = () => {
        const a = btn.dataset.a;
        if (a === 'download') window.open(API.backupDownloadUrl(name));
        else if (a === 'restore') restoreBackup(name);
        else if (a === 'delete') deleteBackup(name);
      });
    });
  } catch (err) { toastErr(err); }
}
async function createBackup() {
  const m = openModal({
    title: 'Создать бэкап',
    body: field('Метка (необязательно)', `<input id="bk-label" class="${INPUT}" placeholder="например, before-update" />`,
      'Будет создан .tar.gz всей директории сервера. Можно делать и на запущенном сервере.'),
    footer: `<button class="btn btn-ghost" data-c>Отмена</button><button class="btn btn-primary" data-ok>Создать</button>`,
  });
  $('[data-c]', m.root).onclick = m.close;
  $('[data-ok]', m.root).onclick = async () => {
    const label = $('#bk-label', m.root).value.trim();
    m.close(); toast('Создаётся бэкап…', 'info');
    try { await API.createBackup(label); toast('Бэкап создан', 'success'); loadBackups(); }
    catch (err) { toastErr(err); }
  };
}
async function restoreBackup(name) {
  if (State.status.state !== 'stopped') { toast('Сначала остановите сервер.', 'error'); return; }
  if (!(await confirmDialog(`Восстановить из «${name}»? Текущие файлы будут перезаписаны.`, { danger: true, okText: 'Восстановить' }))) return;
  try { toast('Восстановление…', 'info'); await API.restoreBackup(name); toast('Восстановлено', 'success'); }
  catch (err) { toastErr(err); }
}
async function deleteBackup(name) {
  if (!(await confirmDialog(`Удалить бэкап «${name}»?`, { danger: true, okText: 'Удалить' }))) return;
  try { await API.deleteBackup(name); loadBackups(); toast('Удалено', 'success'); }
  catch (err) { toastErr(err); }
}

/* ======================= Timers ======================= */
const ACTION_LABEL = { restart: 'Перезапуск', stop: 'Остановка', start: 'Запуск', backup: 'Бэкап', command: 'Команда' };
async function renderTimers(c) {
  c.innerHTML = `
    ${pageHead('Таймеры', 'Плановые задачи: рестарты, бэкапы, команды по расписанию', `<button class="btn btn-primary btn-sm gap-1.5" id="t-add">${icon('plus')} Новая задача</button>`)}
    <div id="t-list" class="${CARD}"><div class="card-body p-4">${empty('Загрузка…')}</div></div>`;
  $('#t-add').onclick = () => taskDialog(null);
  await loadTasks();
}
async function loadTasks() {
  try {
    const data = await API.tasks();
    const box = $('#t-list');
    if (!data.tasks.length) { box.innerHTML = `<div class="card-body p-4">${empty('Задач пока нет. Добавьте, например, ежедневный рестарт в 05:00.')}</div>`; return; }
    box.innerHTML = `<div class="card-body p-4 overflow-x-auto"><table class="table table-sm">
      <thead><tr><th>Задача</th><th>Расписание</th><th>Действие</th><th class="whitespace-nowrap">Следующий запуск</th><th class="w-20"></th></tr></thead><tbody>${
      data.tasks.map((t) => {
        const sched = t.type === 'interval' ? `каждые ${t.intervalMinutes} мин` : `ежедневно в ${t.time}`;
        return `<tr class="hover" data-id="${t.id}">
          <td><div class="flex items-center gap-2"><b>${esc(t.name)}</b> ${t.enabled ? '<span class="badge badge-success badge-sm">вкл</span>' : '<span class="badge badge-ghost badge-sm">выкл</span>'}</div>
              ${t.action === 'command' ? `<div class="text-xs text-base-content/40 font-mono">${esc(t.command)}</div>` : ''}</td>
          <td class="whitespace-nowrap">${sched}</td>
          <td>${ACTION_LABEL[t.action] || t.action}</td>
          <td class="text-base-content/50 whitespace-nowrap">${t.enabled ? fmtDate(t.nextRun) : '—'}</td>
          <td class="text-right whitespace-nowrap">
            <button class="btn btn-ghost btn-xs" data-a="edit">${icon('edit')}</button>
            <button class="btn btn-error btn-xs" data-a="del">${icon('trash')}</button>
          </td></tr>`;
      }).join('')
    }</tbody></table></div>`;
    $$('tr[data-id]', box).forEach((tr) => {
      const id = tr.dataset.id;
      const task = data.tasks.find((x) => x.id === id);
      $('[data-a="edit"]', tr).onclick = () => taskDialog(task);
      $('[data-a="del"]', tr).onclick = async () => {
        if (await confirmDialog(`Удалить задачу «${task.name}»?`, { danger: true, okText: 'Удалить' })) {
          try { await API.deleteTask(id); loadTasks(); } catch (err) { toastErr(err); }
        }
      };
    });
  } catch (err) { toastErr(err); }
}
function taskDialog(task) {
  const t = task || { name: '', enabled: true, type: 'daily', time: '05:00', intervalMinutes: 360, action: 'restart', command: '', warn: 'say Перезапуск сервера через 30 секунд', warnSeconds: 0 };
  const m = openModal({
    title: task ? 'Изменить задачу' : 'Новая задача',
    body: `
      ${field('Название', `<input id="tk-name" class="${INPUT}" value="${esc(t.name)}" placeholder="Ночной рестарт" />`)}
      <div class="grid gap-3 sm:grid-cols-2">
        ${field('Тип расписания', `<select id="tk-type" class="${SELECT}"><option value="daily">Ежедневно в указанное время</option><option value="interval">Через интервал</option></select>`)}
        ${field('Действие', `<select id="tk-action" class="${SELECT}"><option value="restart">Перезапуск</option><option value="stop">Остановка</option><option value="start">Запуск</option><option value="backup">Бэкап</option><option value="command">Команда</option></select>`)}
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <div id="tk-time-wrap">${field('Время (ЧЧ:ММ)', `<input id="tk-time" type="time" class="${INPUT}" value="${esc(t.time)}" />`)}</div>
        <div id="tk-interval-wrap">${field('Интервал (минут)', `<input id="tk-interval" type="number" min="1" class="${INPUT}" value="${t.intervalMinutes}" />`)}</div>
      </div>
      <div id="tk-command-wrap">${field('Команда сервера', `<input id="tk-command" class="${INPUT}" value="${esc(t.command)}" placeholder="say Привет" />`)}</div>
      <div class="grid gap-3 sm:grid-cols-2" id="tk-warn-wrap">
        ${field('Предупредить командой (рестарт/стоп)', `<input id="tk-warn" class="${INPUT}" value="${esc(t.warn)}" />`)}
        ${field('За сколько секунд', `<input id="tk-warnsec" type="number" min="0" class="${INPUT}" value="${t.warnSeconds}" />`)}
      </div>
      <label class="flex items-center gap-3 cursor-pointer mt-2">
        <input type="checkbox" id="tk-enabled" ${t.enabled ? 'checked' : ''} class="toggle toggle-success" />
        <span class="font-medium text-sm">Задача включена</span>
      </label>`,
    footer: `<button class="btn btn-ghost" data-c>Отмена</button><button class="btn btn-primary" data-ok>Сохранить</button>`,
  });
  const R = m.root;
  $('#tk-type', R).value = t.type;
  $('#tk-action', R).value = t.action;
  const sync = () => {
    const type = $('#tk-type', R).value, action = $('#tk-action', R).value;
    $('#tk-time-wrap', R).style.display = type === 'daily' ? '' : 'none';
    $('#tk-interval-wrap', R).style.display = type === 'interval' ? '' : 'none';
    $('#tk-command-wrap', R).style.display = action === 'command' ? '' : 'none';
    $('#tk-warn-wrap', R).style.display = (action === 'restart' || action === 'stop') ? '' : 'none';
  };
  $('#tk-type', R).onchange = sync; $('#tk-action', R).onchange = sync; sync();
  $('[data-c]', R).onclick = m.close;
  $('[data-ok]', R).onclick = async () => {
    const payload = {
      name: $('#tk-name', R).value.trim() || 'Задача',
      enabled: $('#tk-enabled', R).checked,
      type: $('#tk-type', R).value,
      action: $('#tk-action', R).value,
      time: $('#tk-time', R).value || '05:00',
      intervalMinutes: parseInt($('#tk-interval', R).value, 10) || 60,
      command: $('#tk-command', R).value,
      warn: $('#tk-warn', R).value,
      warnSeconds: parseInt($('#tk-warnsec', R).value, 10) || 0,
    };
    try {
      if (task) await API.updateTask(task.id, payload); else await API.addTask(payload);
      m.close(); loadTasks(); toast('Сохранено', 'success');
    } catch (err) { toastErr(err); }
  };
}

/* ======================= Databases (MySQL/MariaDB) ======================= */
async function renderDatabases(c) {
  c.innerHTML = pageHead('Базы данных', 'MySQL / MariaDB на этом сервере — создание баз, доступы и SQL-консоль',
    `<button class="btn btn-primary btn-sm gap-1.5 hidden" id="db-create">${icon('plus')} Создать базу</button>`)
    + `<div id="db-body"><div class="${CARD}"><div class="card-body p-4">${empty('Загрузка…')}</div></div></div>`;
  $('#db-create').onclick = () => dbCreateDialog();
  await loadDatabases();
}
async function loadDatabases() {
  const body = $('#db-body');
  try {
    const st = await API.databases();
    State.dbStatus = st;
    if (!st.connection.ok) { $('#db-create').classList.add('hidden'); renderDbConfig(body, st); }
    else { $('#db-create').classList.remove('hidden'); renderDbList(body, st); }
  } catch (err) { toastErr(err); body.innerHTML = `<div class="${CARD}"><div class="card-body p-4">${empty('Ошибка: ' + esc(err.message))}</div></div>`; }
}
function renderDbConfig(body, st) {
  const m = st.mysql || {};
  const errBanner = st.connection && st.connection.error
    ? `<div class="alert alert-warning py-2 text-sm mb-4"><span>Нет подключения к MySQL/MariaDB: ${esc(st.connection.error)}</span></div>` : '';
  body.innerHTML = `<div class="${CARD}"><div class="card-body p-5">
    ${sectionTitle('Подключение к MySQL / MariaDB')}
    ${errBanner}
    <div class="grid gap-4 sm:grid-cols-2">
      ${field('Хост', `<input id="db-host" class="${INPUT}" value="${esc(m.host || '127.0.0.1')}" />`)}
      ${field('Порт', `<input id="db-port" type="number" class="${INPUT}" value="${m.port || 3306}" />`)}
      ${field('Пользователь-администратор', `<input id="db-user" class="${INPUT}" value="${esc(m.adminUser || 'root')}" />`)}
      ${field('Пароль администратора', `<input id="db-pass" type="password" class="${INPUT}" placeholder="${m.hasPassword ? '•••••• (сохранён)' : 'пусто'}" />`)}
      ${field('Unix-сокет (необязательно)', `<input id="db-sock" class="${INPUT}" value="${esc(m.socketPath || '')}" placeholder="/run/mysqld/mysqld.sock" />`)}
      ${field('Хост для новых пользователей (GRANT)', `<input id="db-grant" class="${INPUT}" value="${esc(m.grantHost || '%')}" />`)}
    </div>
    <div class="alert py-2 text-sm mt-2 bg-base-200 border-base-300"><span>💡 На Ubuntu с MariaDB панель работает от root — обычно достаточно указать сокет <span class="font-mono">/run/mysqld/mysqld.sock</span>, пользователя <span class="font-mono">root</span> и пустой пароль (аутентификация через unix_socket).</span></div>
    <button class="btn btn-primary btn-sm mt-3 gap-1.5" id="db-save">${icon('check')} Проверить и сохранить</button>
  </div></div>`;
  $('#db-save').onclick = async () => {
    const patch = { host: $('#db-host').value, port: $('#db-port').value, adminUser: $('#db-user').value, socketPath: $('#db-sock').value, grantHost: $('#db-grant').value };
    const pass = $('#db-pass').value;
    if (pass) patch.adminPassword = pass;
    try {
      const r = await API.dbConfig(patch);
      if (r.connection && r.connection.ok) toast('Подключение успешно', 'success');
      else toast('Не удалось подключиться: ' + ((r.connection && r.connection.error) || ''), 'error');
      loadDatabases();
    } catch (err) { toastErr(err); }
  };
}
function renderDbList(body, st) {
  const dbs = st.databases;
  const rows = dbs.map((d) => `<tr class="hover">
    <td class="font-medium">${esc(d.name)} ${d.managed ? '' : '<span class="badge badge-ghost badge-sm">внешняя</span>'}</td>
    <td class="text-base-content/50 whitespace-nowrap">${d.sizeMB} МБ</td>
    <td class="text-base-content/50">${d.tables}</td>
    <td class="font-mono text-xs text-base-content/60">${d.managed ? esc(d.user + '@' + d.host + ':' + d.port) : '—'}</td>
    <td class="text-right whitespace-nowrap" data-name="${esc(d.name)}">
      ${d.managed ? `<button class="btn btn-ghost btn-xs gap-1" data-a="creds">${icon('key')} Данные</button>` : ''}
      <button class="btn btn-ghost btn-xs gap-1" data-a="sql">${icon('terminal')} SQL</button>
      <button class="btn btn-error btn-xs" data-a="del">${icon('trash')}</button>
    </td></tr>`).join('');
  body.innerHTML = `<div class="${CARD}"><div class="card-body p-4">
    <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
      <div class="flex items-center gap-2 text-sm text-base-content/60">${icon('database')} Подключено <span class="badge badge-success badge-sm">${esc(st.connection.version || 'ok')}</span></div>
      <button class="btn btn-ghost btn-xs gap-1" id="db-reconfig">${icon('settings')} Подключение</button>
    </div>
    <div class="overflow-x-auto">${dbs.length ? `<table class="table table-sm">
      <thead><tr><th>База</th><th>Размер</th><th>Таблиц</th><th>Доступ (user@host)</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>` : empty('Баз пока нет. Нажмите «Создать базу».')}</div>
  </div></div>`;
  $('#db-reconfig').onclick = () => renderDbConfig(body, st);
  $$('td[data-name]', body).forEach((td) => {
    const name = td.dataset.name;
    const d = dbs.find((x) => x.name === name);
    $$('[data-a]', td).forEach((btn) => btn.onclick = () => {
      const a = btn.dataset.a;
      if (a === 'creds') dbCredsDialog(d);
      else if (a === 'sql') dbQueryDialog(d);
      else if (a === 'del') dbDelete(name, d.managed);
    });
  });
}
function credRow(label, value) {
  return `<div class="flex items-center justify-between gap-3 py-2 border-b border-base-300/50 last:border-0">
    <span class="text-base-content/50 text-sm">${label}</span>
    <span class="font-mono text-xs bg-base-200 px-2 py-1 rounded select-all break-all">${esc(value)}</span>
  </div>`;
}
function dbCredsDialog(d) {
  const m = openModal({
    title: 'Данные подключения — ' + d.name,
    body: `<div>
      ${credRow('Хост', d.host)}${credRow('Порт', d.port)}${credRow('База данных', d.name)}
      ${credRow('Пользователь', d.user)}${credRow('Пароль', d.password)}
      ${credRow('JDBC URL', `jdbc:mysql://${d.host}:${d.port}/${d.name}`)}
    </div>
    <div class="text-xs text-base-content/40 mt-2">Вставьте эти данные в конфиг плагина. Тройной клик по значению выделяет его для копирования.</div>`,
    footer: `<button class="btn btn-primary" data-close2>Закрыть</button>`,
  });
  $('[data-close2]', m.root).onclick = m.close;
}
function dbCreateDialog() {
  const m = openModal({
    title: 'Создать базу данных',
    body: field('Имя базы', `<input id="dbname" class="${INPUT}" placeholder="myplugin" />`, 'Латиница, цифры, _ (до 32). Пользователь и пароль создадутся автоматически.'),
    footer: `<button class="btn btn-ghost" data-c>Отмена</button><button class="btn btn-primary" data-ok>Создать</button>`,
  });
  const inp = $('#dbname', m.root); inp.focus();
  $('[data-c]', m.root).onclick = m.close;
  $('[data-ok]', m.root).onclick = async () => {
    const name = inp.value.trim();
    if (!name) return;
    try {
      const r = await API.dbCreate(name);
      m.close(); toast('База создана', 'success'); loadDatabases();
      const db = r.database;
      dbCredsDialog({ name: db.name, user: db.user, password: db.password, host: db.connHost, port: db.port });
    } catch (err) { toastErr(err); }
  };
}
async function dbDelete(name, managed) {
  if (!(await confirmDialog(`Удалить базу «${name}»${managed ? ' и её пользователя' : ''}? Все данные будут потеряны безвозвратно.`, { danger: true, okText: 'Удалить' }))) return;
  try { await API.dbDelete(name); toast('База удалена', 'success'); loadDatabases(); }
  catch (err) { toastErr(err); }
}
function dbQueryDialog(d) {
  const m = openModal({
    title: 'SQL-консоль — ' + d.name, wide: true,
    body: `<textarea id="sqlbox" class="textarea textarea-bordered w-full font-mono text-xs leading-relaxed" style="height:20vh" spellcheck="false" placeholder="SELECT * FROM ... ;"></textarea>
      <div class="flex justify-between items-center mt-2">
        <span class="text-xs text-base-content/40">Ctrl/Cmd + Enter — выполнить</span>
        <button class="btn btn-primary btn-sm gap-1.5" id="sqlrun">${icon('play')} Выполнить</button>
      </div>
      <div id="sqlres" class="mt-3"></div>`,
    footer: `<button class="btn btn-ghost" data-close2>Закрыть</button>`,
  });
  $('[data-close2]', m.root).onclick = m.close;
  const run = async () => {
    const sql = $('#sqlbox', m.root).value.trim();
    if (!sql) return;
    const res = $('#sqlres', m.root);
    res.innerHTML = '<span class="loading loading-spinner loading-sm"></span>';
    try {
      const { result } = await API.dbQuery(d.name, sql);
      if (result.type === 'ok') {
        res.innerHTML = `<div class="alert alert-success py-2 text-sm"><span>✓ Готово. Затронуто строк: ${result.affectedRows}. ${esc(result.info || '')}</span></div>`;
      } else if (!result.rows.length) {
        res.innerHTML = `<div class="text-base-content/50 text-sm py-2">Запрос выполнен, строк нет.</div>`;
      } else {
        res.innerHTML = `<div class="overflow-auto max-h-[45vh] border border-base-300 rounded-lg"><table class="table table-xs table-pin-rows">
          <thead><tr>${result.columns.map((col) => `<th>${esc(col)}</th>`).join('')}</tr></thead>
          <tbody>${result.rows.map((r) => `<tr>${r.map((v) => `<td class="font-mono text-xs">${v === null ? '<span class="text-base-content/30">NULL</span>' : esc(v)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table></div>${result.truncated ? `<div class="text-xs text-base-content/40 mt-1">Показаны первые 500 из ${result.total} строк.</div>` : ''}`;
      }
    } catch (err) { res.innerHTML = `<div class="alert alert-error py-2 text-sm"><span>${esc(err.message)}</span></div>`; }
  };
  $('#sqlrun', m.root).onclick = run;
  $('#sqlbox', m.root).addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(); });
}

/* ======================= Settings ======================= */
let settingsTab = 'server';
async function renderSettings(c) {
  if (settingsTab !== 'server' && settingsTab !== 'panel') settingsTab = 'server';
  c.innerHTML = `
    ${pageHead('Настройки', 'Параметры запуска сервера и самой панели')}
    <div role="tablist" class="tabs tabs-bordered mb-5">
      <a role="tab" class="tab" data-t="server">Сервер и ОЗУ</a>
      <a role="tab" class="tab" data-t="panel">Панель</a>
    </div>
    <div id="settings-body"></div>`;
  $$('.tab', c).forEach((tab) => {
    tab.classList.toggle('tab-active', tab.dataset.t === settingsTab);
    tab.onclick = () => { settingsTab = tab.dataset.t; renderSettings(c); };
  });
  const body = $('#settings-body');
  if (settingsTab === 'server') renderServerSettings(body);
  else if (settingsTab === 'panel') renderPanelSettings(body);
}

// server.properties as its own top-level page
function renderPropertiesPage(c) {
  c.innerHTML = pageHead('server.properties', 'Настройки Minecraft-сервера (порт, MOTD, сложность и т.д.)') + '<div id="settings-body"></div>';
  renderProperties($('#settings-body'));
}
// Firewall as its own top-level page
function renderFirewallPage(c) {
  c.innerHTML = pageHead('Фаервол', 'Управление портами через ufw') + '<div id="settings-body"></div>';
  renderFirewall($('#settings-body'));
}

function toggleRow(label, sub, id, checked) {
  return settingRow(label, sub, `<input type="checkbox" id="${id}" ${checked ? 'checked' : ''} class="toggle toggle-success" />`);
}

async function renderServerSettings(body) {
  body.innerHTML = `<div class="${CARD}"><div class="card-body">${empty('Загрузка…')}</div></div>`;
  try {
    const data = await API.settings();
    const st = await API.serverStatus();
    State.settings = data;
    const s = data.server;
    const totalCores = data.cpuCount || 1;
    const coreWord = (i) => (i === 1 ? 'ядро' : i >= 2 && i <= 4 ? 'ядра' : 'ядер');
    let cpuOpts = `<option value="0" ${!s.cpuCores ? 'selected' : ''}>Все ядра — без ограничения</option>`;
    for (let i = 1; i <= totalCores; i++) cpuOpts += `<option value="${i}" ${s.cpuCores === i ? 'selected' : ''}>${i} ${coreWord(i)} (${i} vCPU)</option>`;
    body.innerHTML = `
      <div class="${CARD}"><div class="card-body p-5">
        ${sectionTitle('Запуск и ресурсы')}
        <div class="grid gap-4 sm:grid-cols-2">
          ${field('Директория сервера', `<input id="s-dir" class="${INPUT}" value="${esc(s.directory)}" />`)}
          ${field('JAR-файл', `<input id="s-jar" class="${INPUT}" value="${esc(s.jar)}" />`)}
          ${field('Мин. ОЗУ (МБ)', `<input id="s-minram" type="number" min="128" step="128" class="${INPUT}" value="${s.minRamMB}" />`, `≈ ${(s.minRamMB / 1024).toFixed(1)} ГБ`)}
          ${field('Макс. ОЗУ (МБ)', `<input id="s-maxram" type="number" min="256" step="128" class="${INPUT}" value="${s.maxRamMB}" />`, `≈ ${(s.maxRamMB / 1024).toFixed(1)} ГБ`)}
          ${field('Ограничение CPU (сколько vCPU выделить)', `<select id="s-cpucores" class="${SELECT}">${cpuOpts}</select>`, data.hasTaskset ? `Доступно ядер: ${totalCores}. Привязка через taskset. Требует перезапуска сервера.` : '⚠ taskset недоступен — ограничение CPU не применится.')}
          ${field('Путь к Java', `<input id="s-java" class="${INPUT}" value="${esc(s.javaPath)}" />`)}
          ${field('Команда остановки', `<input id="s-stopcmd" class="${INPUT}" value="${esc(s.stopCommand)}" />`)}
          ${field('Доп. флаги JVM', `<input id="s-flags" class="${INPUT}" value="${esc(s.jvmFlags)}" placeholder="-Dfile.encoding=UTF-8" />`)}
        </div>
        ${field('Своя команда запуска (переопределяет всё выше)', `<input id="s-custom" class="${INPUT} font-mono" value="${esc(s.customCommand)}" placeholder="оставьте пустым для стандартного запуска" />`)}
        <div class="mt-2 rounded-box border border-base-300 px-4 divide-y divide-base-300/50">
          ${toggleRow('Флаги Aikar', 'оптимизация сборки мусора (GC)', 's-aikar', s.useAikarFlags)}
          ${toggleRow('Автозапуск', 'запускать сервер при старте панели', 's-autostart', s.autoStart)}
          ${toggleRow('Авто-перезапуск', 'перезапускать при падении', 's-autorestart', s.autoRestart)}
        </div>
        ${field('Предпросмотр команды запуска', `<div class="code-preview" id="s-preview">${esc(data.commandPreview)}</div>`)}
        <div class="flex items-center gap-3 flex-wrap mt-2">
          <button class="btn btn-primary" id="s-save">Сохранить</button>
          <span class="badge ${st.eula ? 'badge-success' : 'badge-error'} badge-lg">EULA: ${st.eula ? 'принято' : 'не принято'}</span>
          ${st.eula ? '' : '<button class="btn btn-warning btn-sm" id="s-eula">Принять EULA</button>'}
        </div>
      </div></div>`;
    $('#s-save').onclick = async () => {
      const payload = {
        directory: $('#s-dir').value, jar: $('#s-jar').value, javaPath: $('#s-java').value,
        minRamMB: $('#s-minram').value, maxRamMB: $('#s-maxram').value, cpuCores: $('#s-cpucores').value,
        stopCommand: $('#s-stopcmd').value, jvmFlags: $('#s-flags').value, customCommand: $('#s-custom').value,
        useAikarFlags: $('#s-aikar').checked, autoStart: $('#s-autostart').checked, autoRestart: $('#s-autorestart').checked,
      };
      try {
        const r = await API.saveServerSettings(payload);
        $('#s-preview').textContent = r.commandPreview;
        toast('Настройки сервера сохранены', 'success');
      } catch (err) { toastErr(err); }
    };
    const eulaBtn = $('#s-eula');
    if (eulaBtn) eulaBtn.onclick = async () => { try { await API.acceptEula(); toast('EULA принято', 'success'); renderServerSettings(body); } catch (err) { toastErr(err); } };
  } catch (err) { toastErr(err); body.innerHTML = `<div class="${CARD}"><div class="card-body">${empty('Ошибка загрузки настроек')}</div></div>`; }
}

const COMMON_PROPS = [
  ['server-port', 'Порт сервера'],
  ['motd', 'Описание (MOTD)'],
  ['max-players', 'Максимум игроков'],
  ['gamemode', 'Режим игры'],
  ['difficulty', 'Сложность'],
  ['level-name', 'Имя мира'],
  ['level-seed', 'Сид мира'],
  ['online-mode', 'Online-mode (лицензия)'],
  ['pvp', 'PvP'],
  ['view-distance', 'Дальность прорисовки'],
  ['white-list', 'Белый список'],
  ['enable-command-block', 'Командные блоки'],
];
async function renderProperties(body) {
  body.innerHTML = `<div class="${CARD}"><div class="card-body">${empty('Загрузка…')}</div></div>`;
  try {
    const data = await API.properties();
    if (!data.exists) {
      body.innerHTML = `<div class="${CARD}"><div class="card-body">${empty('Файл server.properties не найден.<br>Он появится после первого запуска сервера.')}</div></div>`;
      return;
    }
    const props = data.properties;
    const known = new Set(COMMON_PROPS.map((p) => p[0]));
    const rows = COMMON_PROPS.map(([key, label]) => {
      const val = props[key] != null ? props[key] : '';
      const isBool = val === 'true' || val === 'false';
      const control = isBool
        ? `<input type="checkbox" data-k="${key}" ${val === 'true' ? 'checked' : ''} class="toggle toggle-success" />`
        : `<input data-k="${key}" value="${esc(val)}" class="input input-bordered input-sm w-48" />`;
      return settingRow(label, key, control);
    }).join('');
    const others = Object.keys(props).filter((k) => !known.has(k)).sort();
    const otherRows = others.length
      ? others.map((k) => settingRow(k, '', `<input data-k="${esc(k)}" value="${esc(props[k])}" class="input input-bordered input-sm w-48" />`)).join('')
      : `<div class="text-base-content/40 text-sm py-2">—</div>`;
    body.innerHTML = `
      <div class="${CARD}"><div class="card-body p-5">
        ${sectionTitle('Основные параметры', '<button class="btn btn-primary btn-sm" id="p-save">Сохранить</button>')}
        <div class="divide-y divide-base-300/50">${rows}</div>
      </div></div>
      <div class="${CARD} mt-4"><div class="card-body p-5">
        ${sectionTitle(`Все параметры (${others.length})`)}
        <div class="divide-y divide-base-300/50" id="p-others">${otherRows}</div>
      </div></div>`;
    $('#p-save').onclick = async () => {
      const updates = {};
      $$('[data-k]', body).forEach((el) => {
        const k = el.dataset.k;
        updates[k] = el.type === 'checkbox' ? String(el.checked) : el.value;
      });
      try { await API.saveProperties(updates); toast('server.properties сохранён. Перезапустите сервер для применения.', 'success'); }
      catch (err) { toastErr(err); }
    };
  } catch (err) { toastErr(err); }
}

async function renderFirewall(body) {
  body.innerHTML = `<div class="${CARD}"><div class="card-body">${empty('Загрузка…')}</div></div>`;
  try {
    const fw = await API.firewall();
    if (!fw.installed) {
      body.innerHTML = `<div class="${CARD}"><div class="card-body">${empty('ufw не установлен на сервере.<br>Установите: <span class="font-mono">sudo apt install ufw</span>')}</div></div>`;
      return;
    }
    body.innerHTML = `
      <div class="${CARD}"><div class="card-body p-5">
        ${sectionTitle(
          `Фаервол (ufw) <span class="badge ${fw.active ? 'badge-success' : 'badge-error'} badge-lg align-middle ml-1">${fw.active ? 'активен' : 'выключен'}</span>`,
          fw.active ? '<button class="btn btn-error btn-sm" id="fw-toggle">Выключить</button>' : '<button class="btn btn-success btn-sm" id="fw-toggle">Включить</button>')}
        <div class="flex items-center gap-2 flex-wrap mb-4">
          <input id="fw-port" type="number" placeholder="Порт (напр. 25565)" class="input input-bordered input-sm w-52" />
          <select id="fw-proto" class="select select-bordered select-sm"><option value="both">tcp+udp</option><option value="tcp">tcp</option><option value="udp">udp</option></select>
          <button class="btn btn-success btn-sm" id="fw-allow">Разрешить</button>
          <button class="btn btn-error btn-sm" id="fw-deny">Запретить</button>
        </div>
        <div class="overflow-x-auto" id="fw-rules"></div>
        <div class="alert alert-warning mt-4 py-2 text-sm">
          <span>⚠ Перед включением фаервола убедитесь, что разрешён порт SSH (обычно 22) и порт панели, иначе можно потерять доступ.</span>
        </div>
      </div></div>`;
    renderFwRules(fw.rules);
    $('#fw-toggle').onclick = async () => {
      try { fw.active ? await API.fwDisable() : await API.fwEnable(); toast('Готово', 'success'); renderFirewall(body); }
      catch (err) { toastErr(err); }
    };
    const doRule = async (fn) => {
      const port = $('#fw-port').value, proto = $('#fw-proto').value;
      if (!port) { toast('Укажите порт', 'error'); return; }
      try { await fn(port, proto); toast('Правило применено', 'success'); renderFirewall(body); }
      catch (err) { toastErr(err); }
    };
    $('#fw-allow').onclick = () => doRule(API.fwAllow);
    $('#fw-deny').onclick = () => doRule(API.fwDeny);
  } catch (err) { toastErr(err); }
}
function renderFwRules(rules) {
  const box = $('#fw-rules');
  if (!rules || !rules.length) { box.innerHTML = empty('Нет правил'); return; }
  box.innerHTML = `<table class="table table-sm">
    <thead><tr><th>Порт/адрес</th><th>Действие</th><th>Направление</th><th>Источник</th><th class="w-24"></th></tr></thead><tbody>${
    rules.map((r) => `<tr class="hover">
      <td class="font-mono">${esc(r.to)}</td>
      <td><span class="badge ${r.action === 'ALLOW' ? 'badge-success' : 'badge-error'} badge-sm">${r.action}</span></td>
      <td class="text-base-content/50">${esc(r.direction)}</td>
      <td class="text-base-content/50">${esc(r.from)}</td>
      <td class="text-right"><button class="btn btn-error btn-xs" data-to="${esc(r.to)}" data-act="${r.action}">Удалить</button></td>
    </tr>`).join('')
  }</tbody></table>`;
  $$('[data-to]', box).forEach((btn) => btn.onclick = async () => {
    const m = btn.dataset.to.match(/^(\d+)(?:\/(tcp|udp))?/);
    if (!m) return;
    const port = m[1], proto = m[2] || 'both', action = btn.dataset.act === 'DENY' ? 'deny' : 'allow';
    try { await API.fwDelete(port, proto, action); toast('Правило удалено', 'success'); renderFirewall($('#settings-body')); }
    catch (err) { toastErr(err); }
  });
}

async function renderPanelSettings(body) {
  try {
    const data = await API.settings();
    const sys = await API.system();
    const infoRow = (k, v) => `<tr><td class="text-base-content/60">${k}</td><td class="text-right font-medium">${v}</td></tr>`;
    body.innerHTML = `
      <div class="${CARD}"><div class="card-body p-5">
        ${sectionTitle('Сеть панели')}
        <div class="grid gap-4 sm:grid-cols-2">
          ${field('Порт панели', `<input id="pn-port" type="number" class="${INPUT}" value="${data.panel.port}" />`, 'После изменения перезапустите панель: <span class="font-mono">systemctl restart minedeck</span>')}
          ${field('Адрес привязки', `<input id="pn-host" class="${INPUT}" value="${esc(data.panel.host)}" />`, '0.0.0.0 — доступ извне, 127.0.0.1 — только локально.')}
        </div>
        <button class="btn btn-primary btn-sm mt-2" id="pn-save">Сохранить</button>
      </div></div>
      <div class="${CARD} mt-4"><div class="card-body p-5">
        ${sectionTitle('Смена пароля')}
        <div class="grid gap-4 sm:grid-cols-2">
          ${field('Текущий пароль', `<input id="pw-cur" type="password" class="${INPUT}" />`)}
          ${field('Новый пароль', `<input id="pw-new" type="password" class="${INPUT}" />`)}
        </div>
        <button class="btn btn-primary btn-sm mt-2" id="pw-save">Изменить пароль</button>
      </div></div>
      <div class="${CARD} mt-4"><div class="card-body p-5">
        ${sectionTitle('Обновление панели', '<span class="badge badge-ghost" id="upd-ver">…</span>')}
        <div id="upd-info" class="text-sm text-base-content/60 mb-3">Проверка версии…</div>
        <div class="flex items-center gap-2 flex-wrap">
          <button class="btn btn-sm" id="upd-check">Проверить обновления</button>
          <button class="btn btn-sm btn-primary hidden" id="upd-apply">⤓ Обновить сейчас</button>
        </div>
        <div class="text-xs text-base-content/45 mt-3">Обновление тянет последнюю версию из GitHub-репозитория и перезапускает панель. Настройки, бэкапы и вход сохраняются.</div>
      </div></div>
      <div class="${CARD} mt-4"><div class="card-body p-5">
        ${sectionTitle('О системе')}
        <table class="table table-sm">
          ${infoRow('Версия панели', `<span class="font-mono">${esc(sys.panelVersion)}</span>`)}
          ${infoRow('Хост', esc(sys.system.hostname))}
          ${infoRow('ОС', `${esc(sys.system.platform)} ${esc(sys.system.release)} (${esc(sys.system.arch)})`)}
          ${infoRow('CPU', `${esc(sys.system.cpuModel)} × ${sys.system.cpuCount}`)}
          ${infoRow('ОЗУ', `${(sys.system.memUsedMB / 1024).toFixed(1)} / ${(sys.system.memTotalMB / 1024).toFixed(1)} ГБ`)}
          ${infoRow('Диск (сервер)', sys.disk ? `${(sys.disk.usedMB / 1024).toFixed(1)} / ${(sys.disk.totalMB / 1024).toFixed(1)} ГБ (${sys.disk.percent}%)` : '—')}
          ${infoRow('Java', `<span class="font-mono">${esc(sys.java || 'не найдена')}</span>`)}
          ${infoRow('Аптайм ОС', fmtDuration(sys.system.uptimeSec))}
        </table>
      </div></div>`;
    $('#pn-save').onclick = async () => {
      try { const r = await API.savePanelSettings({ port: $('#pn-port').value, host: $('#pn-host').value }); toast(r.note || 'Сохранено', 'success'); }
      catch (err) { toastErr(err); }
    };
    $('#pw-save').onclick = async () => {
      try { await API.changePassword($('#pw-cur').value, $('#pw-new').value); toast('Пароль изменён', 'success'); $('#pw-cur').value = ''; $('#pw-new').value = ''; }
      catch (err) { toastErr(err); }
    };
    initUpdateCard();
  } catch (err) { toastErr(err); }
}

async function initUpdateCard() {
  const info = $('#upd-info'), ver = $('#upd-ver'), checkBtn = $('#upd-check'), applyBtn = $('#upd-apply');
  if (!info) return;
  try {
    const v = await API.version();
    ver.textContent = 'v' + v.version + (v.sha ? ' · ' + v.sha : '');
    if (!v.isGit) {
      info.innerHTML = '⚠ Панель установлена не через git — авто-обновление недоступно. Используйте установщик <span class="font-mono">install.sh</span>.';
      checkBtn.disabled = true;
      return;
    }
    info.innerHTML = `Ветка <b>${esc(v.branch)}</b>, коммит <span class="font-mono">${esc(v.sha)}</span>` +
      (v.subject ? ` — ${esc(v.subject)}` : '') + (v.date ? `<br><span class="text-base-content/40">${fmtDate(Date.parse(v.date))}</span>` : '');
  } catch (err) { info.textContent = 'Не удалось получить версию: ' + err.message; }

  checkBtn.onclick = async () => {
    checkBtn.disabled = true; const old = checkBtn.textContent; checkBtn.textContent = 'Проверка…';
    try {
      const r = await API.checkUpdate();
      if (r.upToDate) { info.innerHTML = '✅ Установлена последняя версия.'; applyBtn.classList.add('hidden'); }
      else {
        info.innerHTML = `⬆ Доступно обновление: отставание на <b>${r.behind}</b> коммит(ов).` +
          (r.latest ? `<br>Последний: <span class="font-mono">${esc(r.latest)}</span>` : '');
        applyBtn.classList.remove('hidden');
      }
    } catch (err) { toastErr(err); }
    finally { checkBtn.disabled = false; checkBtn.textContent = old; }
  };

  applyBtn.onclick = async () => {
    if (!(await confirmDialog('Обновить панель до последней версии из репозитория? Панель перезапустится на несколько секунд.', { okText: 'Обновить' }))) return;
    applyBtn.disabled = true;
    try { await API.applyUpdate(); waitForRestart(); }
    catch (err) { toastErr(err); applyBtn.disabled = false; }
  };
}

function waitForRestart() {
  const m = openModal({
    title: 'Обновление панели',
    body: `<p class="leading-relaxed mb-3">Панель обновляется и перезапускается.<br>Страница обновится автоматически, когда сервис снова станет доступен…</p>
           <progress class="progress progress-success w-full" id="upd-bar" value="10" max="100"></progress>`,
  });
  const closeBtn = $('[data-close]', m.root); if (closeBtn) closeBtn.style.display = 'none';
  let seenDown = false, tries = 0;
  const bar = $('#upd-bar', m.root);
  const timer = setInterval(async () => {
    tries++;
    if (bar) bar.value = Math.min(90, 10 + tries * 4);
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (!res.ok) { seenDown = true; return; }
      if (seenDown || tries > 6) { clearInterval(timer); if (bar) bar.value = 100; setTimeout(() => location.reload(), 600); }
    } catch (_) { seenDown = true; }
    if (tries > 90) { clearInterval(timer); location.reload(); }
  }, 1500);
}

/* ======================= Go ======================= */
boot();
