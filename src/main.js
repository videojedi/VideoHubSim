const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const VideoHubServer = require('./videohub-server');
const SWP08Server = require('./swp08-server');

let mainWindow;
let routerServer;
let currentProtocol = 'videohub';
let settings = {};

// Settings file path
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// Load settings from disk
function loadSettings() {
  try {
    const settingsPath = getSettingsPath();
    if (fs.existsSync(settingsPath)) {
      const data = fs.readFileSync(settingsPath, 'utf8');
      settings = JSON.parse(data);
      return settings;
    }
  } catch (err) {
    console.error('Failed to load settings:', err);
  }
  // Default settings
  settings = {
    protocol: 'videohub',
    inputs: 12,
    outputs: 12,
    levels: 1,
    port: 9990,
    modelName: 'Blackmagic Smart Videohub 12x12',
    friendlyName: 'VideoHub Simulator',
    autoStart: false
  };
  return settings;
}

// Save settings to disk
function saveSettings() {
  try {
    const settingsPath = getSettingsPath();
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('Failed to save settings:', err);
  }
}

// Update settings from current state
function updateSettings(config) {
  settings = {
    ...settings,
    ...config,
    protocol: currentProtocol
  };
  saveSettings();
}

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

  ipcMain.handle('set-route', (event, output, input, level = 0) => {
    return routerServer.setRoute(output, input, level);
  });

  ipcMain.handle('get-routing-for-level', (event, level) => {
    if (currentProtocol === 'swp08' && routerServer.getRoutingForLevel) {
      return routerServer.getRoutingForLevel(level);
    }
    return routerServer.getState().routing;
  });

  ipcMain.handle('set-level-name', (event, level, name) => {
    if (currentProtocol === 'swp08' && routerServer.setLevelName) {
      return routerServer.setLevelName(level, name);
    }
    return false;
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

    // Save settings
    updateSettings(config);

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

    // Save settings
    updateSettings({ protocol });

    return {
      success: true,
      state: {
        ...routerServer.getState(),
        protocol: currentProtocol
      }
    };
  });

  // Get/set auto-start setting
  ipcMain.handle('get-settings', () => {
    return settings;
  });

  ipcMain.handle('set-auto-start', (event, enabled) => {
    settings.autoStart = enabled;
    saveSettings();
    return { success: true };
  });
}

app.whenReady().then(async () => {
  // Load saved settings
  loadSettings();

  // Initialize server with saved settings
  initializeServer(settings.protocol, settings);
  setupIpcHandlers();
  createWindow();

  // Auto-start server if enabled
  if (settings.autoStart) {
    try {
      await routerServer.start();
    } catch (err) {
      console.error('Auto-start failed:', err);
    }
  }

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
