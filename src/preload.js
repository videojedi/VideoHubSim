const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('videoHub', {
  // Simulator server control
  startServer: () => ipcRenderer.invoke('start-server'),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  isServerRunning: () => ipcRenderer.invoke('is-server-running'),

  // Controller connection
  connectRouter: (config) => ipcRenderer.invoke('connect-router', config),
  disconnectRouter: () => ipcRenderer.invoke('disconnect-router'),
  isControllerConnected: () => ipcRenderer.invoke('is-controller-connected'),
  getConnectionStatus: () => ipcRenderer.invoke('get-connection-status'),

  // State getters (target: 'simulator' or 'controller')
  getState: (target) => ipcRenderer.invoke('get-state', target),
  getSimulatorState: () => ipcRenderer.invoke('get-simulator-state'),
  getControllerState: () => ipcRenderer.invoke('get-controller-state'),

  // Routing and labels (target: 'simulator' or 'controller')
  setRoute: (output, input, level = 0, target) => ipcRenderer.invoke('set-route', output, input, level, target),
  setInputLabel: (input, label, target) => ipcRenderer.invoke('set-input-label', input, label, target),
  setOutputLabel: (output, label, target) => ipcRenderer.invoke('set-output-label', output, label, target),
  setLock: (output, lock, target) => ipcRenderer.invoke('set-lock', output, lock, target),
  getRoutingForLevel: (level, target) => ipcRenderer.invoke('get-routing-for-level', level, target),
  setLevelName: (level, name, target) => ipcRenderer.invoke('set-level-name', level, name, target),

  // Simulator configuration
  updateConfig: (config) => ipcRenderer.invoke('update-config', config),
  switchProtocol: (protocol) => ipcRenderer.invoke('switch-protocol', protocol),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setAutoStart: (enabled) => ipcRenderer.invoke('set-auto-start', enabled),

  // Router history
  getRouterHistory: () => ipcRenderer.invoke('get-router-history'),
  addRouterToHistory: (router) => ipcRenderer.invoke('add-router-to-history', router),
  removeRouterFromHistory: (index) => ipcRenderer.invoke('remove-router-from-history', index),

  // Update checker
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // View control (what's displayed - doesn't affect functionality)
  getView: () => ipcRenderer.invoke('get-view'),
  setView: (view) => ipcRenderer.invoke('set-view', view),

  // Simulator event listeners
  onServerStarted: (callback) => ipcRenderer.on('server-started', (_, port) => callback(port)),
  onServerStopped: (callback) => ipcRenderer.on('server-stopped', () => callback()),
  onServerError: (callback) => ipcRenderer.on('server-error', (_, error) => callback(error)),
  onClientConnected: (callback) => ipcRenderer.on('client-connected', (_, clientId) => callback(clientId)),
  onClientDisconnected: (callback) => ipcRenderer.on('client-disconnected', (_, clientId) => callback(clientId)),
  onSimulatorRoutingChanged: (callback) => ipcRenderer.on('simulator-routing-changed', (_, changes) => callback(changes)),
  onSimulatorLocksChanged: (callback) => ipcRenderer.on('simulator-locks-changed', (_, changes) => callback(changes)),
  onSimulatorInputLabelsChanged: (callback) => ipcRenderer.on('simulator-input-labels-changed', (_, changes) => callback(changes)),
  onSimulatorOutputLabelsChanged: (callback) => ipcRenderer.on('simulator-output-labels-changed', (_, changes) => callback(changes)),
  onSimulatorStateUpdated: (callback) => ipcRenderer.on('simulator-state-updated', (_, state) => callback(state)),
  onCommandReceived: (callback) => ipcRenderer.on('command-received', (_, data) => callback(data)),

  // Controller event listeners
  onRouterConnected: (callback) => ipcRenderer.on('router-connected', (_, data) => callback(data)),
  onRouterDisconnected: (callback) => ipcRenderer.on('router-disconnected', () => callback()),
  onRouterError: (callback) => ipcRenderer.on('router-error', (_, error) => callback(error)),
  onRouterReconnecting: (callback) => ipcRenderer.on('router-reconnecting', (_, attempt) => callback(attempt)),
  onControllerRoutingChanged: (callback) => ipcRenderer.on('controller-routing-changed', (_, changes) => callback(changes)),
  onControllerLocksChanged: (callback) => ipcRenderer.on('controller-locks-changed', (_, changes) => callback(changes)),
  onControllerInputLabelsChanged: (callback) => ipcRenderer.on('controller-input-labels-changed', (_, changes) => callback(changes)),
  onControllerOutputLabelsChanged: (callback) => ipcRenderer.on('controller-output-labels-changed', (_, changes) => callback(changes)),
  onControllerStateUpdated: (callback) => ipcRenderer.on('controller-state-updated', (_, state) => callback(state)),

  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
