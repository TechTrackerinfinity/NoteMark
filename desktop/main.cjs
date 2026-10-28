const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const { request: requestSync } = require('./native-http.cjs');
let hostServer = null, hostError = null;
const ui = path.join(__dirname, '../web/index.html');
const uiUrl = pathToFileURL(ui).href;
// Keep the existing notebook profile when the visible product name changes.
app.setPath('userData', process.env.MIRA_USER_DATA ? path.resolve(process.env.MIRA_USER_DATA) : path.join(app.getPath('appData'), 'Mira Notes'));
app.setName('NoteMark');
const smokeReport = process.env.MIRA_SMOKE_REPORT;
let smokeTimer;
let wifiCache = null, wifiCacheAt = 0;
async function wifiInfo() {
  if (process.platform !== 'win32') return null;
  if (wifiCache && Date.now() - wifiCacheAt < 5000) return wifiCache;
  try {
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'check-wifi.ps1'), '-Program', process.execPath], { windowsHide: true, timeout: 8000, maxBuffer: 65536 });
    wifiCache = JSON.parse(stdout.replace(/^\uFEFF/, '')); wifiCacheAt = Date.now(); return wifiCache;
  } catch { return { allowed: false, unknown: true, profiles: [] }; }
}
function reportSmoke(result) {
  if (!smokeReport) return;
  clearTimeout(smokeTimer);
  require('node:fs').writeFileSync(smokeReport, JSON.stringify({ ...result, electron: process.versions.electron, chromium: process.versions.chrome, at: new Date().toISOString() }, null, 2));
  setTimeout(() => app.quit(), 100);
}
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on('second-instance', () => { const win = BrowserWindow.getAllWindows()[0]; if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.miranotes.desktop');
    try {
      const { startServer } = await import('../server/index.mjs');
      hostServer = await startServer({ host: '0.0.0.0', port: Number(process.env.MIRA_SYNC_PORT || 47821), dataDir: path.join(app.getPath('userData'), 'sync-data') });
    } catch (error) { hostError = error.code === 'EADDRINUSE' ? 'Wi-Fi server port 47821 is already in use. Close the other server or use a hosted server address.' : 'Wi-Fi hosting could not start: ' + error.message; }
    ipcMain.handle('mira:get-info', async event => {
      if (event.senderFrame?.url !== uiUrl) throw new Error('Untrusted frame');
      if (smokeReport) reportSmoke({ ok: !hostError, rendererBooted: true, preloadConnected: true, serverListening: !!hostServer, error: hostError, appName: app.getName(), version: app.getVersion(), userData: app.getPath('userData'), appId: 'com.miranotes.desktop' });
      const addresses = Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal && (/^10\./.test(n.address) || /^192\.168\./.test(n.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(n.address))).map(n => `http://${n.address}:${hostServer?.port || 47821}`);
      return { urls: hostServer ? [...new Set(addresses)] : [], error: hostError, version: app.getVersion(), wifi: await wifiInfo() };
    });
    ipcMain.handle('mira:repair-wifi', async event => {
      if (event.senderFrame?.url !== uiUrl) throw new Error('Untrusted frame');
      await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'launch-wifi-repair.ps1'), '-Program', process.execPath], { windowsHide: true, timeout: 120000, maxBuffer: 65536 });
      wifiCache = null; return wifiInfo();
    });
    ipcMain.handle('mira:request', async (event, args) => {
      if (event.senderFrame?.url !== uiUrl) throw new Error('Untrusted frame');
      return requestSync(args);
    });
    const win = new BrowserWindow({ width: 1360, height: 900, minWidth: 360, minHeight: 540, show: !smokeReport, backgroundColor: '#f6f8fc', title: 'NoteMark', icon: path.join(__dirname, '../web/icon.png'), autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, spellcheck: true, backgroundThrottling: false } });
    win.on('close', () => { if (!win.webContents.isDestroyed()) win.webContents.session.flushStorageData(); });
    win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (event, url) => { if (url !== uiUrl) { event.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
    const allowedPermissions = new Set(['local-network', 'local-network-access', 'loopback-network', 'clipboard-sanitized-write']);
    const trusted = contents => contents?.getURL() === uiUrl;
    win.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(trusted(contents) && allowedPermissions.has(permission)));
    win.webContents.session.setPermissionCheckHandler((contents, permission) => trusted(contents) && allowedPermissions.has(permission));
    if (smokeReport) {
      smokeTimer = setTimeout(() => reportSmoke({ ok: false, error: 'Renderer did not complete its startup handshake within 15 seconds' }), 15000);
      win.webContents.on('did-fail-load', (_event, code, description) => reportSmoke({ ok: false, error: 'Load failed: ' + code + ' ' + description }));
      win.webContents.on('render-process-gone', (_event, details) => reportSmoke({ ok: false, error: details.reason }));
    }
    win.webContents.session.on('will-download', (_event, item) => {
      const zip = item.getFilename().toLowerCase().endsWith('.zip');
      item.setSaveDialogOptions({ title: 'Save NoteMark backup', defaultPath: path.join(app.getPath('documents'), path.basename(item.getFilename() || 'NoteMark-backup.zip')), filters: [{ name: zip ? 'ZIP backup' : 'JSON recovery', extensions: [zip ? 'zip' : 'json'] }] });
    });
    await win.loadFile(ui);
    if (process.env.MIRA_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' });
  }).catch(error => { dialog.showErrorBox('NoteMark could not start', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { hostServer?.close(); });
}
