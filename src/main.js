const { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const VideoHubServer = require('./videohub-server');
const SWP08Server = require('./swp08-server');
const GVNativeServer = require('./gvnative-server');
const ExternalControlServer = require('./external-control-server');

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
let matrixWindow;
let routerServer;      // Simulator server (always exists)
let controllerInstance; // Controller (created on connect)
let externalControlServer;
let currentProtocol = 'videohub';
let currentView = 'simulator';  // 'simulator' or 'controller' - just determines what's displayed
let settings = {};
const ROUTE_HISTORY_PREVIOUS_COUNT = 5;
let routeHistory = { simulator: {}, controller: {} };

// macOS Local Network TCC probe — triggers the system permission prompt
let localNetworkProbed = false;
function probeLocalNetwork() {
  if (process.platform !== 'darwin' || localNetworkProbed) return;
  localNetworkProbed = true;
  try {
    const probePath = path.join(app.isPackaged
      ? process.resourcesPath
      : path.join(__dirname, 'native'), 'probe_local_network.node');
    const addon = require(probePath);
    addon.probe('_blackmagic._tcp');
  } catch (e) {
    console.error('Local network probe failed:', e.message);
  }
}

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
    autoProtect: false,
    externalControl: {
      enabled: true,
      host: '127.0.0.1',
      port: 9123,
      authToken: ''
    },
    // Router connection history
    routerHistory: [],
    // Salvos - captured routing states
    salvos: [],
    // BPS buttons - quick routing shortcuts
    bpsButtons: [],
    // Label colours - per-label fill colours
    inputLabelColors: {},
    outputLabelColors: {}
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
  BrowserWindow.getAllWindows().forEach(window => {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, ...args);
    }
  });

  if (externalControlServer) {
    externalControlServer.publish(channel, args.length <= 1 ? args[0] : args);
  }
}

function getExternalControlConfig() {
  const configured = settings.externalControl || {};

  return {
    enabled: process.env.VIDEOHUBSIM_EXTERNAL_CONTROL_ENABLED
      ? !['0', 'false', 'no'].includes(process.env.VIDEOHUBSIM_EXTERNAL_CONTROL_ENABLED.toLowerCase())
      : configured.enabled !== false,
    host: process.env.VIDEOHUBSIM_EXTERNAL_CONTROL_HOST || configured.host || '127.0.0.1',
    port: Number(process.env.VIDEOHUBSIM_EXTERNAL_CONTROL_PORT || configured.port || 9123),
    authToken: process.env.VIDEOHUBSIM_EXTERNAL_CONTROL_TOKEN || configured.authToken || ''
  };
}

function resolveExternalTarget(target = 'active') {
  if (target === 'controller') {
    return {
      requestedTarget: target,
      target: 'controller',
      instance: controllerInstance && controllerInstance.isConnected() ? controllerInstance : null
    };
  }

  if (target === 'simulator') {
    return {
      requestedTarget: target,
      target: 'simulator',
      instance: routerServer || null
    };
  }

  if (currentView === 'controller' && controllerInstance && controllerInstance.isConnected()) {
    return {
      requestedTarget: target,
      target: 'controller',
      instance: controllerInstance
    };
  }

  return {
    requestedTarget: target,
    target: 'simulator',
    instance: routerServer || null
  };
}

function buildRoutingSnapshot(state, instance) {
  if (!state) {
    return {};
  }

  if (state.allRouting) {
    return state.allRouting;
  }

  if ((currentProtocol === 'swp08' || currentProtocol === 'gvnative') && instance?.getRoutingForLevel) {
    const allRouting = {};
    for (let level = 0; level < (state.levels || 1); level++) {
      allRouting[level] = instance.getRoutingForLevel(level);
    }
    return allRouting;
  }

  return { 0: state.routing || {} };
}

function getMatchingSalvos(state, instance) {
  if (!state || !Array.isArray(settings.salvos)) {
    return [];
  }

  const routingByLevel = buildRoutingSnapshot(state, instance);

  return settings.salvos
    .filter(salvo => !salvo.protocol || salvo.protocol === currentProtocol)
    .filter(salvo => Array.isArray(salvo.routes) && salvo.routes.length > 0)
    .filter(salvo => salvo.routes.every(route => {
      const level = route.level || 0;
      return routingByLevel[level]?.[route.output] === route.input;
    }))
    .map(salvo => ({
      id: salvo.id,
      name: salvo.name,
      color: salvo.color || null
    }));
}

function getExternalControlState(target = 'active') {
  const resolved = resolveExternalTarget(target);
  const state = resolved.instance ? resolved.instance.getState() : null;
  const allRouting = buildRoutingSnapshot(state, resolved.instance);
  const crosspoints = [];

  Object.entries(allRouting).forEach(([levelKey, levelRouting]) => {
    const levelId = Number(levelKey);
    Object.entries(levelRouting || {}).forEach(([outputKey, inputValue]) => {
      const outputId = Number(outputKey);
      const inputId = Number(inputValue);
      crosspoints.push({
        levelId,
        levelNumber: levelId + 1,
        outputId,
        outputNumber: outputId + 1,
        inputId,
        inputNumber: inputId + 1
      });
    });
  });

  return {
    requestedTarget: resolved.requestedTarget,
    target: resolved.target,
    available: Boolean(resolved.instance),
    currentView,
    protocol: currentProtocol,
    indexBase: 0,
    serverRunning: Boolean(routerServer?.server?.listening),
    controllerConnected: Boolean(controllerInstance?.isConnected?.()),
    inputs: state?.inputs || 0,
    outputs: state?.outputs || 0,
    levels: state?.levels || settings.levels || 1,
    routing: state?.routing || {},
    allRouting,
    crosspoints,
    inputLabels: state?.inputLabels || {},
    outputLabels: state?.outputLabels || {},
    levelNames: state?.levelNames || {},
    matchingSalvos: getMatchingSalvos(state, resolved.instance)
  };
}

function getExternalChoices(target = 'active') {
  const state = getExternalControlState(target);
  const levelCount = state.levels || 1;

  return {
    target: state.target,
    protocol: state.protocol,
    inputs: Array.from({ length: state.inputs }, (_, index) => ({
      id: index,
      number: index + 1,
      label: state.inputLabels[index] || `Input ${index + 1}`
    })),
    outputs: Array.from({ length: state.outputs }, (_, index) => ({
      id: index,
      number: index + 1,
      label: state.outputLabels[index] || `Output ${index + 1}`,
      currentInputId: state.routing[index] ?? null,
      currentInput: state.routing[index] !== undefined ? Number(state.routing[index]) + 1 : null
    })),
    levels: Array.from({ length: levelCount }, (_, index) => ({
      id: index,
      number: index + 1,
      label: state.levelNames[index] || `Level ${index + 1}`
    })),
    salvos: (settings.salvos || []).map(salvo => ({
      id: salvo.id,
      label: salvo.name,
      routeCount: Array.isArray(salvo.routes) ? salvo.routes.length : 0,
      color: salvo.color || null,
      protocol: salvo.protocol || null,
      source: salvo.source || null
    }))
  };
}

function getExternalControlStatusData() {
  const config = getExternalControlConfig();

  return {
    enabled: config.enabled,
    host: config.host,
    port: externalControlServer?.getListeningPort() || config.port,
    authTokenConfigured: Boolean(config.authToken),
    running: externalControlServer?.isRunning() || false,
    currentView,
    protocol: currentProtocol,
    serverRunning: Boolean(routerServer?.server?.listening),
    controllerConnected: Boolean(controllerInstance?.isConnected?.())
  };
}

function summarizeSalvos() {
  return (settings.salvos || []).map(salvo => ({
    id: salvo.id,
    name: salvo.name,
    routeCount: Array.isArray(salvo.routes) ? salvo.routes.length : 0,
    protocol: salvo.protocol || null,
    source: salvo.source || null,
    color: salvo.color || null,
    createdAt: salvo.createdAt || null,
    updatedAt: salvo.updatedAt || null
  }));
}

function emitSalvosChanged(target = 'active') {
  sendToRenderer('salvos-changed', {
    salvos: summarizeSalvos(),
    matchingSalvos: getExternalControlState(target).matchingSalvos
  });
}

function emitExternalControlStatusChanged() {
  sendToRenderer('external-control-status-changed', getExternalControlStatusData());
}

function getExternalControlHealth() {
  return {
    success: true,
    data: getExternalControlStatusData()
  };
}

function buildCapturedSalvo({ name, selectedOutputs, target = 'simulator', selectedLevel } = {}) {
  const instance = (target === 'controller' && controllerInstance && controllerInstance.isConnected())
    ? controllerInstance
    : routerServer;

  if (!instance) {
    throw new Error(`Target ${target} is not available`);
  }

  const state = instance.getState();
  const routes = [];
  const outputsToCapture = selectedOutputs && selectedOutputs.length > 0
    ? selectedOutputs
    : Array.from({ length: state.outputs }, (_, index) => index);
  const isMultiLevel = currentProtocol === 'swp08' || currentProtocol === 'gvnative';

  if (isMultiLevel && state.allRouting) {
    const levelsToCapture = selectedLevel !== null && selectedLevel !== undefined
      ? [selectedLevel]
      : Object.keys(state.allRouting).map(level => parseInt(level, 10));

    for (const level of levelsToCapture) {
      const levelRouting = state.allRouting[level];
      if (!levelRouting) continue;

      for (const output of outputsToCapture) {
        if (levelRouting[output] === undefined) continue;

        routes.push({
          output: parseInt(output, 10),
          input: levelRouting[output],
          level: parseInt(level, 10),
          outputLabel: state.outputLabels[output] || `Output ${parseInt(output, 10) + 1}`,
          inputLabel: state.inputLabels[levelRouting[output]] || `Input ${levelRouting[output] + 1}`,
          levelName: state.levelNames?.[level] || `Level ${parseInt(level, 10) + 1}`
        });
      }
    }
  } else {
    for (const output of outputsToCapture) {
      if (state.routing[output] === undefined) continue;

      routes.push({
        output: parseInt(output, 10),
        input: state.routing[output],
        level: 0,
        outputLabel: state.outputLabels[output] || `Output ${parseInt(output, 10) + 1}`,
        inputLabel: state.inputLabels[state.routing[output]] || `Input ${state.routing[output] + 1}`
      });
    }
  }

  return {
    id: generateSalvoId(),
    name: name || `Salvo ${(settings.salvos?.length || 0) + 1}`,
    routes,
    protocol: currentProtocol,
    source: target,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function saveCapturedSalvo(salvo) {
  if (!settings.salvos) settings.salvos = [];
  settings.salvos.push(salvo);
  saveSettings();
  emitSalvosChanged(salvo.source || 'active');
  return { success: true, salvo, salvos: settings.salvos };
}

async function updateExternalControlConfig(config = {}) {
  settings.externalControl = {
    ...(settings.externalControl || {}),
    ...config
  };
  saveSettings();

  const resolvedConfig = getExternalControlConfig();

  if (!externalControlServer) {
    return { success: false, error: 'External control server not available' };
  }

  if (externalControlServer.isRunning()) {
    await externalControlServer.stop().catch(() => {});
  }

  if (resolvedConfig.enabled) {
    await externalControlServer.start(resolvedConfig);
  }

  emitExternalControlStatusChanged();

  return {
    success: true,
    externalControl: getExternalControlStatusData()
  };
}

async function setExternalRoute({ output, input, level = 0, target = 'active' } = {}) {
  const outputId = Number.isInteger(arguments[0]?.outputId) ? arguments[0].outputId : Number(output) - 1;
  const inputId = Number.isInteger(arguments[0]?.inputId) ? arguments[0].inputId : Number(input) - 1;
  const levelId = Number.isInteger(arguments[0]?.levelId) ? arguments[0].levelId : Number(level || 1) - 1;

  if (![outputId, inputId, levelId].every(Number.isInteger)) {
    throw new Error('output/input/level must be integers');
  }

  if (outputId < 0 || inputId < 0 || levelId < 0) {
    throw new Error('output/input/level must be 1-based numbers or explicit zero-based ids');
  }

  const resolved = resolveExternalTarget(target);
  if (!resolved.instance) {
    throw new Error(`Target ${resolved.target} is not available`);
  }

  await resolved.instance.setRoute(outputId, inputId, levelId);

  return {
    target: resolved.target,
    outputId,
    output: outputId + 1,
    inputId,
    input: inputId + 1,
    levelId,
    level: levelId + 1,
    state: getExternalControlState(resolved.target)
  };
}

async function recallExternalSalvo({ salvoId, target = 'active' } = {}) {
  const salvo = (settings.salvos || []).find(entry => entry.id === salvoId);
  if (!salvo) {
    throw new Error('Salvo not found');
  }

  const resolved = resolveExternalTarget(target);
  if (!resolved.instance) {
    throw new Error(`Target ${resolved.target} is not available`);
  }

  const errors = [];

  for (const route of salvo.routes || []) {
    try {
      await resolved.instance.setRoute(route.output, route.input, route.level || 0);
    } catch (err) {
      errors.push(`Route ${route.output}->${route.input}: ${err.message}`);
    }
  }

  return {
    success: errors.length === 0,
    salvoId,
    target: resolved.target,
    appliedCount: (salvo.routes || []).length - errors.length,
    errors,
    state: getExternalControlState(resolved.target)
  };
}

async function captureExternalSalvo({ name, target = 'active', includeAllOutputs = true, selectedOutputs, level } = {}) {
  const resolved = resolveExternalTarget(target);
  if (!resolved.instance) {
    throw new Error(`Target ${resolved.target} is not available`);
  }

  const selectedLevel = level === 'all' || level === undefined || level === null
    ? null
    : (Number.isInteger(level) ? level : Number(level) - 1);
  const outputs = includeAllOutputs
    ? null
    : (Array.isArray(selectedOutputs) ? selectedOutputs.map(value => Number.isInteger(value) ? value : Number(value) - 1) : []);

  if (outputs && outputs.some(output => !Number.isInteger(output) || output < 0)) {
    throw new Error('selectedOutputs must contain 1-based numbers or explicit zero-based ids');
  }

  if (selectedLevel !== null && (!Number.isInteger(selectedLevel) || selectedLevel < 0)) {
    throw new Error('level must be "all", a 1-based number, or an explicit zero-based id');
  }

  const salvo = buildCapturedSalvo({
    name,
    selectedOutputs: outputs,
    target: resolved.target,
    selectedLevel
  });

  return saveCapturedSalvo(salvo);
}

function createExternalControlServer() {
  externalControlServer = new ExternalControlServer({
    getHealth: getExternalControlHealth,
    getState: getExternalControlState,
    getChoices: getExternalChoices,
    getSalvos: () => settings.salvos || [],
    setRoute: setExternalRoute,
    recallSalvo: recallExternalSalvo,
    captureSalvo: captureExternalSalvo
  });
}

function generateSalvoId(suffix = '') {
  return `salvo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}${suffix}`;
}

function getRouteHistoryKey(level, output) {
  return `${level}:${output}`;
}

function broadcastRouteHistory(target) {
  sendToRenderer('route-history-updated', {
    target,
    history: routeHistory[target] || {}
  });
}

function resetRouteHistoryForTarget(target, state, instance) {
  routeHistory[target] = {};

  if (!state || !instance) {
    broadcastRouteHistory(target);
    return;
  }

  const timestamp = Date.now();
  const levels = (currentProtocol === 'swp08' || currentProtocol === 'gvnative') ? (state.levels || 1) : 1;

  for (let level = 0; level < levels; level++) {
    const routing = (currentProtocol === 'swp08' || currentProtocol === 'gvnative') && instance.getRoutingForLevel
      ? instance.getRoutingForLevel(level)
      : state.routing;

    if (!routing) continue;

    for (let output = 0; output < (state.outputs || 0); output++) {
      const input = routing[output];
      if (input === undefined || input === null) continue;
      routeHistory[target][getRouteHistoryKey(level, output)] = [{ input, timestamp }];
    }
  }

  broadcastRouteHistory(target);
}

function recordRouteHistoryEntries(target, changes) {
  if (!routeHistory[target]) {
    routeHistory[target] = {};
  }

  const timestamp = Date.now();
  changes.forEach(change => {
    const level = change.level ?? 0;
    const key = getRouteHistoryKey(level, change.output);
    const entries = routeHistory[target][key] ? [...routeHistory[target][key]] : [];

    if (entries[0]?.input === change.input) {
      entries[0] = { input: change.input, timestamp };
    } else {
      entries.unshift({ input: change.input, timestamp });
    }

    routeHistory[target][key] = entries.slice(0, ROUTE_HISTORY_PREVIOUS_COUNT + 1);
  });

  broadcastRouteHistory(target);
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
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

function createMatrixWindow() {
  if (matrixWindow && !matrixWindow.isDestroyed()) {
    if (matrixWindow.isMinimized()) matrixWindow.restore();
    matrixWindow.focus();
    return matrixWindow;
  }

  matrixWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: 'New Matrix Window',
    backgroundColor: '#0d1117'
  });

  matrixWindow.loadFile(path.join(__dirname, 'index.html'), {
    query: { matrixOnly: '1' }
  });

  matrixWindow.on('closed', () => {
    matrixWindow = null;
  });

  if (process.argv.includes('--dev')) {
    matrixWindow.webContents.openDevTools({ mode: 'detach' });
  }

  return matrixWindow;
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
    recordRouteHistoryEntries('simulator', changes);
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
    // Persist labels to disk
    const state = server.getState();
    settings.inputLabels = state.inputLabels;
    saveSettings();
  });

  server.on('output-labels-changed', (changes) => {
    sendToRenderer('simulator-output-labels-changed', changes);
    sendToRenderer('simulator-state-updated', server.getState());
    // Persist labels to disk
    const state = server.getState();
    settings.outputLabels = state.outputLabels;
    saveSettings();
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
    resetRouteHistoryForTarget('controller', controller.getState(), controller);
    sendToRenderer('router-connected', { state: controller.getState() });
    sendToRenderer('controller-state-updated', controller.getState());
  });

  controller.on('disconnected', () => {
    resetRouteHistoryForTarget('controller', null, null);
    sendToRenderer('router-disconnected');
  });

  controller.on('reconnecting', (attempt) => {
    sendToRenderer('router-reconnecting', attempt);
  });

  controller.on('routing-changed', (changes) => {
    recordRouteHistoryEntries('controller', changes);
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
      friendlyName: config.friendlyName || 'VideoHub Simulator',
      inputLabels: settings.inputLabels || {},
      outputLabels: settings.outputLabels || {}
    });
  }
}

function initializeServer(protocol = 'videohub', config = {}) {
  currentProtocol = protocol;
  routerServer = createServer(protocol, config);
  attachServerEvents(routerServer);
  resetRouteHistoryForTarget('simulator', routerServer.getState(), routerServer);
}

function setupIpcHandlers() {
  // Simulator controls
  ipcMain.handle('start-server', async () => {
    try {
      probeLocalNetwork();
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

  ipcMain.handle('get-route-history', (event, target = 'simulator') => {
    return routeHistory[target] || {};
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

  ipcMain.handle('reset-labels-to-defaults', async (event, labelType = 'all', target = 'simulator', mode = 'default') => {
    const instance = (target === 'controller' && controllerInstance && controllerInstance.isConnected())
      ? controllerInstance
      : routerServer;

    const state = instance.getState();
    const defaultInputs = instance.defaultInputLabels || [];
    const defaultOutputs = instance.defaultOutputLabels || [];
    const clearLabels = mode === 'clear';

    if (labelType === 'all' || labelType === 'input') {
      for (let i = 0; i < state.inputs; i++) {
        await instance.setInputLabel(i, clearLabels ? '' : (defaultInputs[i] || `Input ${i + 1}`));
      }
    }

    if (labelType === 'all' || labelType === 'output') {
      for (let i = 0; i < state.outputs; i++) {
        await instance.setOutputLabel(i, clearLabels ? '' : (defaultOutputs[i] || `Output ${i + 1}`));
      }
    }

    if (instance === routerServer && !clearLabels) {
      if (labelType === 'all' || labelType === 'input') {
        delete settings.inputLabels;
      }
      if (labelType === 'all' || labelType === 'output') {
        delete settings.outputLabels;
      }
      saveSettings();
    }

    return true;
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
      resetRouteHistoryForTarget('controller', null, null);
    } else {
      routerServer.updateConfig(config);
    }

    resetRouteHistoryForTarget('simulator', routerServer.getState(), routerServer);

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
    resetRouteHistoryForTarget('simulator', routerServer.getState(), routerServer);
    resetRouteHistoryForTarget('controller', null, null);

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

  ipcMain.handle('get-external-control-status', () => {
    return getExternalControlStatusData();
  });

  ipcMain.handle('update-external-control-config', async (event, config) => {
    try {
      return await updateExternalControlConfig(config);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('set-auto-start', (event, enabled) => {
    settings.autoStart = enabled;
    saveSettings();
    return { success: true };
  });

  ipcMain.handle('set-auto-connect', (event, enabled) => {
    settings.autoConnect = enabled;
    saveSettings();
    return { success: true };
  });

  ipcMain.handle('set-auto-reconnect', (event, enabled) => {
    settings.autoReconnect = enabled;
    saveSettings();
    return { success: true };
  });

  ipcMain.handle('set-auto-protect', (event, enabled) => {
    settings.autoProtect = enabled;
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
    sendToRenderer('view-changed', view);
    return { success: true, view };
  });

  ipcMain.handle('open-matrix-window', async () => {
    createMatrixWindow();
    return { success: true };
  });

  // Controller handlers
  ipcMain.handle('connect-router', async (event, config) => {
    try {
      probeLocalNetwork();
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
      resetRouteHistoryForTarget('controller', null, null);
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

  // Salvo management
  ipcMain.handle('get-salvos', () => {
    return settings.salvos || [];
  });

  ipcMain.handle('save-salvo', (event, salvo) => {
    if (!settings.salvos) settings.salvos = [];

    // Generate unique ID if not provided
    if (!salvo.id) {
      salvo.id = generateSalvoId();
    }
    salvo.createdAt = salvo.createdAt || new Date().toISOString();
    salvo.updatedAt = new Date().toISOString();

    // Check if updating existing salvo
    const existingIndex = settings.salvos.findIndex(s => s.id === salvo.id);
    if (existingIndex >= 0) {
      settings.salvos[existingIndex] = salvo;
    } else {
      settings.salvos.push(salvo);
    }

    saveSettings();
    emitSalvosChanged(salvo.source || 'active');
    return { success: true, salvo, salvos: settings.salvos };
  });

  ipcMain.handle('duplicate-salvo', (event, salvoId) => {
    if (!settings.salvos) return { success: false, error: 'No salvos found' };

    const sourceSalvo = settings.salvos.find(s => s.id === salvoId);
    if (!sourceSalvo) return { success: false, error: 'Salvo not found' };

    const duplicatedSalvo = {
      ...sourceSalvo,
      id: generateSalvoId(),
      name: `${sourceSalvo.name} Copy`,
      routes: Array.isArray(sourceSalvo.routes)
        ? sourceSalvo.routes.map(route => ({ ...route }))
        : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    settings.salvos.push(duplicatedSalvo);
    saveSettings();
    emitSalvosChanged(duplicatedSalvo.source || 'active');

    return { success: true, salvo: duplicatedSalvo, salvos: settings.salvos };
  });

  ipcMain.handle('delete-salvo', (event, salvoId) => {
    if (!settings.salvos) return { success: false, error: 'No salvos found' };

    const index = settings.salvos.findIndex(s => s.id === salvoId);
    if (index < 0) return { success: false, error: 'Salvo not found' };

    settings.salvos.splice(index, 1);
    saveSettings();
    emitSalvosChanged(salvo.source || 'active');
    return { success: true, salvos: settings.salvos };
  });

  ipcMain.handle('reorder-salvos', (event, orderedIds) => {
    if (!settings.salvos) return { success: false };
    const ordered = orderedIds.map(id => settings.salvos.find(s => s.id === id)).filter(Boolean);
    settings.salvos = ordered;
    saveSettings();
    emitSalvosChanged('active');
    return { success: true, salvos: settings.salvos };
  });

  ipcMain.handle('set-salvo-color', (event, salvoId, color) => {
    if (!settings.salvos) return { success: false };
    const salvo = settings.salvos.find(s => s.id === salvoId);
    if (!salvo) return { success: false };
    salvo.color = color || null;
    saveSettings();
    emitSalvosChanged(salvo.source || 'active');
    return { success: true, salvos: settings.salvos };
  });

  ipcMain.handle('recall-salvo', async (event, salvoId, target) => {
    if (!settings.salvos) return { success: false, error: 'No salvos found' };

    const salvo = settings.salvos.find(s => s.id === salvoId);
    if (!salvo) return { success: false, error: 'Salvo not found' };

    const instance = (target === 'controller' && controllerInstance && controllerInstance.isConnected())
      ? controllerInstance
      : routerServer;

    const errors = [];
    const appliedRoutes = [];

    // Apply routing changes
    if (salvo.routes) {
      for (const route of salvo.routes) {
        try {
          const level = route.level || 0;
          await instance.setRoute(route.output, route.input, level);
          appliedRoutes.push({ ...route, level });
        } catch (err) {
          errors.push(`Route ${route.output}->${route.input}: ${err.message}`);
        }
      }
    }

    return {
      success: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
      appliedCount: appliedRoutes.length,
      appliedRoutes
    };
  });

  ipcMain.handle('capture-salvo', (event, name, selectedOutputs, target, selectedLevel) => {
    try {
      const salvo = buildCapturedSalvo({
        name,
        selectedOutputs,
        target,
        selectedLevel
      });

      return saveCapturedSalvo(salvo);
    } catch (err) {
      console.error('Error capturing salvo:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('export-salvos', async () => {
    const salvos = settings.salvos || [];
    if (salvos.length === 0) {
      return { success: false, error: 'No salvos to export' };
    }

    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export Salvos',
      defaultPath: `salvos-export.csv`,
      filters: [{ name: 'CSV Files', extensions: ['csv'] }]
    });

    if (canceled || !filePath) return { success: false, error: 'Cancelled' };

    // Build CSV: salvo_name, output, input, level, output_label, input_label, level_name, protocol, source
    const header = 'salvo_name,output,input,level,output_label,input_label,level_name,protocol,source,created_at';
    const rows = [];
    for (const salvo of salvos) {
      for (const route of salvo.routes) {
        rows.push([
          csvEscape(salvo.name),
          route.output,
          route.input,
          route.level || 0,
          csvEscape(route.outputLabel || ''),
          csvEscape(route.inputLabel || ''),
          csvEscape(route.levelName || ''),
          csvEscape(salvo.protocol || ''),
          csvEscape(salvo.source || ''),
          csvEscape(salvo.createdAt || '')
        ].join(','));
      }
    }

    const csv = header + '\n' + rows.join('\n') + '\n';
    fs.writeFileSync(filePath, csv, 'utf-8');
    return { success: true, count: salvos.length, filePath };
  });

  ipcMain.handle('import-salvos', async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import Salvos',
      filters: [{ name: 'CSV Files', extensions: ['csv'] }],
      properties: ['openFile']
    });

    if (canceled || !filePaths || filePaths.length === 0) {
      return { success: false, error: 'Cancelled' };
    }

    try {
      const csv = fs.readFileSync(filePaths[0], 'utf-8');
      const lines = csv.split('\n').filter(l => l.trim());
      if (lines.length < 2) {
        return { success: false, error: 'CSV file is empty or has no data rows' };
      }

      // Skip header, group rows by salvo name
      const salvoMap = {};
      for (let i = 1; i < lines.length; i++) {
        const fields = csvParseLine(lines[i]);
        if (fields.length < 6) continue;

        const name = fields[0];
        if (!salvoMap[name]) {
          salvoMap[name] = {
            id: generateSalvoId(`_${i}`),
            name,
            routes: [],
            protocol: fields[7] || 'videohub',
            source: fields[8] || 'simulator',
            createdAt: fields[9] || new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
        }

        salvoMap[name].routes.push({
          output: parseInt(fields[1]) || 0,
          input: parseInt(fields[2]) || 0,
          level: parseInt(fields[3]) || 0,
          outputLabel: fields[4] || '',
          inputLabel: fields[5] || '',
          levelName: fields[6] || ''
        });
      }

      const imported = Object.values(salvoMap);
      if (imported.length === 0) {
        return { success: false, error: 'No valid salvos found in CSV' };
      }

      // Check for duplicates by name
      const existingSalvos = settings.salvos || [];
      const existingNames = new Set(existingSalvos.map(s => s.name));
      const duplicateNames = imported.filter(s => existingNames.has(s.name)).map(s => s.name);

      if (duplicateNames.length > 0) {
        return { success: true, needsResolution: true, imported, duplicateNames };
      }

      // No duplicates - just add all
      if (!settings.salvos) settings.salvos = [];
      settings.salvos.push(...imported);
      saveSettings();
      emitSalvosChanged('active');

      return { success: true, count: imported.length, salvos: settings.salvos };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('import-salvos-resolve', (event, imported, resolution) => {
    if (!settings.salvos) settings.salvos = [];
    emitSalvosChanged('active');

    const existingByName = {};
    settings.salvos.forEach(s => { existingByName[s.name] = s; });

    let added = 0;
    for (const salvo of imported) {
      const existing = existingByName[salvo.name];
      if (existing) {
        if (resolution === 'overwrite') {
          const idx = settings.salvos.findIndex(s => s.id === existing.id);
          if (idx >= 0) {
            salvo.id = existing.id;
            salvo.updatedAt = new Date().toISOString();
            settings.salvos[idx] = salvo;
          }
          added++;
        } else if (resolution === 'rename') {
          let newName = salvo.name + ' (imported)';
          let counter = 2;
          const allNames = new Set(settings.salvos.map(s => s.name));
          while (allNames.has(newName)) {
            newName = salvo.name + ` (imported ${counter})`;
            counter++;
          }
          salvo.name = newName;
          settings.salvos.push(salvo);
          added++;
        }
        // skip: do nothing
      } else {
        settings.salvos.push(salvo);
        added++;
      }
    }

    saveSettings();
    return { success: true, count: added, salvos: settings.salvos };
  });

  // BPS buttons
  ipcMain.handle('get-bps-buttons', () => {
    return settings.bpsButtons || [];
  });

  ipcMain.handle('save-bps-button', (event, button) => {
    if (!settings.bpsButtons) settings.bpsButtons = [];
    if (button.id) {
      const idx = settings.bpsButtons.findIndex(b => b.id === button.id);
      if (idx >= 0) {
        settings.bpsButtons[idx] = button;
      } else {
        settings.bpsButtons.push(button);
      }
    } else {
      button.id = `bps_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      settings.bpsButtons.push(button);
    }
    saveSettings();
    return { success: true, bpsButtons: settings.bpsButtons };
  });

  ipcMain.handle('delete-bps-button', (event, buttonId) => {
    if (!settings.bpsButtons) return { success: false };
    settings.bpsButtons = settings.bpsButtons.filter(b => b.id !== buttonId);
    saveSettings();
    return { success: true, bpsButtons: settings.bpsButtons };
  });

  ipcMain.handle('reorder-bps-buttons', (event, orderedIds) => {
    if (!settings.bpsButtons) return { success: false };
    const ordered = orderedIds.map(id => settings.bpsButtons.find(b => b.id === id)).filter(Boolean);
    settings.bpsButtons = ordered;
    saveSettings();
    return { success: true, bpsButtons: settings.bpsButtons };
  });

  // Label colours
  ipcMain.handle('get-label-colors', () => {
    return {
      inputLabelColors: settings.inputLabelColors || {},
      outputLabelColors: settings.outputLabelColors || {}
    };
  });

  ipcMain.handle('set-label-color', (event, type, index, color) => {
    if (type === 'input') {
      if (!settings.inputLabelColors) settings.inputLabelColors = {};
      if (color) {
        settings.inputLabelColors[index] = color;
      } else {
        delete settings.inputLabelColors[index];
      }
    } else {
      if (!settings.outputLabelColors) settings.outputLabelColors = {};
      if (color) {
        settings.outputLabelColors[index] = color;
      } else {
        delete settings.outputLabelColors[index];
      }
    }
    saveSettings();
    sendToRenderer('label-colors-changed', {
      inputLabelColors: settings.inputLabelColors || {},
      outputLabelColors: settings.outputLabelColors || {}
    });
    return { success: true };
  });

  ipcMain.handle('set-label-colors-bulk', (event, type, colorMap) => {
    if (type === 'input') {
      if (!settings.inputLabelColors) settings.inputLabelColors = {};
      Object.entries(colorMap).forEach(([index, color]) => {
        if (color) {
          settings.inputLabelColors[index] = color;
        } else {
          delete settings.inputLabelColors[index];
        }
      });
    } else {
      if (!settings.outputLabelColors) settings.outputLabelColors = {};
      Object.entries(colorMap).forEach(([index, color]) => {
        if (color) {
          settings.outputLabelColors[index] = color;
        } else {
          delete settings.outputLabelColors[index];
        }
      });
    }
    saveSettings();
    sendToRenderer('label-colors-changed', {
      inputLabelColors: settings.inputLabelColors || {},
      outputLabelColors: settings.outputLabelColors || {}
    });
    return { success: true };
  });
}

function csvEscape(value) {
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function csvParseLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
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
  createExternalControlServer();
  setupIpcHandlers();
  createWindow();

  const externalControlConfig = getExternalControlConfig();
  if (externalControlConfig.enabled) {
    try {
      await externalControlServer.start(externalControlConfig);
    } catch (err) {
      console.error('External control start failed:', err);
    }
  }

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
  if (externalControlServer) {
    await externalControlServer.stop().catch(() => {});
  }
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
  if (externalControlServer) {
    await externalControlServer.stop().catch(() => {});
  }
  if (routerServer) {
    await routerServer.stop();
  }
  if (controllerInstance) {
    await controllerInstance.disconnect().catch(() => {});
  }
});
