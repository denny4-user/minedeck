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

function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(20px)'; t.style.transition = 'all .3s'; }, 3200);
  setTimeout(() => t.remove(), 3600);
}
function toastErr(err) { toast(err && err.message ? err.message : String(err), 'error'); }

function openModal({ title, body, footer, wide }) {
  const root = $('#modal-root');
  root.innerHTML = `
    <div class="modal-overlay">
      <div class="modal ${wide ? 'wide' : ''}">
        <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close">&times;</button></div>
        <div class="modal-body">${body}</div>
        ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
      </div>
    </div>`;
  const overlay = $('.modal-overlay', root);
  const close = () => { root.innerHTML = ''; };
  $('.modal-close', root).onclick = close;
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  return { root, close };
}

function confirmDialog(message, { danger, okText } = {}) {
  return new Promise((resolve) => {
    const m = openModal({
      title: 'Подтверждение',
      body: `<p style="margin:0;line-height:1.6">${esc(message)}</p>`,
      footer: `<button class="btn btn-ghost" data-c>Отмена</button>
               <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(okText || 'OK')}</button>`,
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
  consoleFollow: true,
};

/* ======================= Auth ======================= */
async function boot() {
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
  const pill = $('#status-pill');
  pill.className = 'status-pill ' + status.state;
  $('#status-text').textContent = STATE_LABEL[status.state] || status.state;

  const running = status.state === 'running' || status.state === 'starting';
  $('#btn-start').disabled = status.state !== 'stopped';
  $('#btn-stop').disabled = status.state === 'stopped';
  $('#btn-restart').disabled = status.state === 'stopped';
  $('#btn-kill').disabled = status.state === 'stopped';

  const up = $('#uptime-text');
  if (running && status.startedAt) {
    up.textContent = 'аптайм ' + fmtDuration((Date.now() - status.startedAt) / 1000);
  } else { up.textContent = ''; }

  if (State.view === 'dashboard') updateDashStatusCard();
}

function updateStats(msg) {
  State.stats = msg;
  updateStatus(msg.server);
  // sidebar mini
  const sys = msg.system;
  if (sys) {
    $('#sys-mini').innerHTML =
      `<b>CPU</b> ${sys.cpuPercent}% &nbsp; <b>RAM</b> ${sys.memPercent}%<br>` +
      `<b>Хост</b> ${esc(sys.hostname)}`;
  }
  if (State.view === 'dashboard') updateDashStats(msg);
}

/* ======================= Console ======================= */
function lineClass(stream) {
  return stream === 'err' ? 'err' : stream === 'sys' ? 'sys' : stream === 'in' ? 'in' : stream === 'warn' ? 'warn' : '';
}
function renderConsoleHistory(lines) {
  const box = $('#console');
  if (!box) return;
  box.innerHTML = (lines || []).map((e) => `<span class="ln ${lineClass(e.stream)}">${esc(e.line)}</span>`).join('');
  box.scrollTop = box.scrollHeight;
}
function appendConsole(entry) {
  if (!State.history) State.history = [];
  State.history.push(entry);
  if (State.history.length > 400) State.history.shift();
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
const VIEWS = ['dashboard', 'files', 'backups', 'timers', 'settings'];
function router() {
  let view = (location.hash.replace('#/', '') || 'dashboard').split('/')[0];
  if (!VIEWS.includes(view)) view = 'dashboard';
  State.view = view;
  $$('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  const c = $('#content');
  if (view === 'dashboard') renderDashboard(c);
  else if (view === 'files') renderFiles(c);
  else if (view === 'backups') renderBackups(c);
  else if (view === 'timers') renderTimers(c);
  else if (view === 'settings') renderSettings(c);
}

/* ======================= Dashboard ======================= */
function renderDashboard(c) {
  c.innerHTML = `
    <div class="page-head"><div><h1>Панель</h1><p>Состояние сервера и живая консоль</p></div></div>
    <div class="grid grid-stats" style="margin-bottom:16px">
      <div class="card"><div class="stat"><div class="stat-label">Статус</div><div class="stat-value" id="d-status">—</div><div class="dim" id="d-status-sub"></div></div></div>
      <div class="card"><div class="stat"><div class="stat-label">CPU сервера</div><div class="stat-value" id="d-cpu">0<small> ядр</small></div><div class="bar" id="d-cpu-bar"><span style="width:0"></span></div></div></div>
      <div class="card"><div class="stat"><div class="stat-label">RAM сервера</div><div class="stat-value" id="d-mem">0<small> МБ</small></div><div class="bar" id="d-mem-bar"><span style="width:0"></span></div></div></div>
      <div class="card"><div class="stat"><div class="stat-label">RAM системы</div><div class="stat-value" id="d-sysmem">0<small>%</small></div><div class="bar" id="d-sysmem-bar"><span style="width:0"></span></div></div></div>
    </div>
    <div class="card">
      <div class="card-title-row">
        <h3>Консоль сервера</h3>
        <div class="pill-row">
          <button class="btn btn-sm btn-ghost" id="c-clear">Очистить вид</button>
        </div>
      </div>
      <div class="console-wrap">
        <div class="console" id="console"></div>
        <div class="console-input">
          <input type="text" id="cmd-input" placeholder="Введите команду сервера и нажмите Enter…" autocomplete="off" />
          <button class="btn btn-primary" id="cmd-send">Отправить</button>
        </div>
      </div>
    </div>`;

  renderConsoleHistory(State.history || []);
  const input = $('#cmd-input');
  const send = () => {
    const v = input.value.trim();
    if (!v) return;
    wsSend({ type: 'command', command: v });
    input.value = '';
  };
  $('#cmd-send').onclick = send;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  $('#c-clear').onclick = () => { $('#console').innerHTML = ''; };

  updateDashStatusCard();
  if (State.stats) updateDashStats(State.stats);
}

function updateDashStatusCard() {
  const el = $('#d-status');
  if (!el) return;
  el.textContent = STATE_LABEL[State.status.state] || State.status.state;
  const sub = $('#d-status-sub');
  if (State.status.state !== 'stopped' && State.status.startedAt) {
    sub.textContent = 'PID ' + (State.status.pid || '—') + ' • ' + fmtDuration((Date.now() - State.status.startedAt) / 1000);
  } else sub.textContent = '';
}
function setBar(id, pct, valId, valText) {
  const bar = $('#' + id);
  if (!bar) return;
  const span = bar.querySelector('span');
  span.style.width = Math.min(100, pct) + '%';
  bar.className = 'bar' + (pct > 90 ? ' danger' : pct > 70 ? ' warn' : '');
  if (valId) $('#' + valId).innerHTML = valText;
}
function updateDashStats(msg) {
  const p = msg.process || {};
  const s = msg.system || {};
  const sv = msg.server || State.status || {};
  const maxRam = (State.settings && State.settings.server && State.settings.server.maxRamMB) || s.memTotalMB || 1;
  // Effective allocated cores: cpuCores limit if set, else all host cores.
  const effCores = (sv.cpuCores && sv.cpuCores > 0) ? sv.cpuCores : (sv.totalCores || s.cpuCount || 1);
  const coresUsed = (p.cpu || 0) / 100; // p.cpu is % of a single core
  setBar('d-cpu-bar', (coresUsed / effCores) * 100, 'd-cpu', `${coresUsed.toFixed(1)}<small> / ${effCores} ${effCores === 1 ? 'ядро' : 'ядр'}</small>`);
  setBar('d-mem-bar', ((p.memMB || 0) / maxRam) * 100, 'd-mem', `${p.memMB || 0}<small> МБ</small>`);
  setBar('d-sysmem-bar', s.memPercent || 0, 'd-sysmem', `${s.memPercent || 0}<small>%</small>`);
  updateDashStatusCard();
}

/* ======================= Files ======================= */
const Files = { cwd: '' };
async function renderFiles(c) {
  c.innerHTML = `
    <div class="page-head"><div><h1>Файлы</h1><p>Файловый менеджер директории сервера — перетащите файлы или папки для загрузки</p></div></div>
    <div class="card" id="f-card">
      <div class="dropzone-hint" id="f-drop-hint">⭱ Отпустите, чтобы загрузить в текущую папку</div>
      <div class="toolbar">
        <button class="btn btn-sm" id="f-up">↑ Вверх</button>
        <button class="btn btn-sm" id="f-refresh">⟳ Обновить</button>
        <div class="spacer"></div>
        <button class="btn btn-sm" id="f-newfile">＋ Файл</button>
        <button class="btn btn-sm" id="f-newdir">＋ Папка</button>
        <button class="btn btn-sm" id="f-uploaddir">⭱ Папка</button>
        <button class="btn btn-sm btn-primary" id="f-upload">⭱ Файлы</button>
        <input type="file" id="f-file" multiple class="hidden" />
        <input type="file" id="f-filedir" webkitdirectory directory multiple class="hidden" />
      </div>
      <div class="breadcrumb" id="f-crumbs"></div>
      <div id="f-list"></div>
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
    // webkitRelativePath keeps folder structure (e.g. "world/region/r.0.0.mca").
    const items = Array.from(e.target.files).map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
    if (items.length) uploadItems(items);
    e.target.value = '';
  };
  setupDropzone($('#f-card'));
  loadFiles(Files.cwd);
}

// Drag-and-drop upload (files and whole folders).
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
    // webkitGetAsEntry must be read synchronously during the drop event.
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

// Recursively read a dropped FileSystemEntry into {file, path} items.
function walkEntry(entry, prefix, out) {
  return new Promise((resolve) => {
    if (!entry) return resolve();
    if (entry.isFile) {
      entry.file(
        (f) => { out.push({ file: f, path: prefix + entry.name }); resolve(); },
        () => resolve()
      );
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const acc = [];
      const readBatch = () => reader.readEntries(async (batch) => {
        if (!batch.length) {
          for (const child of acc) await walkEntry(child, prefix + entry.name + '/', out);
          resolve();
        } else {
          acc.push(...batch);
          readBatch();
        }
      }, () => resolve());
      readBatch();
    } else {
      resolve();
    }
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
  let html = `<a data-p="">🗀 сервер</a>`;
  for (const part of parts) {
    acc += (acc ? '/' : '') + part;
    html += `<span class="sep">/</span><a data-p="${esc(acc)}">${esc(part)}</a>`;
  }
  const box = $('#f-crumbs');
  box.innerHTML = html;
  $$('a', box).forEach((a) => (a.onclick = () => loadFiles(a.dataset.p)));
}
function openEntry(type, path, name, editable) {
  if (type === 'dir') loadFiles(path);
  else if (editable) editFile(path, name);
  else window.open(API.downloadUrl(path));
}

function renderFileList(entries) {
  closeKebab(); // drop any open menu when the list re-renders (navigation/refresh)
  const box = $('#f-list');
  if (!entries.length) { box.innerHTML = `<div class="empty">Папка пуста</div>`; return; }
  box.innerHTML = `<table class="table"><thead><tr><th>Имя</th><th class="nowrap">Размер</th><th class="nowrap">Изменён</th><th></th></tr></thead><tbody>${
    entries.map((e) => {
      const icon = e.type === 'dir' ? '<span class="fi dir">🗀</span>' : '<span class="fi file">🗎</span>';
      return `<tr data-path="${esc(e.path)}" data-type="${e.type}" data-editable="${e.editable}" data-name="${esc(e.name)}">
        <td><div class="fname">${icon}<span class="lnk" style="cursor:pointer">${esc(e.name)}</span></div></td>
        <td class="dim nowrap">${e.type === 'dir' ? '—' : fmtBytes(e.size)}</td>
        <td class="dim nowrap">${e.modified ? fmtDate(e.modified) : '—'}</td>
        <td class="actions"><button class="kebab-btn" title="Действия">⋮</button></td></tr>`;
    }).join('')
  }</tbody></table>`;

  $$('tr[data-path]', box).forEach((tr) => {
    const path = tr.dataset.path, type = tr.dataset.type, name = tr.dataset.name, editable = tr.dataset.editable === 'true';
    // Single click on the name, or double click on the row, opens the entry
    // (folders navigate in, editable files open in the editor). Pterodactyl-style.
    $('.lnk', tr).onclick = () => openEntry(type, path, name, editable);
    tr.ondblclick = (ev) => { if (ev.target.closest('.kebab-btn') || ev.target.closest('.kebab-menu')) return; openEntry(type, path, name, editable); };
    // Kebab (⋮) actions menu on the right.
    $('.kebab-btn', tr).onclick = (ev) => {
      ev.stopPropagation();
      const actions = [];
      if (type === 'dir') actions.push({ label: 'Открыть', icon: '🗀', onClick: () => loadFiles(path) });
      if (editable) actions.push({ label: 'Редактировать', icon: '✎', onClick: () => editFile(path, name) });
      actions.push({ label: type === 'dir' ? 'Скачать (.tar.gz)' : 'Скачать', icon: '⭳', onClick: () => window.open(API.downloadUrl(path)) });
      actions.push({ label: 'Переименовать', icon: '✏', onClick: () => renameEntry(path, name) });
      actions.push({ label: 'Удалить', icon: '🗑', danger: true, onClick: () => deleteEntry(path, name) });
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
  actions.forEach((a, i) => {
    menu.querySelector(`[data-i="${i}"]`).onclick = () => { closeKebab(); a.onClick(); };
  });
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
      body: `<textarea class="editor" id="ed-area" spellcheck="false"></textarea>`,
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
    body: `<div class="field"><label>Имя</label><input id="ne-name" placeholder="${isDir ? 'папка' : 'файл.txt'}" /></div>`,
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
    body: `<div class="field"><label>Новое имя</label><input id="rn-name" value="${esc(name)}" /></div>`,
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
    <div class="page-head">
      <div><h1>Бэкапы</h1><p>Резервные копии всей директории сервера (.tar.gz)</p></div>
      <button class="btn btn-primary" id="b-create">＋ Создать бэкап</button>
    </div>
    <div id="b-list" class="card"><div class="empty">Загрузка…</div></div>
    <div class="card section-gap">
      <h3>Настройки хранения</h3>
      <div class="field-row">
        <div class="field"><label>Хранить последних копий</label><input type="number" id="b-max" min="0" /><div class="hint">0 = без ограничения. Старые удаляются автоматически.</div></div>
        <div class="field"><label>Исключения (через запятую)</label><input type="text" id="b-exclude" /><div class="hint">Папки/файлы, не попадающие в бэкап.</div></div>
      </div>
      <button class="btn btn-primary btn-sm" id="b-save">Сохранить настройки</button>
    </div>`;
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
    if (!data.backups.length) { box.innerHTML = `<div class="empty">Бэкапов пока нет</div>`; return; }
    box.innerHTML = `<table class="table"><thead><tr><th>Имя</th><th class="nowrap">Размер</th><th class="nowrap">Создан</th><th></th></tr></thead><tbody>${
      data.backups.map((b) => `<tr>
        <td class="mono">${esc(b.name)}</td>
        <td class="dim nowrap">${fmtBytes(b.size)}</td>
        <td class="dim nowrap">${fmtDate(b.created)}</td>
        <td class="actions" data-name="${esc(b.name)}">
          <button class="btn btn-sm" data-a="download">⭳</button>
          <button class="btn btn-sm btn-warn" data-a="restore">↺ Восстановить</button>
          <button class="btn btn-sm btn-danger" data-a="delete">🗑</button>
        </td></tr>`).join('')
    }</tbody></table>`;
    $$('td.actions', box).forEach((td) => {
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
    body: `<div class="field"><label>Метка (необязательно)</label><input id="bk-label" placeholder="например, before-update" /></div>
           <p class="dim" style="margin:0">Будет создан .tar.gz всей директории сервера. Можно делать и на запущенном сервере.</p>`,
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
    <div class="page-head">
      <div><h1>Таймеры</h1><p>Плановые задачи: рестарты, бэкапы, команды по расписанию</p></div>
      <button class="btn btn-primary" id="t-add">＋ Новая задача</button>
    </div>
    <div id="t-list" class="card"><div class="empty">Загрузка…</div></div>`;
  $('#t-add').onclick = () => taskDialog(null);
  await loadTasks();
}
async function loadTasks() {
  try {
    const data = await API.tasks();
    const box = $('#t-list');
    if (!data.tasks.length) { box.innerHTML = `<div class="empty">Задач пока нет. Добавьте, например, ежедневный рестарт в 05:00.</div>`; return; }
    box.innerHTML = `<table class="table"><thead><tr><th>Задача</th><th>Расписание</th><th>Действие</th><th class="nowrap">Следующий запуск</th><th></th></tr></thead><tbody>${
      data.tasks.map((t) => {
        const sched = t.type === 'interval' ? `каждые ${t.intervalMinutes} мин` : `ежедневно в ${t.time}`;
        return `<tr data-id="${t.id}">
          <td><b>${esc(t.name)}</b> ${t.enabled ? '<span class="badge on">вкл</span>' : '<span class="badge off">выкл</span>'}
              ${t.action === 'command' ? `<div class="dim mono">${esc(t.command)}</div>` : ''}</td>
          <td>${sched}</td>
          <td>${ACTION_LABEL[t.action] || t.action}</td>
          <td class="dim nowrap">${t.enabled ? fmtDate(t.nextRun) : '—'}</td>
          <td class="actions">
            <button class="btn btn-sm" data-a="edit">✎</button>
            <button class="btn btn-sm btn-danger" data-a="del">🗑</button>
          </td></tr>`;
      }).join('')
    }</tbody></table>`;
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
    title: task ? 'Изменить задачу' : 'Новая задача', wide: false,
    body: `
      <div class="field"><label>Название</label><input id="tk-name" value="${esc(t.name)}" placeholder="Ночной рестарт" /></div>
      <div class="field-row">
        <div class="field"><label>Тип расписания</label>
          <select id="tk-type"><option value="daily">Ежедневно в указанное время</option><option value="interval">Через интервал</option></select>
        </div>
        <div class="field"><label>Действие</label>
          <select id="tk-action">
            <option value="restart">Перезапуск</option><option value="stop">Остановка</option>
            <option value="start">Запуск</option><option value="backup">Бэкап</option><option value="command">Команда</option>
          </select>
        </div>
      </div>
      <div class="field-row">
        <div class="field" id="tk-time-wrap"><label>Время (ЧЧ:ММ)</label><input id="tk-time" type="time" value="${esc(t.time)}" /></div>
        <div class="field" id="tk-interval-wrap"><label>Интервал (минут)</label><input id="tk-interval" type="number" min="1" value="${t.intervalMinutes}" /></div>
      </div>
      <div class="field" id="tk-command-wrap"><label>Команда сервера</label><input id="tk-command" value="${esc(t.command)}" placeholder="say Привет" /></div>
      <div class="field-row" id="tk-warn-wrap">
        <div class="field"><label>Предупредить командой (для рестарт/стоп)</label><input id="tk-warn" value="${esc(t.warn)}" /></div>
        <div class="field"><label>За сколько секунд</label><input id="tk-warnsec" type="number" min="0" value="${t.warnSeconds}" /></div>
      </div>
      <label class="switch"><input type="checkbox" id="tk-enabled" ${t.enabled ? 'checked' : ''}/><span class="track"></span> Задача включена</label>
    `,
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

/* ======================= Settings ======================= */
let settingsTab = 'server';
async function renderSettings(c) {
  c.innerHTML = `
    <div class="page-head"><div><h1>Настройки</h1><p>Сервер, порты, фаервол и панель</p></div></div>
    <div class="tabs">
      <div class="tab" data-t="server">Сервер и ОЗУ</div>
      <div class="tab" data-t="properties">server.properties</div>
      <div class="tab" data-t="firewall">Фаервол</div>
      <div class="tab" data-t="panel">Панель</div>
    </div>
    <div id="settings-body"></div>`;
  $$('.tab', c).forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.t === settingsTab);
    tab.onclick = () => { settingsTab = tab.dataset.t; renderSettings(c); };
  });
  const body = $('#settings-body');
  if (settingsTab === 'server') renderServerSettings(body);
  else if (settingsTab === 'properties') renderProperties(body);
  else if (settingsTab === 'firewall') renderFirewall(body);
  else if (settingsTab === 'panel') renderPanelSettings(body);
}

async function renderServerSettings(body) {
  body.innerHTML = `<div class="empty">Загрузка…</div>`;
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
      <div class="card">
        <h3>Запуск и ресурсы</h3>
        <div class="field-row">
          <div class="field"><label>Директория сервера</label><input id="s-dir" value="${esc(s.directory)}" /></div>
          <div class="field"><label>JAR-файл</label><input id="s-jar" value="${esc(s.jar)}" /></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Мин. ОЗУ (МБ)</label><input id="s-minram" type="number" min="128" step="128" value="${s.minRamMB}" /><div class="hint">≈ ${(s.minRamMB/1024).toFixed(1)} ГБ</div></div>
          <div class="field"><label>Макс. ОЗУ (МБ)</label><input id="s-maxram" type="number" min="256" step="128" value="${s.maxRamMB}" /><div class="hint">≈ ${(s.maxRamMB/1024).toFixed(1)} ГБ</div></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Ограничение CPU (сколько vCPU выделить)</label>
            <select id="s-cpucores">${cpuOpts}</select>
            <div class="hint">${data.hasTaskset ? `Доступно ядер на сервере: ${totalCores}. Привязка к ядрам через taskset.` : '⚠ taskset недоступен на этой системе — ограничение CPU не применится.'}</div>
          </div>
          <div class="field"><label>&nbsp;</label><div class="dim" style="padding-top:9px;line-height:1.5">Сервер будет использовать не больше выбранного числа ядер. Требует перезапуска сервера.</div></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Путь к Java</label><input id="s-java" value="${esc(s.javaPath)}" /></div>
          <div class="field"><label>Команда остановки</label><input id="s-stopcmd" value="${esc(s.stopCommand)}" /></div>
        </div>
        <div class="field"><label>Доп. флаги JVM</label><input id="s-flags" value="${esc(s.jvmFlags)}" placeholder="-Dfile.encoding=UTF-8" /></div>
        <div class="field"><label>Своя команда запуска (переопределяет всё выше)</label><input id="s-custom" class="mono" value="${esc(s.customCommand)}" placeholder="оставьте пустым для стандартного запуска" /></div>
        <div class="pill-row" style="margin:8px 0 16px">
          <label class="switch"><input type="checkbox" id="s-aikar" ${s.useAikarFlags ? 'checked' : ''}/><span class="track"></span> Флаги Aikar (оптимизация GC)</label>
          <label class="switch"><input type="checkbox" id="s-autostart" ${s.autoStart ? 'checked' : ''}/><span class="track"></span> Автозапуск при старте панели</label>
          <label class="switch"><input type="checkbox" id="s-autorestart" ${s.autoRestart ? 'checked' : ''}/><span class="track"></span> Авто-перезапуск при падении</label>
        </div>
        <div class="field"><label>Предпросмотр команды запуска</label><div class="code-preview" id="s-preview">${esc(data.commandPreview)}</div></div>
        <div class="pill-row">
          <button class="btn btn-primary" id="s-save">Сохранить</button>
          <span class="badge ${st.eula ? 'on' : 'off'}">EULA: ${st.eula ? 'принято' : 'не принято'}</span>
          ${st.eula ? '' : '<button class="btn btn-sm btn-warn" id="s-eula">Принять EULA</button>'}
        </div>
      </div>`;
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
  } catch (err) { toastErr(err); body.innerHTML = `<div class="empty">Ошибка загрузки настроек</div>`; }
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
  body.innerHTML = `<div class="empty">Загрузка…</div>`;
  try {
    const data = await API.properties();
    if (!data.exists) {
      body.innerHTML = `<div class="card"><div class="empty">Файл server.properties не найден.<br>Он появится после первого запуска сервера.</div></div>`;
      return;
    }
    const props = data.properties;
    const known = new Set(COMMON_PROPS.map((p) => p[0]));
    const rows = COMMON_PROPS.map(([key, label]) => {
      const val = props[key] != null ? props[key] : '';
      const isBool = val === 'true' || val === 'false';
      const input = isBool
        ? `<label class="switch"><input type="checkbox" data-k="${key}" ${val === 'true' ? 'checked' : ''}/><span class="track"></span></label>`
        : `<input data-k="${key}" value="${esc(val)}" />`;
      return `<div class="field"><label>${label} <span class="dim mono">${key}</span></label>${input}</div>`;
    }).join('');
    const others = Object.keys(props).filter((k) => !known.has(k)).sort();
    body.innerHTML = `
      <div class="card">
        <div class="card-title-row"><h3>Основные параметры</h3><button class="btn btn-primary btn-sm" id="p-save">Сохранить</button></div>
        <div class="field-row">${rows}</div>
      </div>
      <div class="card section-gap">
        <h3>Все параметры (${others.length})</h3>
        <div id="p-others">${others.map((k) => `<div class="field"><label>${esc(k)}</label><input data-k="${esc(k)}" value="${esc(props[k])}" /></div>`).join('') || '<div class="dim">—</div>'}</div>
      </div>`;
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
  body.innerHTML = `<div class="empty">Загрузка…</div>`;
  try {
    const fw = await API.firewall();
    if (!fw.installed) {
      body.innerHTML = `<div class="card"><div class="empty">ufw не установлен на сервере.<br>Установите: <span class="mono">sudo apt install ufw</span></div></div>`;
      return;
    }
    body.innerHTML = `
      <div class="card">
        <div class="card-title-row">
          <h3>Фаервол (ufw) — <span class="badge ${fw.active ? 'on' : 'off'}">${fw.active ? 'активен' : 'выключен'}</span></h3>
          <div class="pill-row">
            ${fw.active ? '<button class="btn btn-sm btn-danger" id="fw-toggle">Выключить</button>' : '<button class="btn btn-sm btn-success" id="fw-toggle">Включить</button>'}
          </div>
        </div>
        <div class="toolbar">
          <input id="fw-port" type="number" placeholder="Порт (напр. 25565)" style="max-width:200px" />
          <select id="fw-proto" style="max-width:130px"><option value="both">tcp+udp</option><option value="tcp">tcp</option><option value="udp">udp</option></select>
          <button class="btn btn-sm btn-success" id="fw-allow">Разрешить</button>
          <button class="btn btn-sm btn-danger" id="fw-deny">Запретить</button>
        </div>
        <div id="fw-rules"></div>
        <div class="hint" style="margin-top:10px">⚠ Перед включением фаервола убедитесь, что разрешён порт SSH (обычно 22) и порт панели, иначе можно потерять доступ.</div>
      </div>`;
    renderFwRules(fw.rules);
    $('#fw-toggle').onclick = async () => {
      try { const r = fw.active ? await API.fwDisable() : await API.fwEnable(); toast('Готово', 'success'); renderFirewall(body); }
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
  if (!rules || !rules.length) { box.innerHTML = `<div class="empty">Нет правил</div>`; return; }
  box.innerHTML = `<table class="table"><thead><tr><th>Порт/адрес</th><th>Действие</th><th>Направление</th><th>Источник</th><th></th></tr></thead><tbody>${
    rules.map((r) => `<tr>
      <td class="mono">${esc(r.to)}</td>
      <td><span class="badge ${r.action === 'ALLOW' ? 'on' : 'off'}">${r.action}</span></td>
      <td class="dim">${esc(r.direction)}</td>
      <td class="dim">${esc(r.from)}</td>
      <td class="actions"><button class="btn btn-sm btn-danger" data-to="${esc(r.to)}" data-act="${r.action}">Удалить</button></td>
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
    body.innerHTML = `
      <div class="card">
        <h3>Сеть панели</h3>
        <div class="field-row">
          <div class="field"><label>Порт панели</label><input id="pn-port" type="number" value="${data.panel.port}" /><div class="hint">После изменения перезапустите панель: <span class="mono">systemctl restart minedeck</span></div></div>
          <div class="field"><label>Адрес привязки</label><input id="pn-host" value="${esc(data.panel.host)}" /><div class="hint">0.0.0.0 — доступ извне, 127.0.0.1 — только локально.</div></div>
        </div>
        <button class="btn btn-primary btn-sm" id="pn-save">Сохранить</button>
      </div>
      <div class="card section-gap">
        <h3>Смена пароля</h3>
        <div class="field-row">
          <div class="field"><label>Текущий пароль</label><input id="pw-cur" type="password" /></div>
          <div class="field"><label>Новый пароль</label><input id="pw-new" type="password" /></div>
        </div>
        <button class="btn btn-primary btn-sm" id="pw-save">Изменить пароль</button>
      </div>
      <div class="card section-gap">
        <div class="card-title-row"><h3>Обновление панели</h3><span class="badge neutral" id="upd-ver">…</span></div>
        <div id="upd-info" class="dim" style="margin-bottom:12px">Проверка версии…</div>
        <div class="pill-row">
          <button class="btn btn-sm" id="upd-check">Проверить обновления</button>
          <button class="btn btn-sm btn-primary hidden" id="upd-apply">⤓ Обновить сейчас</button>
        </div>
        <div class="hint" style="margin-top:10px">Обновление тянет последнюю версию из GitHub-репозитория и перезапускает панель. Настройки, бэкапы и вход сохраняются.</div>
      </div>
      <div class="card section-gap">
        <h3>О системе</h3>
        <table class="table">
          <tr><td>Версия панели</td><td class="right mono">${esc(sys.panelVersion)}</td></tr>
          <tr><td>Хост</td><td class="right">${esc(sys.system.hostname)}</td></tr>
          <tr><td>ОС</td><td class="right">${esc(sys.system.platform)} ${esc(sys.system.release)} (${esc(sys.system.arch)})</td></tr>
          <tr><td>CPU</td><td class="right">${esc(sys.system.cpuModel)} × ${sys.system.cpuCount}</td></tr>
          <tr><td>ОЗУ</td><td class="right">${(sys.system.memUsedMB/1024).toFixed(1)} / ${(sys.system.memTotalMB/1024).toFixed(1)} ГБ</td></tr>
          <tr><td>Диск (сервер)</td><td class="right">${sys.disk ? `${(sys.disk.usedMB/1024).toFixed(1)} / ${(sys.disk.totalMB/1024).toFixed(1)} ГБ (${sys.disk.percent}%)` : '—'}</td></tr>
          <tr><td>Java</td><td class="right mono">${esc(sys.java || 'не найдена')}</td></tr>
          <tr><td>Аптайм ОС</td><td class="right">${fmtDuration(sys.system.uptimeSec)}</td></tr>
        </table>
      </div>`;
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
      info.innerHTML = '⚠ Панель установлена не через git — авто-обновление недоступно. Используйте установщик <span class="mono">install.sh</span>.';
      checkBtn.disabled = true;
      return;
    }
    info.innerHTML = `Ветка <b>${esc(v.branch)}</b>, коммит <span class="mono">${esc(v.sha)}</span>` +
      (v.subject ? ` — ${esc(v.subject)}` : '') + (v.date ? `<br><span class="dim">${fmtDate(Date.parse(v.date))}</span>` : '');
  } catch (err) { info.textContent = 'Не удалось получить версию: ' + err.message; }

  checkBtn.onclick = async () => {
    checkBtn.disabled = true; const old = checkBtn.textContent; checkBtn.textContent = 'Проверка…';
    try {
      const r = await API.checkUpdate();
      if (r.upToDate) { info.innerHTML = '✅ Установлена последняя версия.'; applyBtn.classList.add('hidden'); }
      else {
        info.innerHTML = `⬆ Доступно обновление: отставание на <b>${r.behind}</b> коммит(ов).` +
          (r.latest ? `<br>Последний: <span class="mono">${esc(r.latest)}</span>` : '');
        applyBtn.classList.remove('hidden');
      }
    } catch (err) { toastErr(err); }
    finally { checkBtn.disabled = false; checkBtn.textContent = old; }
  };

  applyBtn.onclick = async () => {
    if (!(await confirmDialog('Обновить панель до последней версии из репозитория? Панель перезапустится на несколько секунд.', { okText: 'Обновить' }))) return;
    applyBtn.disabled = true;
    try {
      await API.applyUpdate();
      waitForRestart();
    } catch (err) { toastErr(err); applyBtn.disabled = false; }
  };
}

// Show an overlay and poll health until the panel comes back after an update.
function waitForRestart() {
  const m = openModal({
    title: 'Обновление панели',
    body: `<p style="margin:0 0 10px;line-height:1.6">Панель обновляется и перезапускается.<br>Страница обновится автоматически, когда сервис снова станет доступен…</p>
           <div class="bar"><span id="upd-bar" style="width:10%"></span></div>`,
  });
  // hide the close button — this is a blocking operation
  const closeBtn = $('.modal-close', m.root); if (closeBtn) closeBtn.style.display = 'none';
  let seenDown = false, tries = 0;
  const bar = $('#upd-bar', m.root);
  const timer = setInterval(async () => {
    tries++;
    if (bar) bar.style.width = Math.min(90, 10 + tries * 4) + '%';
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (!res.ok) { seenDown = true; return; }
      // Require having seen it go down first, OR enough time passed, to avoid reloading before restart.
      if (seenDown || tries > 6) { clearInterval(timer); if (bar) bar.style.width = '100%'; setTimeout(() => location.reload(), 600); }
    } catch (_) {
      seenDown = true; // service is restarting
    }
    if (tries > 90) { clearInterval(timer); location.reload(); }
  }, 1500);
}

/* ======================= Go ======================= */
boot();
