const { app, BrowserWindow, ipcMain, dialog, safeStorage, Menu, shell } = require('electron');
const path = require('node:path');
const { existsSync } = require('node:fs');
const { readFile, writeFile, mkdir, appendFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { CredentialVault } = require('./vault.cjs');

let window, server, origin, quitting = false, closing = false;
app.setName('SegmentScraper');
app.commandLine.appendSwitch('lang','en-US');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('SegmentScraper could not start', error.message); app.quit(); });
}
async function start() {
  const userData = app.getPath('userData');
  const settingsPath = path.join(userData, 'settings.json');
  let settings = {};
  try { settings = JSON.parse(await readFile(settingsPath, 'utf8')); } catch { /* defaults */ }
  const bundledProbe = app.isPackaged ? path.join(process.resourcesPath, 'ffprobe', 'ffprobe.exe') : path.join(__dirname, '..', '..', 'vendor', 'ffmpeg', 'ffprobe.exe');
  if (!process.env.FFPROBE_PATH && existsSync(bundledProbe)) process.env.FFPROBE_PATH = bundledProbe;
  const bundledFfmpeg=path.join(path.dirname(bundledProbe),'ffmpeg.exe');
  if(!process.env.FFMPEG_PATH&&existsSync(bundledFfmpeg))process.env.FFMPEG_PATH=bundledFfmpeg;
  const encryption = {
    async encrypt(text) {
      if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw new Error('Secure credential storage unavailable. Connect without remembering.');
      if (safeStorage.encryptStringAsync) {
        if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Secure credential storage unavailable.');
        return safeStorage.encryptStringAsync(text);
      }
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage unavailable.');
      return safeStorage.encryptString(text);
    },
    async decrypt(buffer) {
      if (safeStorage.decryptStringAsync) return (await safeStorage.decryptStringAsync(buffer)).result;
      return safeStorage.decryptString(buffer);
    },
  };
  const vault = new CredentialVault(path.join(userData, 'accounts.enc.json'), encryption);
  const { createApp } = await import(pathToFileURL(path.join(__dirname, '..', 'server.mjs')).href);
  const { createUpdateChecker, RELEASES } = await import(pathToFileURL(path.join(__dirname, '..', 'updates.mjs')).href);
  const { createUploadService } = await import(pathToFileURL(path.join(__dirname, '..', 'upload.mjs')).href);
  const { openWorkspace } = await import(pathToFileURL(path.join(__dirname, '..', 'workspace.mjs')).href);
  const workspace=await openWorkspace(path.join(userData,'workspace'));
  const updates=createUpdateChecker({version:app.getVersion(),requiredVersion:settings.requiredVersion});
  const uploads=createUploadService({initialState:workspace.get().uploads,onState:uploads=>workspace.save({uploads}),onAudit:async entry=>{await mkdir(userData,{recursive:true});await appendFile(path.join(userData,'upload-audit.jsonl'),JSON.stringify(entry)+'\n');}});
  server = createApp({ workspace,downloadDir: settings.downloadDir || path.join(app.getPath('downloads'), 'SegmentScraper'), credentialStore: vault, uploads, updates });
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
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw new Error('Unknown app window.');
      return action(...args);
    });
  }
  handle('desktop:pick-files', async () => (await dialog.showOpenDialog(window, { title: 'Choose movies or episodes', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Video', extensions: ['mkv', 'mp4', 'm4v', 'avi', 'mov', 'webm', 'ts', 'm2ts'] }] })).filePaths);
  handle('desktop:open-update', () => shell.openExternal(RELEASES));
  handle('desktop:pick-folder', async () => (await dialog.showOpenDialog(window, { title: 'Choose a season folder', properties: ['openDirectory'] })).filePaths);
  handle('desktop:pick-destination', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(window, { title: 'Choose your download folder', properties: ['openDirectory', 'createDirectory'] });
    if (canceled) return null;
    server.setDownloadDir(filePaths[0]);
    settings.downloadDir = filePaths[0]; await mkdir(userData, { recursive: true }); await writeFile(settingsPath, JSON.stringify(settings));
    return filePaths[0];
  });
  handle('desktop:save-report', async report => {
    if (typeof report !== 'string' || report.length > 32 * 1024 * 1024) throw new Error('Report too large.');
    const parsed = JSON.parse(report);
    if (parsed.schema !== 'segmentscraper-chapter-report/v1' || !Array.isArray(parsed.reports)) throw new Error('Invalid report.');
    const { canceled, filePath } = await dialog.showSaveDialog(window, { defaultPath: 'chapter-report.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (canceled) return false; await writeFile(filePath, report); return true;
  });
  window.on('close', event => {
    if(quitting)return;
    event.preventDefault();
    if(closing)return;
    if (!quitting && server.hasActiveJobs()) {
      const choice = dialog.showMessageBoxSync(window, { type: 'question', title: 'Queue is still running', message: 'Stop active downloads and checks and close the app?', buttons: ['Keep processing', 'Stop and close'], defaultId: 0, cancelId: 0 });
      if (choice === 0) { event.preventDefault(); return; }
    }
    closing=true;
    window.webContents.executeJavaScript('window.flushReviewDraft ? window.flushReviewDraft() : Promise.resolve()').then(()=>{server.stopJobs();return server.flush();}).then(()=>{quitting=true;window.close();}).catch(()=>{closing=false;dialog.showErrorBox('Work could not be saved','Check disk space and try closing again. Your window remains open.');});
  });
  window.once('ready-to-show', () => window.show());
  await window.loadURL(origin);
  const checkUpdate=async()=>{ const result=await updates.check(); if(result.required){settings.requiredVersion=result.latestVersion;await mkdir(userData,{recursive:true});await writeFile(settingsPath,JSON.stringify(settings));} };
  await checkUpdate();
  const updateTimer=setInterval(()=>checkUpdate().catch(()=>{}),30*60*1000); updateTimer.unref();
}
app.on('window-all-closed', () => { server?.stopJobs(); server?.close(); app.quit(); });
