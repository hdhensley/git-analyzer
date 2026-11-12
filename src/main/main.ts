import 'dotenv/config';
import { app, BrowserWindow, Menu, clipboard, dialog, type MenuItemConstructorOptions } from 'electron';
import path from 'path';
import { registerIpcHandlers } from './ipc-handlers';
import { getUpdateService } from './services';
import { SpaceManager } from './spaces/space-manager';
import { McpService } from './mcp/mcp-service';

let mainWindow: BrowserWindow | null = null;
let spaces: SpaceManager;
let mcp: McpService;

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

// Spaces menu: one radio item per space with Cmd/Ctrl+1..9 to switch quickly.
function buildSpacesMenu(): MenuItemConstructorOptions {
  const items: MenuItemConstructorOptions[] = spaces.list().map((space, index) => ({
    label: space.name,
    type: 'radio',
    checked: space.active,
    ...(index < 9 ? { accelerator: `CmdOrCtrl+${index + 1}` } : {}),
    click: () => {
      if (space.active) return;
      try {
        spaces.switchTo(space.id);
        buildAppMenu();
        mainWindow?.webContents.reload();
      } catch (error) {
        // Most likely refused because a sync or import is running.
        dialog.showMessageBox({
          type: 'warning',
          message: 'Could not switch spaces',
          detail: error instanceof Error ? error.message : String(error),
        });
        buildAppMenu(); // Put the radio selection back on the active space.
      }
    },
  }));
  return { label: 'Spaces', submenu: items };
}

function showMcpError(message: string, error: unknown): void {
  dialog.showMessageBox({
    type: 'warning',
    message,
    detail: error instanceof Error ? error.message : String(error),
  });
}

// MCP menu: opt-in local server that lets an LLM client query the active space.
function buildMcpMenu(): MenuItemConstructorOptions {
  return {
    label: 'MCP Server',
    submenu: [
      {
        label: 'Enable MCP Server',
        type: 'checkbox',
        checked: mcp.enabled,
        click: async (item) => {
          try {
            await mcp.setEnabled(item.checked);
          } catch (error) {
            showMcpError('Could not change the MCP server', error);
          }
          buildAppMenu();
        },
      },
      { label: mcp.enabled ? `Listening on ${mcp.url}` : 'Not running', enabled: false },
      { type: 'separator' },
      {
        label: 'Copy Connection Config',
        click: async () => {
          try {
            clipboard.writeText(await mcp.connectionConfig());
          } catch (error) {
            showMcpError('Could not read the MCP token from the keychain', error);
          }
        },
      },
      {
        label: 'Regenerate Token...',
        click: async () => {
          const { response } = await dialog.showMessageBox({
            type: 'warning',
            message: 'Regenerate the MCP token?',
            detail: 'Connected clients will stop working until you give them the new connection config.',
            buttons: ['Regenerate', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
          });
          if (response !== 0) return;
          try {
            await mcp.regenerateToken();
          } catch (error) {
            showMcpError('Could not regenerate the token', error);
          }
          buildAppMenu();
        },
      },
    ],
  };
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
    buildSpacesMenu(),
    buildMcpMenu(),
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
  spaces = new SpaceManager(app.getPath('userData'));
  mcp = new McpService(app.getPath('userData'), spaces);
  registerIpcHandlers(spaces, buildAppMenu);
  mcp.startIfEnabled().finally(buildAppMenu);
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
  mcp?.stop();
  spaces?.close();
});
