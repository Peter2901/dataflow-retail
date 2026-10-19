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

app.on('second-instance', () => { if (win) { win.restore(); win.focus(); } });
app.whenReady().then(create);
app.on('window-all-closed', () => app.quit());
