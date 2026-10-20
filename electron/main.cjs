// Windows desktop app wrapper for DataFlow Retail.
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

if (!app.requestSingleInstanceLock()) app.quit();
let win;

function create() {
  win = new BrowserWindow({
    width: 1366, height: 860, minWidth: 1000, minHeight: 640, title: 'DataFlow Retail', backgroundColor: '#0F1B2D',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  Menu.setApplicationMenu(null);
  win.maximize();
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  // Weighing scale: pick the first serial port automatically.
  win.webContents.session.on('select-serial-port', (e, ports, wc, cb) => { e.preventDefault(); cb(ports[0]?.portId || ''); });
  win.webContents.session.setPermissionCheckHandler(() => true);
  win.webContents.session.setDevicePermissionHandler(() => true);
  win.webContents.setWindowOpenHandler(({ url }) => { require('electron').shell.openExternal(url); return { action: 'deny' }; });
}

// Receipt printing straight to the default (thermal) printer, no dialog.
ipcMain.handle('print', () => new Promise(res => win.webContents.print({ silent: true, printBackground: true }, ok => res(ok))));
// Daily automatic backup to Documents\DataFlow Retail Backups.
ipcMain.handle('saveBackup', (e, name, json) => {
  const dir = path.join(app.getPath('documents'), 'DataFlow Retail Backups');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), json);
  return dir;
});

// Free offline bill reading (Smart Scan step 2). The English data ships inside the app (dist/ocr).
let ocrWorker = null;
ipcMain.handle('ocr', async (e, dataUrl) => {
  if (!ocrWorker) {
    const { createWorker } = require('tesseract.js');
    ocrWorker = await createWorker('eng', 1, { langPath: path.join(__dirname, '..', 'dist', 'ocr').replace('app.asar', 'app.asar.unpacked'), gzip: true, cachePath: path.join(app.getPath('userData'), 'ocr-cache') });
    await ocrWorker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
  }
  const buf = Buffer.from(String(dataUrl).replace(/^data:[^;]+;base64,/, ''), 'base64');
  return (await ocrWorker.recognize(buf)).data.text;
});

app.on('second-instance', () => { if (win) { win.restore(); win.focus(); } });
app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());
