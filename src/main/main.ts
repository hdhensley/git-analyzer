import 'dotenv/config';
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import path from 'path';
import { registerIpcHandlers } from './ipc-handlers';
import { closeDatabase, getUpdateService } from './services';

let mainWindow: BrowserWindow | null = null;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// Pin the userData directory so renaming the app doesn't lose the database
app.setPath('userData', path.join(app.getPath('appData'), 'git-analytics-dashboard'));
app.setName('Git Analyzer');

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required for better-sqlite3
    },
    show: false,
    titleBarStyle: 'hiddenInset',
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('focus', () => {
    mainWindow?.webContents.send('sync:trigger');
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [];

  if (process.platform === 'darwin') {
    const macAppMenu: MenuItemConstructorOptions = {
      label: app.name,
      submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }],
    };
    template.push(macAppMenu);
  }

  template.push(
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Check for Updates...',
          click: async () => {
            try {
              await getUpdateService().checkForUpdates(true);
            } catch (error) {
              console.error('Manual update check failed:', error);
            }
          },
        },
      ],
    }
  );

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  registerIpcHandlers();
  buildAppMenu();
  createWindow();

  if (!isDev) {
    setTimeout(() => {
      getUpdateService()
        .checkForStartupUpdates()
        .catch((error) => {
          console.error('Automatic update check failed:', error);
        });
    }, 5000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('quit', () => {
  closeDatabase();
});
