const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('videoHub', {
  // Server control (simulator mode)
  startServer: () => ipcRenderer.invoke('start-server'),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  getState: () => ipcRenderer.invoke('get-state'),

  // Routing and labels (works in both modes)
  setRoute: (output, input, level = 0) => ipcRenderer.invoke('set-route', output, input, level),
  setInputLabel: (input, label) => ipcRenderer.invoke('set-input-label', input, label),
  setOutputLabel: (output, label) => ipcRenderer.invoke('set-output-label', output, label),
  getRoutingForLevel: (level) => ipcRenderer.invoke('get-routing-for-level', level),
  setLevelName: (level, name) => ipcRenderer.invoke('set-level-name', level, name),

  // Configuration
  updateConfig: (config) => ipcRenderer.invoke('update-config', config),
  switchProtocol: (protocol) => ipcRenderer.invoke('switch-protocol', protocol),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setAutoStart: (enabled) => ipcRenderer.invoke('set-auto-start', enabled),

  // Mode control
  getMode: () => ipcRenderer.invoke('get-mode'),
  setMode: (mode) => ipcRenderer.invoke('set-mode', mode),

  // Controller mode
  connectRouter: (config) => ipcRenderer.invoke('connect-router', config),
  disconnectRouter: () => ipcRenderer.invoke('disconnect-router'),
  getConnectionStatus: () => ipcRenderer.invoke('get-connection-status'),

  // Server event listeners (simulator mode)
  onServerStarted: (callback) => ipcRenderer.on('server-started', (_, port) => callback(port)),
  onServerStopped: (callback) => ipcRenderer.on('server-stopped', () => callback()),
  onServerError: (callback) => ipcRenderer.on('server-error', (_, error) => callback(error)),
  onClientConnected: (callback) => ipcRenderer.on('client-connected', (_, clientId) => callback(clientId)),
  onClientDisconnected: (callback) => ipcRenderer.on('client-disconnected', (_, clientId) => callback(clientId)),

  // Routing/state event listeners (both modes)
  onRoutingChanged: (callback) => ipcRenderer.on('routing-changed', (_, changes) => callback(changes)),
  onInputLabelsChanged: (callback) => ipcRenderer.on('input-labels-changed', (_, changes) => callback(changes)),
  onOutputLabelsChanged: (callback) => ipcRenderer.on('output-labels-changed', (_, changes) => callback(changes)),
  onStateUpdated: (callback) => ipcRenderer.on('state-updated', (_, state) => callback(state)),
  onCommandReceived: (callback) => ipcRenderer.on('command-received', (_, data) => callback(data)),

  // Controller event listeners (controller mode)
  onRouterConnected: (callback) => ipcRenderer.on('router-connected', (_, data) => callback(data)),
  onRouterDisconnected: (callback) => ipcRenderer.on('router-disconnected', () => callback()),
  onRouterError: (callback) => ipcRenderer.on('router-error', (_, error) => callback(error)),
  onRouterReconnecting: (callback) => ipcRenderer.on('router-reconnecting', (_, attempt) => callback(attempt)),

  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
