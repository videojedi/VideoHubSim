const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const VideoHubServer = require('./videohub-server');
const SWP08Server = require('./swp08-server');

let mainWindow;
let routerServer;
let currentProtocol = 'videohub';

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
    title: 'Router Protocol Simulator',
    backgroundColor: '#1a1a2e'
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

function attachServerEvents(server) {
  server.on('started', (port) => {
    sendToRenderer('server-started', port);
  });

  server.on('stopped', () => {
    sendToRenderer('server-stopped');
  });

  server.on('client-connected', (clientId) => {
    sendToRenderer('client-connected', clientId);
    sendToRenderer('state-updated', server.getState());
  });

  server.on('client-disconnected', (clientId) => {
    sendToRenderer('client-disconnected', clientId);
    sendToRenderer('state-updated', server.getState());
  });

  server.on('routing-changed', (changes) => {
    sendToRenderer('routing-changed', changes);
    sendToRenderer('state-updated', server.getState());
  });

  server.on('input-labels-changed', (changes) => {
    sendToRenderer('input-labels-changed', changes);
    sendToRenderer('state-updated', server.getState());
  });

  server.on('output-labels-changed', (changes) => {
    sendToRenderer('output-labels-changed', changes);
    sendToRenderer('state-updated', server.getState());
  });

  server.on('command-received', (data) => {
    sendToRenderer('command-received', data);
  });

  server.on('error', (err) => {
    sendToRenderer('server-error', err.message);
  });
}

function createServer(protocol, config = {}) {
  const defaultConfig = {
    inputs: 12,
    outputs: 12,
    ...config
  };

  if (protocol === 'swp08') {
    return new SWP08Server({
      port: config.port || 8910,
      inputs: defaultConfig.inputs,
      outputs: defaultConfig.outputs,
      levels: config.levels || 1,
      modelName: config.modelName || 'SW-P-08 Router',
      friendlyName: config.friendlyName || 'SWP08 Simulator'
    });
  } else {
    return new VideoHubServer({
      port: config.port || 9990,
      inputs: defaultConfig.inputs,
      outputs: defaultConfig.outputs,
      modelName: config.modelName || 'Blackmagic Smart Videohub 12x12',
      friendlyName: config.friendlyName || 'VideoHub Simulator'
    });
  }
}

function initializeServer(protocol = 'videohub', config = {}) {
  currentProtocol = protocol;
  routerServer = createServer(protocol, config);
  attachServerEvents(routerServer);
}

function setupIpcHandlers() {
  ipcMain.handle('start-server', async () => {
    try {
      const port = await routerServer.start();
      return { success: true, port };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('stop-server', async () => {
    try {
      await routerServer.stop();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-state', () => {
    return {
      ...routerServer.getState(),
      protocol: currentProtocol
    };
  });

  ipcMain.handle('set-route', (event, output, input) => {
    return routerServer.setRoute(output, input);
  });

  ipcMain.handle('set-input-label', (event, input, label) => {
    return routerServer.setInputLabel(input, label);
  });

  ipcMain.handle('set-output-label', (event, output, label) => {
    return routerServer.setOutputLabel(output, label);
  });

  ipcMain.handle('update-config', async (event, config) => {
    const wasRunning = routerServer.server?.listening;
    const protocolChanged = config.protocol && config.protocol !== currentProtocol;

    if (wasRunning) {
      await routerServer.stop();
    }

    if (protocolChanged) {
      // Create new server with different protocol
      routerServer.removeAllListeners();
      routerServer = createServer(config.protocol, config);
      attachServerEvents(routerServer);
      currentProtocol = config.protocol;
    } else {
      routerServer.updateConfig(config);
    }

    if (wasRunning) {
      try {
        await routerServer.start();
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    return {
      success: true,
      state: {
        ...routerServer.getState(),
        protocol: currentProtocol
      }
    };
  });

  ipcMain.handle('switch-protocol', async (event, protocol) => {
    const wasRunning = routerServer.server?.listening;

    if (wasRunning) {
      await routerServer.stop();
    }

    const oldState = routerServer.getState();
    routerServer.removeAllListeners();

    routerServer = createServer(protocol, {
      inputs: oldState.inputs,
      outputs: oldState.outputs
    });
    attachServerEvents(routerServer);
    currentProtocol = protocol;

    if (wasRunning) {
      try {
        await routerServer.start();
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    return {
      success: true,
      state: {
        ...routerServer.getState(),
        protocol: currentProtocol
      }
    };
  });
}

app.whenReady().then(() => {
  initializeServer('videohub');
  setupIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', async () => {
  if (routerServer) {
    await routerServer.stop();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (routerServer) {
    await routerServer.stop();
  }
});
