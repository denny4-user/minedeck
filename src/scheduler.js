'use strict';

const crypto = require('crypto');
const config = require('./config');
const mcserver = require('./mcserver');
const backups = require('./backups');

const ACTIONS = ['restart', 'stop', 'start', 'backup', 'command'];
const TYPES = ['interval', 'daily'];

let timer = null;
const runtime = new Map(); // id -> { lastRun, lastDailyKey }

function tasks() {
  return config.get().schedule.tasks;
}

function normalize(input) {
  const type = TYPES.includes(input.type) ? input.type : 'interval';
  const action = ACTIONS.includes(input.action) ? input.action : 'restart';
  const task = {
    id: input.id || crypto.randomBytes(6).toString('hex'),
    name: String(input.name || 'Задача').slice(0, 60),
    enabled: input.enabled !== false,
    type,
    action,
    intervalMinutes: Math.max(1, parseInt(input.intervalMinutes, 10) || 60),
    time: /^\d{1,2}:\d{2}$/.test(input.time || '') ? input.time : '04:00',
    command: String(input.command || '').slice(0, 200),
    warn: String(input.warn || '').slice(0, 200),
    warnSeconds: Math.max(0, parseInt(input.warnSeconds, 10) || 0),
    createdAt: input.createdAt || Date.now(),
  };
  return task;
}

function add(input) {
  const task = normalize(input);
  const list = tasks();
  list.push(task);
  config.save();
  return task;
}

function updateTask(id, input) {
  const list = tasks();
  const idx = list.findIndex((t) => t.id === id);
  if (idx < 0) throw Object.assign(new Error('Задача не найдена.'), { status: 404 });
  const merged = normalize({ ...list[idx], ...input, id });
  list[idx] = merged;
  config.save();
  return merged;
}

function remove(id) {
  const list = tasks();
  const idx = list.findIndex((t) => t.id === id);
  if (idx < 0) throw Object.assign(new Error('Задача не найдена.'), { status: 404 });
  const [removed] = list.splice(idx, 1);
  runtime.delete(id);
  config.save();
  return removed;
}

function doAction(task) {
  return (async () => {
    switch (task.action) {
      case 'restart':
        if (mcserver.state !== 'stopped') mcserver.restart();
        else mcserver.start();
        break;
      case 'stop':
        if (mcserver.state !== 'stopped') mcserver.stop();
        break;
      case 'start':
        if (mcserver.state === 'stopped') mcserver.start();
        break;
      case 'backup':
        await backups.create('scheduled');
        break;
      case 'command':
        if (task.command && mcserver.state === 'running') mcserver.writeCommand(task.command);
        break;
      default:
        break;
    }
  })();
}

async function execute(task) {
  mcserver.pushLine(`[MineDeck] Плановая задача «${task.name}» → ${task.action}`, 'sys');
  try {
    // Optional in-game warning before a disruptive action.
    const disruptive = task.action === 'restart' || task.action === 'stop';
    if (disruptive && task.warn && task.warnSeconds > 0 && mcserver.state === 'running') {
      mcserver.writeCommand(task.warn);
      setTimeout(() => {
        doAction(task).catch((err) =>
          mcserver.pushLine(`[MineDeck] Ошибка задачи «${task.name}»: ${err.message}`, 'err')
        );
      }, task.warnSeconds * 1000);
      return;
    }
    await doAction(task);
  } catch (err) {
    mcserver.pushLine(`[MineDeck] Ошибка задачи «${task.name}»: ${err.message}`, 'err');
  }
}

function tick() {
  const now = new Date();
  const dailyKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  for (const task of tasks()) {
    if (!task.enabled) continue;
    let rt = runtime.get(task.id);
    if (!rt) {
      rt = { lastRun: 0, lastDailyKey: null };
      runtime.set(task.id, rt);
    }

    if (task.type === 'interval') {
      const intervalMs = task.intervalMinutes * 60 * 1000;
      if (!rt.lastRun) {
        // Anchor first run one interval from process start.
        rt.lastRun = Date.now();
        continue;
      }
      if (Date.now() - rt.lastRun >= intervalMs) {
        rt.lastRun = Date.now();
        execute(task);
      }
    } else if (task.type === 'daily') {
      const [h, m] = task.time.split(':').map((n) => parseInt(n, 10));
      if (now.getHours() === h && now.getMinutes() === m && rt.lastDailyKey !== dailyKey) {
        rt.lastDailyKey = dailyKey;
        execute(task);
      }
    }
  }
}

function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 20 * 1000); // check every 20s
}

function nextRunInfo(task) {
  const rt = runtime.get(task.id);
  if (task.type === 'interval') {
    const base = rt && rt.lastRun ? rt.lastRun : Date.now();
    return base + task.intervalMinutes * 60 * 1000;
  }
  const [h, m] = task.time.split(':').map((n) => parseInt(n, 10));
  const next = new Date();
  next.setHours(h, m, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

function listWithMeta() {
  return tasks().map((t) => ({ ...t, nextRun: nextRunInfo(t) }));
}

module.exports = { start, add, updateTask, remove, listWithMeta, ACTIONS, TYPES };
