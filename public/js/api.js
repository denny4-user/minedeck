// Thin wrapper around fetch with JSON + error handling.
const API = (() => {
  async function req(method, url, body, opts = {}) {
    const options = { method, headers: {}, credentials: 'same-origin' };
    if (body instanceof FormData) {
      options.body = body;
    } else if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const res = await fetch(url, options);
    if (opts.raw) return res;
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await res.json().catch(() => null);
    }
    if (!res.ok) {
      const msg = (data && data.error) || `Ошибка ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const get = (u) => req('GET', u);
  const post = (u, b) => req('POST', u, b === undefined ? {} : b);
  const put = (u, b) => req('PUT', u, b === undefined ? {} : b);
  const del = (u) => req('DELETE', u);

  return {
    get, post, put, del, req,
    // auth
    authStatus: () => get('/api/auth/status'),
    setup: (username, password) => post('/api/auth/setup', { username, password }),
    login: (username, password) => post('/api/auth/login', { username, password }),
    logout: () => post('/api/auth/logout'),
    changePassword: (currentPassword, newPassword) => post('/api/auth/password', { currentPassword, newPassword }),
    // server
    serverStatus: () => get('/api/server/status'),
    serverAction: (action) => post('/api/server/' + action),
    command: (command) => post('/api/server/command', { command }),
    acceptEula: () => post('/api/server/eula'),
    // system
    system: () => get('/api/system'),
    // files
    listFiles: (path) => get('/api/files/list?path=' + encodeURIComponent(path || '')),
    readFile: (path) => get('/api/files/read?path=' + encodeURIComponent(path)),
    writeFile: (path, content) => post('/api/files/write', { path, content }),
    mkdir: (path) => post('/api/files/mkdir', { path }),
    deleteFile: (path) => post('/api/files/delete', { path }),
    renameFile: (path, newName) => post('/api/files/rename', { path, newName }),
    upload: (path, formData) => { formData.append('path', path); return req('POST', '/api/files/upload', formData); },
    downloadUrl: (path) => '/api/files/download?path=' + encodeURIComponent(path),
    // backups
    backups: () => get('/api/backups'),
    createBackup: (label) => post('/api/backups/create', { label }),
    restoreBackup: (name) => post('/api/backups/restore', { name }),
    deleteBackup: (name) => post('/api/backups/delete', { name }),
    backupDownloadUrl: (name) => '/api/backups/download?name=' + encodeURIComponent(name),
    backupSettings: (s) => post('/api/backups/settings', s),
    // schedule
    tasks: () => get('/api/schedule'),
    addTask: (t) => post('/api/schedule', t),
    updateTask: (id, t) => put('/api/schedule/' + id, t),
    deleteTask: (id) => del('/api/schedule/' + id),
    // settings
    settings: () => get('/api/settings'),
    saveServerSettings: (s) => post('/api/settings/server', s),
    savePanelSettings: (s) => post('/api/settings/panel', s),
    properties: () => get('/api/settings/properties'),
    saveProperties: (properties) => post('/api/settings/properties', { properties }),
    // databases
    databases: () => get('/api/databases'),
    dbConfig: (c) => post('/api/databases/config', c),
    dbTest: () => post('/api/databases/test'),
    dbCreate: (name) => post('/api/databases/create', { name }),
    dbDelete: (name) => post('/api/databases/delete', { name }),
    dbInfo: (name) => get('/api/databases/info?name=' + encodeURIComponent(name)),
    dbQuery: (name, sql) => post('/api/databases/query', { name, sql }),
    // update
    version: () => get('/api/update/version'),
    checkUpdate: () => post('/api/update/check'),
    applyUpdate: () => post('/api/update/apply'),
    // firewall
    firewall: () => get('/api/firewall'),
    fwEnable: () => post('/api/firewall/enable'),
    fwDisable: () => post('/api/firewall/disable'),
    fwAllow: (port, proto) => post('/api/firewall/allow', { port, proto }),
    fwDeny: (port, proto) => post('/api/firewall/deny', { port, proto }),
    fwDelete: (port, proto, action) => post('/api/firewall/delete', { port, proto, action }),
  };
})();
