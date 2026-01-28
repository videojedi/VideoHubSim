const { app, BrowserWindow, ipcMain, Menu, nativeImage, shell } = require('electron');
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
let routerServer;      // Simulator server (always exists)
let controllerInstance; // Controller (created on connect)
let currentProtocol = 'videohub';
let currentView = 'simulator';  // 'simulator' or 'controller' - just determines what's displayed
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
    view: 'simulator',
    protocol: 'videohub',
    inputs: 12,
    outputs: 12,
    levels: 1,
    port: 9990,
    modelName: 'Blackmagic Smart Videohub 12x12',
    friendlyName: 'VideoHub Simulator',
    autoStart: false,
    // Controller settings
    controllerHost: '127.0.0.1',
    controllerPort: 9990,
    controllerLevels: 1,
    autoReconnect: true,
    autoConnect: false,
    // Router connection history
    routerHistory: []
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

// Check for updates against GitHub releases
async function checkForUpdates() {
  try {
    const https = require('https');
    const currentVersion = app.getVersion();

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.github.com',
        path: '/repos/videojedi/VideoHubSim/releases/latest',
        headers: {
          'User-Agent': 'Router-Protocol-Simulator'
        }
      };

      https.get(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const release = JSON.parse(data);
            const latestVersion = release.tag_name.replace(/^v/, '');
            const releaseUrl = release.html_url;

            // Compare versions
            const isNewer = compareVersions(latestVersion, currentVersion) > 0;

            resolve({
              currentVersion,
              latestVersion,
              updateAvailable: isNewer,
              releaseUrl,
              releaseName: release.name || `v${latestVersion}`
            });
          } catch (e) {
            reject(new Error('Failed to parse release data'));
          }
        });
      }).on('error', reject);
    });
  } catch (error) {
    throw new Error(`Update check failed: ${error.message}`);
  }
}

// Compare semantic versions: returns 1 if a > b, -1 if a < b, 0 if equal
function compareVersions(a, b) {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
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
    sendToRenderer('simulator-state-updated', server.getState());
  });

  server.on('client-disconnected', (clientId) => {
    sendToRenderer('client-disconnected', clientId);
    sendToRenderer('simulator-state-updated', server.getState());
  });

  server.on('routing-changed', (changes) => {
    sendToRenderer('simulator-routing-changed', changes);
    sendToRenderer('simulator-state-updated', server.getState());
  });

  server.on('locks-changed', (changes) => {
    sendToRenderer('simulator-locks-changed', changes);
    sendToRenderer('simulator-state-updated', server.getState());
  });

  server.on('input-labels-changed', (changes) => {
    sendToRenderer('simulator-input-labels-changed', changes);
    sendToRenderer('simulator-state-updated', server.getState());
  });

  server.on('output-labels-changed', (changes) => {
    sendToRenderer('simulator-output-labels-changed', changes);
    sendToRenderer('simulator-state-updated', server.getState());
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
    sendToRenderer('controller-state-updated', controller.getState());
  });

  controller.on('disconnected', () => {
    sendToRenderer('router-disconnected');
  });

  controller.on('reconnecting', (attempt) => {
    sendToRenderer('router-reconnecting', attempt);
  });

  controller.on('routing-changed', (changes) => {
    sendToRenderer('controller-routing-changed', changes);
    sendToRenderer('controller-state-updated', controller.getState());
  });

  controller.on('locks-changed', (changes) => {
    sendToRenderer('controller-locks-changed', changes);
    sendToRenderer('controller-state-updated', controller.getState());
  });

  controller.on('input-labels-changed', (changes) => {
    sendToRenderer('controller-input-labels-changed', changes);
    sendToRenderer('controller-state-updated', controller.getState());
  });

  controller.on('output-labels-changed', (changes) => {
    sendToRenderer('controller-output-labels-changed', changes);
    sendToRenderer('controller-state-updated', controller.getState());
  });

  controller.on('state-updated', (state) => {
    sendToRenderer('controller-state-updated', state);
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
  // Simulator controls
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

  // Get state for simulator or controller
  ipcMain.handle('get-state', (event, target) => {
    if (target === 'controller' && controllerInstance) {
      return {
        ...controllerInstance.getState(),
        protocol: currentProtocol
      };
    }
    return {
      ...routerServer.getState(),
      protocol: currentProtocol
    };
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

  // Routing commands - target specifies simulator or controller
  ipcMain.handle('set-route', async (event, output, input, level = 0, target) => {
    if (target === 'controller' && controllerInstance && controllerInstance.isConnected()) {
      return controllerInstance.setRoute(output, input, level);
    }
    return routerServer.setRoute(output, input, level);
  });

  ipcMain.handle('get-routing-for-level', (event, level, target) => {
    const instance = (target === 'controller' && controllerInstance) ? controllerInstance : routerServer;
    if ((currentProtocol === 'swp08' || currentProtocol === 'gvnative') && instance.getRoutingForLevel) {
      return instance.getRoutingForLevel(level);
    }
    return instance.getState().routing;
  });

  ipcMain.handle('set-level-name', (event, level, name, target) => {
    const instance = (target === 'controller' && controllerInstance) ? controllerInstance : routerServer;
    if ((currentProtocol === 'swp08' || currentProtocol === 'gvnative') && instance.setLevelName) {
      return instance.setLevelName(level, name);
    }
    return false;
  });

  ipcMain.handle('set-input-label', async (event, input, label, target) => {
    if (target === 'controller' && controllerInstance && controllerInstance.isConnected()) {
      return controllerInstance.setInputLabel(input, label);
    }
    return routerServer.setInputLabel(input, label);
  });

  ipcMain.handle('set-output-label', async (event, output, label, target) => {
    if (target === 'controller' && controllerInstance && controllerInstance.isConnected()) {
      return controllerInstance.setOutputLabel(output, label);
    }
    return routerServer.setOutputLabel(output, label);
  });

  ipcMain.handle('set-lock', async (event, output, lock, target) => {
    // Lock control is only available for VideoHub (BlackMagic) protocol
    if (currentProtocol !== 'videohub') {
      return false;
    }
    if (target === 'controller' && controllerInstance && controllerInstance.isConnected()) {
      return controllerInstance.setLock(output, lock);
    }
    if (routerServer.setLock) {
      return routerServer.setLock(output, lock);
    }
    return false;
  });

  // Simulator configuration
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

    // Disconnect controller if connected (protocol change)
    if (controllerInstance) {
      await controllerInstance.disconnect().catch(() => {});
      controllerInstance.removeAllListeners();
      controllerInstance = null;
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

  // Settings
  ipcMain.handle('get-settings', () => {
    return settings;
  });

  ipcMain.handle('set-auto-start', (event, enabled) => {
    settings.autoStart = enabled;
    saveSettings();
    return { success: true };
  });

  // Update checker
  ipcMain.handle('check-for-updates', async () => {
    try {
      const result = await checkForUpdates();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('open-external', async (event, url) => {
    // Only allow opening GitHub URLs for security
    if (url.startsWith('https://github.com/')) {
      await shell.openExternal(url);
      return { success: true };
    }
    return { success: false, error: 'Invalid URL' };
  });

  // Router history management
  ipcMain.handle('get-router-history', () => {
    return settings.routerHistory || [];
  });

  ipcMain.handle('add-router-to-history', (event, router) => {
    if (!settings.routerHistory) settings.routerHistory = [];

    // Create unique key for this router
    const key = `${router.host}:${router.port}:${router.protocol}`;

    // Remove existing entry with same key
    settings.routerHistory = settings.routerHistory.filter(r =>
      `${r.host}:${r.port}:${r.protocol}` !== key
    );

    // Add to beginning of list
    settings.routerHistory.unshift({
      host: router.host,
      port: router.port,
      protocol: router.protocol,
      name: router.name || '',
      lastConnected: new Date().toISOString()
    });

    // Keep only last 10 entries
    settings.routerHistory = settings.routerHistory.slice(0, 10);

    saveSettings();
    return settings.routerHistory;
  });

  ipcMain.handle('remove-router-from-history', (event, index) => {
    if (settings.routerHistory && index >= 0 && index < settings.routerHistory.length) {
      settings.routerHistory.splice(index, 1);
      saveSettings();
    }
    return settings.routerHistory || [];
  });

  // View control (what's displayed in the UI)
  ipcMain.handle('get-view', () => {
    return currentView;
  });

  ipcMain.handle('set-view', async (event, view) => {
    currentView = view;
    settings.view = view;
    saveSettings();
    return { success: true, view };
  });

  // Controller handlers
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

  ipcMain.handle('is-server-running', () => {
    return routerServer.server?.listening || false;
  });

  ipcMain.handle('is-controller-connected', () => {
    return controllerInstance?.isConnected() || false;
  });
}

app.whenReady().then(async () => {
  // Set up About panel
  const iconsPath = path.join(__dirname, '..', 'icons');
  const buildPath = path.join(__dirname, '..', 'build');

  app.setAboutPanelOptions({
    applicationName: 'Router Protocol Simulator',
    applicationVersion: app.getVersion(),
    copyright: '© 2026 Video Walrus Ltd',
    credits: 'Simulates Blackmagic VideoHub, SW-P-08, and GV Native protocols',
    iconPath: path.join(iconsPath, 'VWLogo.png')
  });

  // Create application menu with About
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' }
        ] : [
          { role: 'close' }
        ])
      ]
    },
    ...(!isMac ? [{
      label: 'Help',
      submenu: [
        {
          label: 'About Router Protocol Simulator',
          click: () => {
            const { dialog } = require('electron');
            dialog.showMessageBox({
              type: 'info',
              title: 'About Router Protocol Simulator',
              message: 'Router Protocol Simulator',
              detail: `Version ${app.getVersion()}\n\n© 2026 Video Walrus Ltd\n\nSimulates Blackmagic VideoHub, SW-P-08, and GV Native protocols.`,
              icon: nativeImage.createFromPath(path.join(buildPath, 'icon.png'))
            });
          }
        }
      ]
    }] : [])
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // Load saved settings
  loadSettings();

  // Set view from settings
  currentView = settings.view || 'simulator';

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
