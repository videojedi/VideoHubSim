const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const VideoHubServer = require('./videohub-server');

let mainWindow;
let videoHubServer;

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'VideoHub Simulator',
    backgroundColor: '#1a1a2e'
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

function initializeServer() {
  videoHubServer = new VideoHubServer({
    port: 9990,
    inputs: 12,
    outputs: 12,
    modelName: 'Blackmagic Smart Videohub 12x12',
    friendlyName: 'VideoHub Simulator'
  });

  // Forward events to renderer
  videoHubServer.on('started', (port) => {
    sendToRenderer('server-started', port);
  });

  videoHubServer.on('stopped', () => {
    sendToRenderer('server-stopped');
  });

  videoHubServer.on('client-connected', (clientId) => {
    sendToRenderer('client-connected', clientId);
    sendToRenderer('state-updated', videoHubServer.getState());
  });

  videoHubServer.on('client-disconnected', (clientId) => {
    sendToRenderer('client-disconnected', clientId);
    sendToRenderer('state-updated', videoHubServer.getState());
  });

  videoHubServer.on('routing-changed', (changes) => {
    sendToRenderer('routing-changed', changes);
    sendToRenderer('state-updated', videoHubServer.getState());
  });

  videoHubServer.on('input-labels-changed', (changes) => {
    sendToRenderer('input-labels-changed', changes);
    sendToRenderer('state-updated', videoHubServer.getState());
  });

  videoHubServer.on('output-labels-changed', (changes) => {
    sendToRenderer('output-labels-changed', changes);
    sendToRenderer('state-updated', videoHubServer.getState());
  });

  videoHubServer.on('command-received', (data) => {
    sendToRenderer('command-received', data);
  });

  videoHubServer.on('error', (err) => {
    sendToRenderer('server-error', err.message);
  });
}

function setupIpcHandlers() {
  ipcMain.handle('start-server', async () => {
    try {
      const port = await videoHubServer.start();
      return { success: true, port };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('stop-server', async () => {
    try {
      await videoHubServer.stop();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-state', () => {
    return videoHubServer.getState();
  });

  ipcMain.handle('set-route', (event, output, input) => {
    return videoHubServer.setRoute(output, input);
  });

  ipcMain.handle('set-input-label', (event, input, label) => {
    return videoHubServer.setInputLabel(input, label);
  });

  ipcMain.handle('set-output-label', (event, output, label) => {
    return videoHubServer.setOutputLabel(output, label);
  });

  ipcMain.handle('update-config', async (event, config) => {
    const wasRunning = videoHubServer.server?.listening;

    if (wasRunning) {
      await videoHubServer.stop();
    }

    videoHubServer.updateConfig(config);

    if (wasRunning) {
      try {
        await videoHubServer.start();
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    return { success: true, state: videoHubServer.getState() };
  });
}

app.whenReady().then(() => {
  initializeServer();
  setupIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  if (videoHubServer) {
    await videoHubServer.stop();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (videoHubServer) {
    await videoHubServer.stop();
  }
});
