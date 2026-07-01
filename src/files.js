'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');

// Text file extensions we allow editing in the browser editor.
const TEXT_EXT = new Set([
  '.txt', '.properties', '.yml', '.yaml', '.json', '.json5', '.conf', '.cfg',
  '.ini', '.log', '.sh', '.bat', '.md', '.toml', '.xml', '.html', '.css',
  '.js', '.mcmeta', '.csv', '.env', '.list', '',
]);

const MAX_EDIT_BYTES = 2 * 1024 * 1024; // 2 MB editable text limit

function baseDir() {
  return path.resolve(config.get().server.directory);
}

// Resolve a user-supplied relative path safely inside the server directory.
function resolveSafe(relPath) {
  const base = baseDir();
  const cleaned = (relPath || '').replace(/^[/\\]+/, '');
  const target = path.resolve(base, cleaned);
  if (target !== base && !target.startsWith(base + path.sep)) {
    const err = new Error('Доступ за пределы директории сервера запрещён.');
    err.status = 400;
    throw err;
  }
  return target;
}

function relOf(absPath) {
  const base = baseDir();
  const rel = path.relative(base, absPath);
  return rel.split(path.sep).join('/');
}

async function list(relPath) {
  const dir = resolveSafe(relPath);
  const stat = await fsp.stat(dir);
  if (!stat.isDirectory()) {
    const err = new Error('Это не директория.');
    err.status = 400;
    throw err;
  }
  const names = await fsp.readdir(dir);
  const entries = await Promise.all(
    names.map(async (name) => {
      const abs = path.join(dir, name);
      try {
        const st = await fsp.lstat(abs);
        const isDir = st.isDirectory();
        return {
          name,
          path: relOf(abs),
          type: st.isSymbolicLink() ? 'symlink' : isDir ? 'dir' : 'file',
          size: isDir ? 0 : st.size,
          modified: st.mtimeMs,
          editable: !isDir && st.size <= MAX_EDIT_BYTES && TEXT_EXT.has(path.extname(name).toLowerCase()),
        };
      } catch (_) {
        return { name, path: relOf(abs), type: 'unknown', size: 0, modified: 0, editable: false };
      }
    })
  );
  entries.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name);
  });
  return { path: relOf(dir), entries };
}

async function readText(relPath) {
  const abs = resolveSafe(relPath);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) throw Object.assign(new Error('Это директория.'), { status: 400 });
  if (st.size > MAX_EDIT_BYTES) {
    throw Object.assign(new Error('Файл слишком большой для редактирования (>2 МБ).'), { status: 400 });
  }
  const content = await fsp.readFile(abs, 'utf8');
  return { path: relOf(abs), content };
}

async function writeText(relPath, content) {
  const abs = resolveSafe(relPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
  return { path: relOf(abs) };
}

async function mkdir(relPath) {
  const abs = resolveSafe(relPath);
  await fsp.mkdir(abs, { recursive: true });
  return { path: relOf(abs) };
}

async function remove(relPath) {
  const abs = resolveSafe(relPath);
  if (abs === baseDir()) throw Object.assign(new Error('Нельзя удалить корневую директорию.'), { status: 400 });
  await fsp.rm(abs, { recursive: true, force: true });
  return { path: relOf(abs) };
}

async function rename(relPath, newName) {
  const abs = resolveSafe(relPath);
  if (!newName || newName.includes('/') || newName.includes('\\') || newName === '..' || newName === '.') {
    throw Object.assign(new Error('Недопустимое имя.'), { status: 400 });
  }
  const dest = path.join(path.dirname(abs), newName);
  // Ensure the destination stays inside the base dir too.
  resolveSafe(relOf(dest));
  await fsp.rename(abs, dest);
  return { path: relOf(dest) };
}

async function statInfo(relPath) {
  const abs = resolveSafe(relPath);
  const st = await fsp.stat(abs);
  return { abs, isDir: st.isDirectory(), size: st.size, name: path.basename(abs) };
}

module.exports = {
  baseDir,
  resolveSafe,
  relOf,
  list,
  readText,
  writeText,
  mkdir,
  remove,
  rename,
  statInfo,
  TEXT_EXT,
  MAX_EDIT_BYTES,
};
