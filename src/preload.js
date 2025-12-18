const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('videoHub', {
  // Server control
  startServer: () => ipcRenderer.invoke('start-server'),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  getState: () => ipcRenderer.invoke('get-state'),

  // Routing and labels
  setRoute: (output, input) => ipcRenderer.invoke('set-route', output, input),
  setInputLabel: (input, label) => ipcRenderer.invoke('set-input-label', input, label),
  setOutputLabel: (output, label) => ipcRenderer.invoke('set-output-label', output, label),

  // Configuration
  updateConfig: (config) => ipcRenderer.invoke('update-config', config),
  switchProtocol: (protocol) => ipcRenderer.invoke('switch-protocol', protocol),

  // Event listeners
  onServerStarted: (callback) => ipcRenderer.on('server-started', (_, port) => callback(port)),
  onServerStopped: (callback) => ipcRenderer.on('server-stopped', () => callback()),
  onServerError: (callback) => ipcRenderer.on('server-error', (_, error) => callback(error)),
  onClientConnected: (callback) => ipcRenderer.on('client-connected', (_, clientId) => callback(clientId)),
  onClientDisconnected: (callback) => ipcRenderer.on('client-disconnected', (_, clientId) => callback(clientId)),
  onRoutingChanged: (callback) => ipcRenderer.on('routing-changed', (_, changes) => callback(changes)),
  onInputLabelsChanged: (callback) => ipcRenderer.on('input-labels-changed', (_, changes) => callback(changes)),
  onOutputLabelsChanged: (callback) => ipcRenderer.on('output-labels-changed', (_, changes) => callback(changes)),
  onStateUpdated: (callback) => ipcRenderer.on('state-updated', (_, state) => callback(state)),
  onCommandReceived: (callback) => ipcRenderer.on('command-received', (_, data) => callback(data)),

  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
