const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const VideoHubServer = require('./videohub-server');
const SWP08Server = require('./swp08-server');
const GVNativeServer = require('./gvnative-server');

// Controller imports (will be created)
let VideoHubController, SWP08Controller, GVNativeController;
try {
  VideoHubController = require('./videohub-controller');
  SWP08Controller = require('./swp08-controller');
  GVNativeController = require('./gvnative-controller');
} catch (e) {
  // Controllers not yet implemented
}

let mainWindow;
let routerServer;      // For simulator mode
let controllerInstance; // For controller mode
let currentProtocol = 'videohub';
let currentMode = 'simulator';  // 'simulator', 'controller', or 'dual'
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
    mode: 'simulator',
    protocol: 'videohub',
    inputs: 12,
    outputs: 12,
    levels: 1,
    port: 9990,
    modelName: 'Blackmagic Smart Videohub 12x12',
    friendlyName: 'VideoHub Simulator',
    autoStart: false,
    // Controller settings
    controllerHost: '192.168.1.100',
    controllerPort: 9990,
    controllerLevels: 1,
    autoReconnect: true,
    autoConnect: false
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

function attachControllerEvents(controller) {
  controller.on('connected', (data) => {
    sendToRenderer('router-connected', { state: controller.getState() });
    sendToRenderer('state-updated', controller.getState());
  });

  controller.on('disconnected', () => {
    sendToRenderer('router-disconnected');
  });

  controller.on('reconnecting', (attempt) => {
    sendToRenderer('router-reconnecting', attempt);
  });

  controller.on('routing-changed', (changes) => {
    sendToRenderer('routing-changed', changes);
    sendToRenderer('state-updated', controller.getState());
  });

  controller.on('input-labels-changed', (changes) => {
    sendToRenderer('input-labels-changed', changes);
    sendToRenderer('state-updated', controller.getState());
  });

  controller.on('output-labels-changed', (changes) => {
    sendToRenderer('output-labels-changed', changes);
    sendToRenderer('state-updated', controller.getState());
  });

  controller.on('state-updated', (state) => {
    sendToRenderer('state-updated', state);
  });

  controller.on('error', (err) => {
    sendToRenderer('router-error', err.message || err);
  });
}

function createController(protocol, config = {}) {
  if (protocol === 'swp08' && SWP08Controller) {
    return new SWP08Controller(config);
  } else if (protocol === 'gvnative' && GVNativeController) {
    return new GVNativeController(config);
  } else if (VideoHubController) {
    return new VideoHubController(config);
  }
  return null;
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
  } else if (protocol === 'gvnative') {
    return new GVNativeServer({
      port: config.port || 12345,
      inputs: defaultConfig.inputs,
      outputs: defaultConfig.outputs,
      levels: config.levels || 1,
      modelName: config.modelName || 'GV Native Router',
      friendlyName: config.friendlyName || 'GV Native Simulator'
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
    const instance = currentMode === 'controller' && controllerInstance ? controllerInstance : routerServer;
    return {
      ...instance.getState(),
      protocol: currentProtocol
    };
  });

  ipcMain.handle('set-route', async (event, output, input, level = 0, target) => {
    // In dual mode, use target to determine where to route
    if (currentMode === 'dual') {
      if (target === 'controller' && controllerInstance && controllerInstance.isConnected()) {
        return controllerInstance.setRoute(output, input, level);
      }
      return routerServer.setRoute(output, input, level);
    }
    // In controller mode, always use controller if connected
    if (currentMode === 'controller' && controllerInstance && controllerInstance.isConnected()) {
      return controllerInstance.setRoute(output, input, level);
    }
    return routerServer.setRoute(output, input, level);
  });

  ipcMain.handle('get-routing-for-level', (event, level) => {
    const instance = currentMode === 'controller' && controllerInstance ? controllerInstance : routerServer;
    if ((currentProtocol === 'swp08' || currentProtocol === 'gvnative') && instance.getRoutingForLevel) {
      return instance.getRoutingForLevel(level);
    }
    return instance.getState().routing;
  });

  ipcMain.handle('set-level-name', (event, level, name) => {
    const instance = currentMode === 'controller' && controllerInstance ? controllerInstance : routerServer;
    if ((currentProtocol === 'swp08' || currentProtocol === 'gvnative') && instance.setLevelName) {
      return instance.setLevelName(level, name);
    }
    return false;
  });

  ipcMain.handle('set-input-label', async (event, input, label) => {
    if (currentMode === 'controller' && controllerInstance && controllerInstance.isConnected()) {
      return controllerInstance.setInputLabel(input, label);
    }
    return routerServer.setInputLabel(input, label);
  });

  ipcMain.handle('set-output-label', async (event, output, label) => {
    if (currentMode === 'controller' && controllerInstance && controllerInstance.isConnected()) {
      return controllerInstance.setOutputLabel(output, label);
    }
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

  // Mode control
  ipcMain.handle('get-mode', () => {
    return currentMode;
  });

  ipcMain.handle('set-mode', async (event, mode) => {
    currentMode = mode;
    settings.mode = mode;
    saveSettings();
    return { success: true, mode };
  });

  // Controller mode handlers
  ipcMain.handle('connect-router', async (event, config) => {
    try {
      // Save controller settings
      settings.controllerHost = config.host;
      settings.controllerPort = config.port;
      if (config.levels) settings.controllerLevels = config.levels;
      saveSettings();

      // Clean up existing controller if any
      if (controllerInstance) {
        controllerInstance.removeAllListeners();
        await controllerInstance.disconnect().catch(() => {});
      }

      // Create new controller
      controllerInstance = createController(currentProtocol, {
        host: config.host,
        port: config.port,
        levels: config.levels || 1,
        autoReconnect: settings.autoReconnect,
        timeout: 5000
      });

      if (!controllerInstance) {
        return { success: false, error: 'Controller not available for this protocol' };
      }

      attachControllerEvents(controllerInstance);

      // Connect
      await controllerInstance.connect();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('disconnect-router', async () => {
    try {
      if (controllerInstance) {
        await controllerInstance.disconnect();
        controllerInstance.removeAllListeners();
        controllerInstance = null;
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-connection-status', () => {
    if (!controllerInstance) {
      return { connected: false };
    }
    return {
      connected: controllerInstance.isConnected(),
      host: settings.controllerHost,
      port: settings.controllerPort
    };
  });

  // Dual mode handlers
  ipcMain.handle('start-dual-mode', async () => {
    try {
      // Ensure simulator is running
      if (!routerServer.server?.listening) {
        await routerServer.start();
      }

      const simulatorPort = routerServer.port;

      // Clean up existing controller if any
      if (controllerInstance) {
        controllerInstance.removeAllListeners();
        await controllerInstance.disconnect().catch(() => {});
      }

      // Create controller pointing to local simulator
      controllerInstance = createController(currentProtocol, {
        host: '127.0.0.1',
        port: simulatorPort,
        levels: settings.levels || 1,
        autoReconnect: true,
        timeout: 5000
      });

      if (!controllerInstance) {
        return { success: false, error: 'Controller not available for this protocol' };
      }

      attachControllerEvents(controllerInstance);

      // Connect controller to simulator
      await controllerInstance.connect();

      return { success: true, simulatorPort };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('stop-dual-mode', async () => {
    try {
      // Disconnect controller
      if (controllerInstance) {
        await controllerInstance.disconnect().catch(() => {});
        controllerInstance.removeAllListeners();
        controllerInstance = null;
      }

      // Stop simulator
      if (routerServer.server?.listening) {
        await routerServer.stop();
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('get-simulator-state', () => {
    return {
      ...routerServer.getState(),
      protocol: currentProtocol
    };
  });

  ipcMain.handle('get-controller-state', () => {
    if (!controllerInstance) {
      return null;
    }
    return {
      ...controllerInstance.getState(),
      protocol: currentProtocol
    };
  });
}

app.whenReady().then(async () => {
  // Load saved settings
  loadSettings();

  // Set mode from settings
  currentMode = settings.mode || 'simulator';

  // Initialize server with saved settings (always create simulator server for fallback)
  initializeServer(settings.protocol, settings);
  setupIpcHandlers();
  createWindow();

  // Auto-start server if enabled (only in simulator mode)
  if (currentMode === 'simulator' && settings.autoStart) {
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
  if (controllerInstance) {
    await controllerInstance.disconnect().catch(() => {});
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  if (routerServer) {
    await routerServer.stop();
  }
  if (controllerInstance) {
    await controllerInstance.disconnect().catch(() => {});
  }
});
