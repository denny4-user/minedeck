'use strict';

// MCP tools, resources and prompts. Everything is built on the same modules the
// web UI uses, so validation, path sandboxing and background jobs behave the
// same for the panel and for AI clients.

const fs = require('fs');
const path = require('path');
const { z } = require('zod');
const config = require('./config');
const mcserver = require('./mcserver');
const system = require('./system');
const files = require('./files');
const archives = require('./archives');
const backups = require('./backups');
const scheduler = require('./scheduler');
const properties = require('./properties');
const serverSettings = require('./serverSettings');
const firewall = require('./firewall');
const databases = require('./databases');

const RO = { readOnlyHint: true, openWorldHint: false };
const change = (destructiveHint, idempotentHint = false) => ({
  readOnlyHint: false, destructiveHint, idempotentHint, openWorldHint: false,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : fallback));
};
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

function json(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function fail(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Mutating calls are echoed into the panel console so the owner sees what an AI did.
function audit(tool, detail) {
  mcserver.pushLine(`[MCP] ${tool}${detail ? ` → ${detail}` : ''}`, 'sys');
}

function recentLog(n) {
  return mcserver.getHistory().slice(-n).map((e) => e.line).join('\n');
}

function compileRegex(source) {
  try { return new RegExp(source, 'i'); } catch (_) { return null; }
}

// Resolve when the server reaches one of `targets`; resolves true on timeout.
function waitForState(targets, deadline) {
  return new Promise((resolve) => {
    if (targets.includes(mcserver.state)) return resolve(false);
    let timer;
    const onStatus = (s) => { if (targets.includes(s.state)) finish(false); };
    function finish(timedOut) {
      clearTimeout(timer);
      mcserver.off('status', onStatus);
      resolve(timedOut);
    }
    mcserver.on('status', onStatus);
    timer = setTimeout(() => finish(true), Math.max(0, deadline - Date.now()));
  });
}

// Resolve with match(entry) for the first new console line it accepts, or null on timeout.
function waitForOutput(match, timeoutMs, start) {
  return new Promise((resolve) => {
    let timer;
    const finish = (value) => {
      clearTimeout(timer);
      mcserver.off('output', onOutput);
      resolve(value);
    };
    const onOutput = (entry) => {
      const value = match(entry);
      if (value) finish(value);
    };
    mcserver.on('output', onOutput);
    timer = setTimeout(() => finish(null), timeoutMs);
    if (start) {
      try { start(); } catch (err) { finish({ error: err.message }); }
    }
  });
}

async function pollJob(getJob, waitSec) {
  const deadline = Date.now() + waitSec * 1000;
  let job = getJob();
  while (job && job.status === 'running' && Date.now() < deadline) {
    await sleep(500);
    job = getJob();
  }
  return job;
}

function backupJobView(jobId, job) {
  if (!job) return { jobId, status: 'unknown', note: 'Задача не найдена — вероятно, завершилась более 5 минут назад. Проверьте backups_list.' };
  return {
    jobId,
    status: job.status,
    phase: job.phase,
    percent: job.totalBytes > 0 ? Math.min(100, Math.round((job.bytesDone / job.totalBytes) * 100)) : null,
    files: job.files,
    bytesDone: job.bytesDone,
    totalBytes: job.totalBytes,
    archiveBytes: job.archiveBytes,
    name: job.name || null,
    error: job.error || null,
    ...(job.status === 'running' ? { note: 'Бэкап ещё создаётся — проверьте позже через backup_status.' } : {}),
  };
}

function extractJobView(jobId, job) {
  if (!job) return { jobId, status: 'unknown', note: 'Задача не найдена — вероятно, завершилась более 5 минут назад.' };
  return {
    jobId,
    status: job.status,
    name: job.name,
    extracted: job.extracted,
    total: job.total || null,
    error: job.error || null,
    ...(job.status === 'running' ? { note: 'Распаковка ещё идёт — проверьте позже через extract_status.' } : {}),
  };
}

function parseListLine(line) {
  const m = /There are (\d+) (?:of a max(?: of)?|out of maximum) (\d+) players online[.:]?\s*(.*)$/i.exec(line);
  if (!m) return null;
  return { online: Number(m[1]), max: Number(m[2]), players: m[3].split(',').map((s) => s.trim()).filter(Boolean) };
}

const DB_NAME = z.string().regex(/^[a-zA-Z0-9_]{1,32}$/).describe('Имя базы: латиница, цифры, _ (до 32 символов)');
const JOB_ID = z.string().min(1).max(64);
const REL_PATH = z.string().min(1).max(1000);

const TASK_FIELDS = {
  name: 'name', type: 'type', action: 'action', interval_minutes: 'intervalMinutes', time: 'time',
  command: 'command', warn: 'warn', warn_seconds: 'warnSeconds', enabled: 'enabled',
};
const SETTINGS_FIELDS = {
  jar: 'jar', java_path: 'javaPath', min_ram_mb: 'minRamMB', max_ram_mb: 'maxRamMB', cpu_cores: 'cpuCores',
  jvm_flags: 'jvmFlags', use_aikar_flags: 'useAikarFlags', custom_command: 'customCommand',
  stop_command: 'stopCommand', stop_timeout_sec: 'stopTimeoutSec', auto_start: 'autoStart', auto_restart: 'autoRestart',
};

// Map snake_case tool args to the camelCase fields the modules expect, keeping
// only keys that were actually provided (undefined would override stored values).
function pickMapped(args, fields) {
  const out = {};
  for (const [from, to] of Object.entries(fields)) {
    if (args[from] !== undefined) out[to] = args[from];
  }
  return out;
}

function taskView(t) {
  return {
    id: t.id, name: t.name, enabled: t.enabled, type: t.type, action: t.action,
    intervalMinutes: t.intervalMinutes, time: t.time, command: t.command,
    warn: t.warn, warnSeconds: t.warnSeconds, nextRun: iso(t.nextRun),
  };
}

const DIAGNOSE_PROMPT = `Проведи диагностику Minecraft-сервера через инструменты MineDeck:
1. server_status — состояние, нагрузка процесса, предупреждения по команде запуска.
2. console_logs с filter "error|exception|warn|crash|outofmemory|killed" и отдельно последние 150 строк.
3. Если сервер падал — найди причину: нехватка памяти (OOM), неверные флаги JVM, ошибки модов/плагинов, порт занят.
4. server_settings_get — сравни выделенную ОЗУ с памятью машины; system_info — место на диске.
Дай краткий вывод: что не так и что конкретно исправить. Ничего не меняй без моего подтверждения.`;

function safeRestartPrompt(seconds) {
  return `Безопасно перезапусти Minecraft-сервер через инструменты MineDeck:
1. players_online — кто сейчас в игре.
2. Если игроки есть — console_send_command "say Сервер перезапустится через ${seconds} секунд" и подожди ${seconds} секунд.
3. backup_create с label "pre-restart"; дождись статуса done (backup_status, если вернулся job_id). Если бэкап не удался — остановись и сообщи мне.
4. server_restart с wait_ready=true.
5. Проверь server_status и console_logs (filter "error|exception") и коротко отчитайся.`;
}

function registerAll(server, { readOnly = false } = {}) {
  const counts = { tools: 0, resources: 0, prompts: 0 };

  const tool = (name, def, handler) => {
    if (readOnly && !def.annotations.readOnlyHint) return;
    counts.tools++;
    server.registerTool(name, def, async (args) => {
      try {
        return await handler(args || {});
      } catch (err) {
        return fail(`Ошибка: ${err.message}`);
      }
    });
  };

  // ---- Server & console ---------------------------------------------------
  tool('server_status', {
    title: 'Статус сервера',
    description: 'Состояние Minecraft-сервера (stopped/starting/running/stopping), PID, аптайм, принято ли EULA, команда запуска и предупреждения по ней, нагрузка процесса (cpu — % от одного ядра, память в МБ), системные CPU/RAM и заполненность диска.',
    inputSchema: {},
    annotations: RO,
  }, async () => {
    // CPU figures are deltas between samples — take two, half a second apart.
    system.systemCpuPercent();
    if (mcserver.pid) system.processStats(mcserver.pid);
    await sleep(500);
    const st = mcserver.status();
    const sys = system.systemInfo();
    return json({
      state: st.state,
      pid: st.pid,
      startedAt: iso(st.startedAt),
      uptimeSec: st.startedAt ? Math.round((Date.now() - st.startedAt) / 1000) : 0,
      eulaAccepted: mcserver.eulaAccepted(),
      command: st.command,
      commandWarnings: mcserver.commandWarnings(st.command),
      cpuLimitCores: st.cpuCores || 'все',
      totalCores: st.totalCores,
      process: system.processStats(mcserver.pid),
      system: { cpuPercent: sys.cpuPercent, memPercent: sys.memPercent, memUsedMB: sys.memUsedMB, memTotalMB: sys.memTotalMB, loadavg: sys.loadavg },
      disk: await system.diskUsage(config.get().server.directory),
    });
  });

  tool('server_start', {
    title: 'Запустить сервер',
    description: 'Запускает Minecraft-сервер (нужны принятое EULA и JAR-файл либо своя команда запуска). С wait_ready=true ждёт полной загрузки (строка «Done … For help») или падения процесса.',
    inputSchema: {
      wait_ready: z.boolean().optional().describe('Дождаться полной загрузки сервера'),
      timeout_sec: z.number().int().min(5).max(110).optional().describe('Сколько ждать при wait_ready (по умолчанию 100)'),
    },
    annotations: change(false),
  }, async ({ wait_ready, timeout_sec }) => {
    audit('server_start');
    mcserver.start();
    if (!wait_ready) {
      return json({ ok: true, state: mcserver.state, note: 'Сервер запускается. Готовность — server_status или console_wait_for с шаблоном "Done \\(".' });
    }
    const timedOut = await waitForState(['running', 'stopped'], Date.now() + clamp(timeout_sec, 5, 110, 100) * 1000);
    if (mcserver.state === 'running') return json({ ok: true, state: 'running' });
    if (timedOut) return json({ ok: true, state: mcserver.state, note: 'Время ожидания истекло — сервер ещё загружается.' });
    return fail(`Сервер остановился во время запуска.\n\nПоследние строки консоли:\n${recentLog(25)}`);
  });

  tool('server_stop', {
    title: 'Остановить сервер',
    description: 'Корректно останавливает сервер командой остановки (мир сохраняется). Если процесс не завершится за настроенный таймаут, панель завершит его принудительно.',
    inputSchema: {
      wait: z.boolean().optional().describe('Дождаться полной остановки (по умолчанию true)'),
      timeout_sec: z.number().int().min(5).max(110).optional().describe('По умолчанию 90'),
    },
    annotations: change(true, true),
  }, async ({ wait, timeout_sec }) => {
    if (mcserver.state === 'stopped') return json({ ok: true, state: 'stopped', note: 'Сервер уже остановлен.' });
    audit('server_stop');
    mcserver.stop();
    if (wait === false) return json({ ok: true, state: mcserver.state });
    const timedOut = await waitForState(['stopped'], Date.now() + clamp(timeout_sec, 5, 110, 90) * 1000);
    return json({ ok: !timedOut, state: mcserver.state, ...(timedOut ? { note: 'Сервер ещё останавливается.' } : {}) });
  });

  tool('server_restart', {
    title: 'Перезапустить сервер',
    description: 'Корректно перезапускает сервер (если остановлен — просто запускает). С wait_ready=true ждёт полной загрузки после перезапуска.',
    inputSchema: {
      wait_ready: z.boolean().optional().describe('Дождаться полной загрузки после перезапуска'),
      timeout_sec: z.number().int().min(10).max(110).optional().describe('Общее время ожидания (по умолчанию 110)'),
    },
    annotations: change(true),
  }, async ({ wait_ready, timeout_sec }) => {
    audit('server_restart');
    const deadline = Date.now() + clamp(timeout_sec, 10, 110, 110) * 1000;
    const wasRunning = mcserver.state !== 'stopped';
    mcserver.restart();
    if (!wait_ready) return json({ ok: true, state: mcserver.state });
    if (wasRunning) {
      await waitForState(['stopped'], deadline);
      // The pending restart fires shortly after the process exits.
      await waitForState(['starting', 'running'], Math.min(deadline, Date.now() + 10000));
    }
    await waitForState(['running', 'stopped'], deadline);
    if (mcserver.state === 'running') return json({ ok: true, state: 'running' });
    if (mcserver.state === 'stopped') return fail(`Сервер не поднялся после перезапуска.\n\nПоследние строки консоли:\n${recentLog(25)}`);
    return json({ ok: true, state: mcserver.state, note: 'Время ожидания истекло — сервер ещё загружается.' });
  });

  tool('server_kill', {
    title: 'Принудительно завершить сервер',
    description: 'Мгновенно убивает процесс сервера (SIGKILL) без сохранения мира. Только если сервер завис и не реагирует на server_stop — возможна потеря данных.',
    inputSchema: {},
    annotations: change(true, true),
  }, async () => {
    if (mcserver.state === 'stopped') return json({ ok: true, state: 'stopped', note: 'Сервер не запущен.' });
    audit('server_kill');
    mcserver.kill();
    await waitForState(['stopped'], Date.now() + 5000);
    return json({ ok: true, state: mcserver.state });
  });

  tool('server_accept_eula', {
    title: 'Принять EULA',
    description: 'Принимает лицензионное соглашение Minecraft (eula=true в eula.txt). Без этого сервер не запустится.',
    inputSchema: {},
    annotations: change(false, true),
  }, async () => {
    audit('server_accept_eula');
    mcserver.acceptEula();
    return json({ ok: true, eulaAccepted: true });
  });

  tool('console_send_command', {
    title: 'Команда в консоль',
    description: 'Отправляет одну команду в консоль сервера (без ведущего «/», например "say Привет" или "whitelist add Steve") и возвращает строки вывода за wait_ms. Сервер должен быть запущен.',
    inputSchema: {
      command: z.string().min(1).max(1000).describe('Команда без ведущего слэша'),
      wait_ms: z.number().int().min(0).max(15000).optional().describe('Сколько собирать вывод, мс (по умолчанию 1500)'),
    },
    annotations: change(true),
  }, async ({ command, wait_ms }) => {
    const cmd = command.trim().replace(/^\//, '');
    if (!cmd) return fail('Пустая команда.');
    if (/[\r\n]/.test(cmd)) return fail('Команда не должна содержать переводов строки — отправляйте команды по одной.');
    audit('console_send_command');
    const lines = [];
    const onOutput = (e) => { if (e.stream !== 'in') lines.push(e.line); };
    mcserver.on('output', onOutput);
    try {
      mcserver.writeCommand(cmd);
      await sleep(clamp(wait_ms, 0, 15000, 1500));
    } finally {
      mcserver.off('output', onOutput);
    }
    return json({ sent: cmd, output: lines });
  });

  tool('console_logs', {
    title: 'Логи консоли',
    description: 'Последние строки консоли сервера (буфер панели — до 400 строк) со временем и потоком (out/err/in/sys). Можно отфильтровать регулярным выражением.',
    inputSchema: {
      lines: z.number().int().min(1).max(400).optional().describe('Сколько последних строк (по умолчанию 100)'),
      filter: z.string().max(200).optional().describe('Регулярное выражение, без учёта регистра'),
    },
    annotations: RO,
  }, async ({ lines, filter }) => {
    let hist = mcserver.getHistory();
    if (filter) {
      const re = compileRegex(filter);
      if (!re) return fail('Некорректное регулярное выражение в filter.');
      hist = hist.filter((e) => re.test(e.line));
    }
    hist = hist.slice(-clamp(lines, 1, 400, 100));
    if (!hist.length) return json('(нет строк)');
    return json(hist.map((e) => `${iso(e.t)} [${e.stream}] ${e.line}`).join('\n'));
  });

  tool('console_wait_for', {
    title: 'Ждать строку в консоли',
    description: 'Ждёт появления НОВОЙ строки консоли, подходящей под регулярное выражение (например "Done \\(" после запуска или "joined the game"). Возвращает найденную строку или сообщает об истечении времени.',
    inputSchema: {
      pattern: z.string().min(1).max(200).describe('Регулярное выражение, без учёта регистра'),
      timeout_sec: z.number().int().min(1).max(110).optional().describe('По умолчанию 60'),
    },
    annotations: RO,
  }, async ({ pattern, timeout_sec }) => {
    const re = compileRegex(pattern);
    if (!re) return fail('Некорректное регулярное выражение.');
    const found = await waitForOutput((e) => (re.test(e.line) ? e : null), clamp(timeout_sec, 1, 110, 60) * 1000);
    if (!found) return json({ matched: false, note: 'Время ожидания истекло.', state: mcserver.state });
    return json({ matched: true, line: found.line, stream: found.stream, time: iso(found.t) });
  });

  tool('players_online', {
    title: 'Игроки онлайн',
    description: 'Список игроков на сервере (выполняет стандартную команду list). Сервер должен быть запущен.',
    inputSchema: {},
    annotations: RO,
  }, async () => {
    if (mcserver.state !== 'running') return fail(`Сервер не запущен (состояние: ${mcserver.state}).`);
    const result = await waitForOutput((e) => parseListLine(e.line), 3000, () => mcserver.writeCommand('list'));
    if (!result) return fail('Сервер не ответил на команду list за 3 секунды.');
    if (result.error) return fail(result.error);
    return json(result);
  });

  // ---- Files --------------------------------------------------------------
  tool('files_list', {
    title: 'Список файлов',
    description: 'Содержимое папки внутри директории сервера. Пути относительные: "" — корень сервера, например "world" или "config".',
    inputSchema: { path: z.string().max(1000).optional().describe('Путь к папке (по умолчанию корень)') },
    annotations: RO,
  }, async ({ path: p }) => {
    const r = await files.list(p || '');
    return json({
      path: r.path || '/',
      entries: r.entries.map((e) => ({ name: e.name, type: e.type, size: e.size, modified: iso(e.modified), editable: e.editable })),
    });
  });

  tool('file_read', {
    title: 'Прочитать файл',
    description: 'Читает текстовый файл (до 2 МБ) из директории сервера. Большие файлы читайте частями через offset и max_chars.',
    inputSchema: {
      path: REL_PATH,
      offset: z.number().int().min(0).optional().describe('С какого символа читать (по умолчанию 0)'),
      max_chars: z.number().int().min(1).max(500000).optional().describe('Максимум символов (по умолчанию 60000)'),
    },
    annotations: RO,
  }, async ({ path: p, offset, max_chars }) => {
    const r = await files.readText(p);
    const total = r.content.length;
    const start = clamp(offset, 0, total, 0);
    const chunk = r.content.slice(start, start + clamp(max_chars, 1, 500000, 60000));
    const end = start + chunk.length;
    const more = end < total ? ` — есть продолжение, offset=${end}` : '';
    return {
      content: [
        { type: 'text', text: `Файл ${r.path}: символы ${start}–${end} из ${total}${more}` },
        { type: 'text', text: chunk },
      ],
    };
  });

  tool('file_write', {
    title: 'Записать файл',
    description: 'Создаёт или перезаписывает текстовый файл в директории сервера (недостающие папки создаются); append=true дописывает в конец. Конфиги модов и плагинов обычно применяются после перезапуска.',
    inputSchema: {
      path: REL_PATH,
      content: z.string().max(5 * 1024 * 1024),
      append: z.boolean().optional().describe('Дописать в конец вместо перезаписи'),
    },
    annotations: change(true),
  }, async ({ path: p, content, append }) => {
    audit('file_write', p);
    if (append) {
      const abs = files.resolveSafe(p);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.appendFile(abs, content, 'utf8');
      return json({ ok: true, path: files.relOf(abs), appendedChars: content.length });
    }
    const r = await files.writeText(p, content);
    return json({ ok: true, path: r.path, chars: content.length });
  });

  tool('files_mkdir', {
    title: 'Создать папку',
    description: 'Создаёт папку (вместе с недостающими родительскими) в директории сервера.',
    inputSchema: { path: REL_PATH },
    annotations: change(false, true),
  }, async ({ path: p }) => {
    audit('files_mkdir', p);
    return json({ ok: true, ...(await files.mkdir(p)) });
  });

  tool('files_delete', {
    title: 'Удалить файл или папку',
    description: 'Удаляет файл или папку рекурсивно. Необратимо — перед удалением важных данных сделайте backup_create.',
    inputSchema: { path: REL_PATH },
    annotations: change(true, true),
  }, async ({ path: p }) => {
    audit('files_delete', p);
    return json({ ok: true, deleted: (await files.remove(p)).path });
  });

  tool('files_rename', {
    title: 'Переименовать',
    description: 'Переименовывает файл или папку в пределах той же папки.',
    inputSchema: { path: REL_PATH, new_name: z.string().min(1).max(255).describe('Новое имя без пути') },
    annotations: change(false),
  }, async ({ path: p, new_name }) => {
    audit('files_rename', `${p} → ${new_name}`);
    return json({ ok: true, ...(await files.rename(p, new_name)) });
  });

  tool('files_archive', {
    title: 'Заархивировать',
    description: 'Упаковывает выбранные файлы и папки из одной папки в .tar.gz рядом с ними.',
    inputSchema: {
      dir: z.string().max(1000).optional().describe('Папка с элементами (по умолчанию корень)'),
      items: z.array(z.string().min(1).max(255)).min(1).max(1000).describe('Имена элементов внутри dir'),
      name: z.string().max(100).optional().describe('Имя архива без расширения'),
    },
    annotations: change(false),
  }, async ({ dir, items, name }) => {
    audit('files_archive', `${dir || '/'}: ${items.length} элем.`);
    return json({ ok: true, ...(await archives.archive(dir || '', items, name)) });
  });

  tool('files_extract', {
    title: 'Распаковать архив',
    description: 'Распаковывает .zip/.tar.gz/.tgz/.tar/.tar.bz2/.tar.xz/.gz в ту же папку (существующие файлы перезаписываются). Большие архивы распаковываются в фоне: если за wait_sec не успело — вернётся jobId для extract_status.',
    inputSchema: {
      path: REL_PATH,
      wait_sec: z.number().int().min(0).max(110).optional().describe('Сколько ждать завершения (по умолчанию 30)'),
    },
    annotations: change(true),
  }, async ({ path: p, wait_sec }) => {
    audit('files_extract', p);
    const { jobId } = await archives.startExtract(p);
    const view = extractJobView(jobId, await pollJob(() => archives.extractStatus(jobId), clamp(wait_sec, 0, 110, 30)));
    return view.status === 'error' ? fail(`Ошибка распаковки: ${view.error}`) : json(view);
  });

  tool('extract_status', {
    title: 'Статус распаковки',
    description: 'Прогресс фоновой распаковки, запущенной files_extract.',
    inputSchema: { job_id: JOB_ID },
    annotations: RO,
  }, async ({ job_id }) => json(extractJobView(job_id, archives.extractStatus(job_id))));

  // ---- Backups ------------------------------------------------------------
  tool('backups_list', {
    title: 'Список бэкапов',
    description: 'Бэкапы директории сервера (новые сверху), лимит хранения и исключения.',
    inputSchema: {},
    annotations: RO,
  }, async () => {
    const items = await backups.list();
    const b = config.get().backups;
    return json({
      maxKeep: b.maxKeep,
      exclude: b.exclude,
      backups: items.map((x) => ({ name: x.name, sizeBytes: x.size, created: iso(x.created) })),
    });
  });

  tool('backup_create', {
    title: 'Создать бэкап',
    description: 'Создаёт .tar.gz всей директории сервера (кроме исключений из настроек); можно на запущенном сервере. Идёт в фоне: если за wait_sec не завершилось — вернётся jobId для backup_status.',
    inputSchema: {
      label: z.string().max(40).optional().describe('Метка в имени файла (по умолчанию "mcp")'),
      wait_sec: z.number().int().min(0).max(110).optional().describe('Сколько ждать завершения (по умолчанию 60)'),
    },
    annotations: change(false),
  }, async ({ label, wait_sec }) => {
    audit('backup_create', label || 'mcp');
    const { jobId } = backups.startCreateJob(label || 'mcp');
    const view = backupJobView(jobId, await pollJob(() => backups.jobStatus(jobId), clamp(wait_sec, 0, 110, 60)));
    return view.status === 'error' ? fail(`Ошибка бэкапа: ${view.error}`) : json(view);
  });

  tool('backup_status', {
    title: 'Статус бэкапа',
    description: 'Прогресс фонового бэкапа, запущенного backup_create.',
    inputSchema: { job_id: JOB_ID },
    annotations: RO,
  }, async ({ job_id }) => json(backupJobView(job_id, backups.jobStatus(job_id))));

  tool('backup_restore', {
    title: 'Восстановить бэкап',
    description: 'Распаковывает бэкап поверх директории сервера — текущие файлы перезаписываются. Сервер должен быть остановлен (server_stop). Совет: сначала сделайте свежий backup_create на случай отката.',
    inputSchema: { name: z.string().min(1).max(200).describe('Имя файла из backups_list') },
    annotations: change(true),
  }, async ({ name }) => {
    audit('backup_restore', name);
    return json({ ok: true, restored: (await backups.restore(name)).name });
  });

  tool('backup_delete', {
    title: 'Удалить бэкап',
    description: 'Удаляет файл бэкапа. Необратимо.',
    inputSchema: { name: z.string().min(1).max(200).describe('Имя файла из backups_list') },
    annotations: change(true, true),
  }, async ({ name }) => {
    audit('backup_delete', name);
    return json({ ok: true, deleted: (await backups.remove(name)).name });
  });

  // ---- Scheduler ----------------------------------------------------------
  const TASK_TYPE = z.enum(['interval', 'daily']).describe('interval — каждые N минут, daily — ежедневно в time');
  const TASK_ACTION = z.enum(['restart', 'stop', 'start', 'backup', 'command']);
  const taskShape = {
    interval_minutes: z.number().int().min(1).max(100000).optional().describe('Для type=interval'),
    time: z.string().regex(/^\d{1,2}:\d{2}$/).optional().describe('Для type=daily, ЧЧ:ММ по времени сервера'),
    command: z.string().max(200).optional().describe('Для action=command'),
    warn: z.string().max(200).optional().describe('Команда-предупреждение перед restart/stop, например "say Рестарт через 30 секунд"'),
    warn_seconds: z.number().int().min(0).max(3600).optional().describe('За сколько секунд до действия отправить warn'),
    enabled: z.boolean().optional(),
  };

  tool('tasks_list', {
    title: 'Плановые задачи',
    description: 'Задачи по расписанию (рестарты, бэкапы, команды) со временем следующего запуска.',
    inputSchema: {},
    annotations: RO,
  }, async () => json(scheduler.listWithMeta().map(taskView)));

  tool('task_create', {
    title: 'Создать задачу',
    description: 'Создаёт задачу по расписанию: действие restart/stop/start/backup/command каждые N минут (interval) или ежедневно в ЧЧ:ММ (daily).',
    inputSchema: { name: z.string().min(1).max(60), type: TASK_TYPE, action: TASK_ACTION, ...taskShape },
    annotations: change(false),
  }, async (args) => {
    if (args.type === 'daily' && !args.time) return fail('Для type=daily укажите time в формате ЧЧ:ММ.');
    if (args.type === 'interval' && !args.interval_minutes) return fail('Для type=interval укажите interval_minutes.');
    if (args.action === 'command' && !args.command) return fail('Для action=command укажите command.');
    audit('task_create', args.name);
    const task = scheduler.add(pickMapped(args, TASK_FIELDS));
    return json({ ok: true, task: taskView(scheduler.listWithMeta().find((t) => t.id === task.id) || task) });
  });

  tool('task_update', {
    title: 'Изменить задачу',
    description: 'Изменяет поля существующей задачи (переданные поля заменяются, остальные сохраняются). Можно включить/выключить через enabled.',
    inputSchema: { id: z.string().min(1).max(64), name: z.string().min(1).max(60).optional(), type: TASK_TYPE.optional(), action: TASK_ACTION.optional(), ...taskShape },
    annotations: change(false, true),
  }, async (args) => {
    const patch = pickMapped(args, TASK_FIELDS);
    if (!Object.keys(patch).length) return fail('Не передано ни одного поля для изменения.');
    audit('task_update', args.id);
    const task = scheduler.updateTask(args.id, patch);
    return json({ ok: true, task: taskView(scheduler.listWithMeta().find((t) => t.id === task.id) || task) });
  });

  tool('task_delete', {
    title: 'Удалить задачу',
    description: 'Удаляет задачу по расписанию.',
    inputSchema: { id: z.string().min(1).max(64) },
    annotations: change(true, true),
  }, async ({ id }) => {
    audit('task_delete', id);
    return json({ ok: true, deleted: scheduler.remove(id).name });
  });

  // ---- server.properties & launch settings ---------------------------------
  tool('properties_get', {
    title: 'Прочитать server.properties',
    description: 'Параметры server.properties (порт, MOTD, сложность, вайтлист и т.д.).',
    inputSchema: { keys: z.array(z.string().max(100)).max(200).optional().describe('Только эти ключи (по умолчанию все)') },
    annotations: RO,
  }, async ({ keys }) => {
    const r = properties.read();
    if (!r.exists) return json({ exists: false, note: 'server.properties ещё нет — он появится после первого запуска сервера.' });
    const props = keys && keys.length
      ? Object.fromEntries(keys.map((k) => [k, r.properties[k] ?? null]))
      : r.properties;
    return json({ exists: true, properties: props });
  });

  tool('properties_set', {
    title: 'Изменить server.properties',
    description: 'Изменяет или добавляет параметры server.properties (комментарии и порядок сохраняются). Применяются после перезапуска сервера.',
    inputSchema: {
      properties: z.record(z.string().regex(/^[A-Za-z0-9._-]+$/), z.union([z.string(), z.number(), z.boolean()]))
        .describe('Например {"max-players": 30, "pvp": false, "motd": "Привет"}'),
    },
    annotations: change(false, true),
  }, async ({ properties: updates }) => {
    const keys = Object.keys(updates);
    if (!keys.length) return fail('Не переданы параметры.');
    audit('properties_set', keys.join(', '));
    const r = properties.write(Object.fromEntries(keys.map((k) => [k, String(updates[k])])));
    return json({
      ok: true,
      updated: Object.fromEntries(keys.map((k) => [k, r.properties[k]])),
      note: mcserver.state === 'stopped' ? 'Изменения применятся при следующем запуске.' : 'Перезапустите сервер (server_restart), чтобы применить.',
    });
  });

  tool('server_settings_get', {
    title: 'Параметры запуска',
    description: 'Параметры запуска сервера: ОЗУ, JAR, путь к Java, флаги JVM, флаги Aikar, лимит ядер CPU, своя команда, автозапуск/авто-перезапуск — плюс итоговая команда и предупреждения по ней.',
    inputSchema: {},
    annotations: RO,
  }, async () => {
    const s = serverSettings.get();
    return json({
      server: s.server,
      commandPreview: s.commandPreview,
      warnings: mcserver.commandWarnings(s.commandPreview),
      cpuCount: s.cpuCount,
      cpuLimitSupported: s.hasTaskset,
    });
  });

  tool('server_settings_update', {
    title: 'Изменить параметры запуска',
    description: 'Меняет параметры запуска. Возвращает итоговую команду и предупреждения (например, опечатку -Xms вместо -Xmx или heap больше доступной ОЗУ). dry_run=true — только показать результат без сохранения. Применяется при следующем запуске или перезапуске.',
    inputSchema: {
      jar: z.string().min(1).max(255).optional(),
      java_path: z.string().min(1).max(500).optional(),
      min_ram_mb: z.number().int().min(128).max(1048576).optional(),
      max_ram_mb: z.number().int().min(256).max(1048576).optional(),
      cpu_cores: z.number().int().min(0).max(1024).optional().describe('Сколько ядер выделить (0 — все)'),
      jvm_flags: z.string().max(4000).optional(),
      use_aikar_flags: z.boolean().optional(),
      custom_command: z.string().max(8000).optional().describe('Своя команда запуска вместо сборки из полей; пустая строка — вернуть автоматическую'),
      stop_command: z.string().min(1).max(100).optional(),
      stop_timeout_sec: z.number().int().min(5).max(3600).optional(),
      auto_start: z.boolean().optional(),
      auto_restart: z.boolean().optional(),
      dry_run: z.boolean().optional().describe('Только показать итоговую команду, ничего не сохраняя'),
    },
    annotations: change(false, true),
  }, async (args) => {
    const body = pickMapped(args, SETTINGS_FIELDS);
    if (!Object.keys(body).length) return fail('Не передано ни одного параметра.');
    if (args.dry_run) return json({ dryRun: true, ...serverSettings.preview(body) });
    audit('server_settings_update', Object.keys(body).join(', '));
    const r = serverSettings.update(body);
    return json({
      ok: true,
      commandPreview: r.commandPreview,
      warnings: r.warnings,
      note: mcserver.state === 'stopped' ? 'Применится при следующем запуске.' : 'Применится после server_restart.',
    });
  });

  // ---- Firewall -------------------------------------------------------------
  const fwShape = {
    port: z.number().int().min(1).max(65535),
    proto: z.enum(['tcp', 'udp', 'both']).optional().describe('По умолчанию both'),
    from: z.string().max(2000).optional().describe('IP или подсети источника через запятую (например "203.0.113.5, 10.0.0.0/8"); пусто — откуда угодно'),
  };

  tool('firewall_status', {
    title: 'Статус фаервола',
    description: 'Установлен ли ufw, включён ли он и активные правила.',
    inputSchema: {},
    annotations: RO,
  }, async () => {
    const s = await firewall.status();
    return json({ installed: s.installed, active: s.active, rules: s.rules });
  });

  tool('firewall_rule_add', {
    title: 'Добавить правило фаервола',
    description: 'Разрешает (allow) или запрещает (deny) входящие подключения к порту, при желании только с указанных адресов.',
    inputSchema: { action: z.enum(['allow', 'deny']), ...fwShape },
    annotations: change(false, true),
  }, async ({ action, port, proto, from }) => {
    audit('firewall_rule_add', `${action} ${port}/${proto || 'both'}${from ? ` from ${from}` : ''}`);
    const s = action === 'deny'
      ? await firewall.deny(port, proto || 'both', from)
      : await firewall.allow(port, proto || 'both', from);
    return json({ ok: true, active: s.active, rules: s.rules });
  });

  tool('firewall_rule_delete', {
    title: 'Удалить правило фаервола',
    description: 'Удаляет правило фаервола (параметры должны совпадать с добавленным правилом).',
    inputSchema: { action: z.enum(['allow', 'deny']), ...fwShape },
    annotations: change(true, true),
  }, async ({ action, port, proto, from }) => {
    audit('firewall_rule_delete', `${action} ${port}/${proto || 'both'}${from ? ` from ${from}` : ''}`);
    const s = await firewall.delRule(port, proto || 'both', action, from);
    return json({ ok: true, active: s.active, rules: s.rules });
  });

  tool('firewall_set_enabled', {
    title: 'Включить/выключить фаервол',
    description: 'Включает или выключает ufw. Перед включением проверяется, что есть разрешающие правила для SSH (22) и порта панели — иначе можно потерять доступ к серверу; без них включение отклоняется, если не передан force=true.',
    inputSchema: {
      enabled: z.boolean(),
      force: z.boolean().optional().describe('Включить, даже если нет правил для SSH и порта панели'),
    },
    annotations: change(true, true),
  }, async ({ enabled, force }) => {
    if (!enabled) {
      audit('firewall_set_enabled', 'off');
      const s = await firewall.disable();
      return json({ ok: true, active: s.active });
    }
    const rules = await firewall.addedRules();
    const panelPort = config.get().panel.port;
    const missing = [22, panelPort].filter((p) => !firewall.allowsPort(rules, p));
    if (missing.length && !force) {
      return fail(`Отказ: нет разрешающих правил для порта(ов) ${missing.join(', ')} (SSH и панель) — включение фаервола отрежет доступ. Сначала добавьте их через firewall_rule_add action=allow или передайте force=true, если SSH работает на другом порту.`);
    }
    audit('firewall_set_enabled', 'on');
    const s = await firewall.enable();
    return json({ ok: true, active: s.active, rules: s.rules });
  });

  // ---- Databases ------------------------------------------------------------
  tool('databases_status', {
    title: 'Базы данных',
    description: 'Подключение к MySQL/MariaDB и список баз (размер, число таблиц, пользователь). Пароли скрыты, если не передан include_passwords=true.',
    inputSchema: { include_passwords: z.boolean().optional() },
    annotations: RO,
  }, async ({ include_passwords }) => {
    const s = await databases.status();
    return json({
      connection: s.connection,
      mysql: s.mysql,
      databases: s.databases.map((d) => (include_passwords ? d : { ...d, password: d.password ? '(скрыт)' : null })),
    });
  });

  tool('database_info', {
    title: 'Таблицы базы',
    description: 'Таблицы базы данных с числом строк и размером.',
    inputSchema: { name: DB_NAME },
    annotations: RO,
  }, async ({ name }) => json(await databases.info(name)));

  tool('database_create', {
    title: 'Создать базу данных',
    description: 'Создаёт базу MySQL/MariaDB и отдельного пользователя с паролем и правами только на неё. Возвращает данные подключения для конфига плагина.',
    inputSchema: { name: DB_NAME },
    annotations: change(false),
  }, async ({ name }) => {
    audit('database_create', name);
    return json({ ok: true, ...(await databases.create(name)) });
  });

  tool('database_delete', {
    title: 'Удалить базу данных',
    description: 'Удаляет базу данных и её пользователя. Необратимо.',
    inputSchema: { name: DB_NAME },
    annotations: change(true, true),
  }, async ({ name }) => {
    audit('database_delete', name);
    return json({ ok: true, ...(await databases.remove(name)) });
  });

  tool('database_query', {
    title: 'SQL-запрос',
    description: 'Выполняет SQL в указанной базе (можно несколько запросов через «;»). SELECT возвращает до 500 строк. Изменяющие запросы необратимы.',
    inputSchema: { database: DB_NAME, sql: z.string().min(1).max(100000) },
    annotations: change(true),
  }, async ({ database, sql }) => {
    audit('database_query', database);
    return json(await databases.query(database, sql));
  });

  // ---- System ---------------------------------------------------------------
  tool('system_info', {
    title: 'Информация о системе',
    description: 'Версия панели, ОС, CPU, память, аптайм, диск директории сервера и версия Java.',
    inputSchema: {},
    annotations: RO,
  }, async () => {
    const cfg = config.get();
    const [disk, java] = await Promise.all([system.diskUsage(cfg.server.directory), system.javaVersion()]);
    return json({
      panelVersion: require('../package.json').version,
      serverDirectory: cfg.server.directory,
      system: system.systemInfo(),
      disk,
      java,
    });
  });

  // ---- Resources ------------------------------------------------------------
  const resource = (name, uri, meta, read) => {
    counts.resources++;
    server.registerResource(name, uri, meta, async (u) => ({
      contents: [{ uri: u.href, mimeType: meta.mimeType, text: await read() }],
    }));
  };

  resource('console-log', 'minedeck://console/log',
    { title: 'Консоль сервера', description: 'Последние строки консоли (до 400)', mimeType: 'text/plain' },
    async () => mcserver.getHistory().map((e) => `${iso(e.t)} [${e.stream}] ${e.line}`).join('\n'));

  resource('server-status', 'minedeck://server/status',
    { title: 'Статус сервера', description: 'Состояние, PID, команда запуска', mimeType: 'application/json' },
    async () => JSON.stringify({ ...mcserver.status(), eulaAccepted: mcserver.eulaAccepted() }, null, 2));

  resource('server-properties', 'minedeck://server/properties',
    { title: 'server.properties', description: 'Файл server.properties как есть', mimeType: 'text/plain' },
    async () => properties.read().raw);

  // ---- Prompts --------------------------------------------------------------
  counts.prompts++;
  server.registerPrompt('diagnose_server', {
    title: 'Диагностика сервера',
    description: 'Найти причину проблем: падения, лаги, ошибки запуска',
  }, () => ({ messages: [{ role: 'user', content: { type: 'text', text: DIAGNOSE_PROMPT } }] }));

  if (!readOnly) {
    counts.prompts++;
    server.registerPrompt('safe_restart', {
      title: 'Безопасный перезапуск',
      description: 'Предупредить игроков, сделать бэкап и перезапустить сервер',
      argsSchema: { warning_seconds: z.string().regex(/^\d{1,4}$/).optional().describe('За сколько секунд предупредить игроков (по умолчанию 30)') },
    }, ({ warning_seconds }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: safeRestartPrompt(warning_seconds || '30') } }],
    }));
  }

  return counts;
}

module.exports = { registerAll, parseListLine };
