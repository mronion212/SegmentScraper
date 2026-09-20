const { app, BrowserWindow, ipcMain, dialog, safeStorage, Menu } = require('electron');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { CredentialVault } = require('./vault.cjs');

let window, server, origin, quitting = false;
app.setName('SegmentScraper');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('SegmentScraper kon niet starten', error.message); app.quit(); });
}
async function start() {
  const userData = app.getPath('userData');
  const settingsPath = path.join(userData, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(await readFile(settingsPath, 'utf8')); } catch { /* defaults */ }
  const bundledProbe = app.isPackaged ? path.join(process.resourcesPath, 'ffprobe', 'ffprobe.exe') : path.join(__dirname, '..', '..', 'vendor', 'ffmpeg', 'ffprobe.exe');
  if (!process.env.FFPROBE_PATH && existsSync(bundledProbe)) process.env.FFPROBE_PATH = bundledProbe;
  const encryption = {
    async encrypt(text) {
      if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw new Error('Geen veilige sleutelopslag beschikbaar. Verbind zonder onthouden.');
      if (safeStorage.encryptStringAsync) {
        if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Veilige sleutelopslag niet beschikbaar.');
        return safeStorage.encryptStringAsync(text);
      }
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Veilige sleutelopslag niet beschikbaar.');
      return safeStorage.encryptString(text);
    },
    async decrypt(buffer) {
      if (safeStorage.decryptStringAsync) return (await safeStorage.decryptStringAsync(buffer)).result;
      return safeStorage.decryptString(buffer);
    },
  };
  const vault = new CredentialVault(path.join(userData, 'accounts.enc.json'), encryption);
  const { createApp } = await import(pathToFileURL(path.join(__dirname, '..', 'server.mjs')).href);
  server = createApp({ downloadDir: settings.downloadDir || path.join(app.getPath('downloads'), 'SegmentScraper'), credentialStore: vault });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  window = new BrowserWindow({ title: 'SegmentScraper', width: 1440, height: 960, minWidth: 900, minHeight: 650, backgroundColor: '#0b1018', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== origin + '/') event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  function handle(channel, action) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw new Error('Onbekend appvenster.');
      return action(...args);
    });
  }
  handle('desktop:pick-files', async () => (await dialog.showOpenDialog(window, { title: 'Kies films of afleveringen', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Video', extensions: ['mkv', 'mp4', 'm4v', 'avi', 'mov', 'webm', 'ts', 'm2ts'] }] })).filePaths);
  handle('desktop:pick-folder', async () => (await dialog.showOpenDialog(window, { title: 'Kies een seizoensmap', properties: ['openDirectory'] })).filePaths);
  handle('desktop:pick-destination', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(window, { title: 'Kies je downloadmap', properties: ['openDirectory', 'createDirectory'] });
    if (canceled) return null;
    server.setDownloadDir(filePaths[0]);
    settings.downloadDir = filePaths[0]; await mkdir(userData, { recursive: true }); await writeFile(settingsPath, JSON.stringify(settings));
    return filePaths[0];
  });
  handle('desktop:save-report', async report => {
    if (typeof report !== 'string' || report.length > 32 * 1024 * 1024) throw new Error('Rapport te groot.');
    const parsed = JSON.parse(report);
    if (parsed.schema !== 'segmentscraper-chapter-report/v1' || !Array.isArray(parsed.reports)) throw new Error('Ongeldig rapport.');
    const { canceled, filePath } = await dialog.showSaveDialog(window, { defaultPath: 'chapter-report.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (canceled) return false; await writeFile(filePath, report); return true;
  });
  window.on('close', event => {
    if (!quitting && server.hasActiveJobs()) {
      const choice = dialog.showMessageBoxSync(window, { type: 'question', title: 'Wachtrij is nog bezig', message: 'Actieve downloads en controles stoppen en de app sluiten?', buttons: ['Doorgaan met verwerken', 'Stoppen en sluiten'], defaultId: 0, cancelId: 0 });
      if (choice === 0) { event.preventDefault(); return; }
    }
    quitting = true; server.stopJobs();
  });
  window.once('ready-to-show', () => window.show());
  await window.loadURL(origin);
}
app.on('window-all-closed', () => { server?.stopJobs(); server?.close(); app.quit(); });
