const net = require('net');
const EventEmitter = require('events');

// GV Native Protocol Constants
const SOH = 0x01;  // Start of Header
const EOT = 0x04;  // End of Transmission
const HT = 0x09;   // Horizontal Tab (field separator)
const PROTOCOL_ID = 'N';  // Native Protocol identifier

class GVNativeController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 12345;
    this.timeout = options.timeout || 5000;
    this.autoReconnect = options.autoReconnect !== false;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.reconnectAttempts = 0;

    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.buffer = Buffer.alloc(0);
    this.reconnectTimer = null;

    // Router state
    this.inputs = options.inputs || 0;
    this.outputs = options.outputs || 0;
    this.levels = options.levels || 1;
    this.routing = {};  // routing[level][dest] = source
    this.inputLabels = {};
    this.outputLabels = {};
    this.levelNames = {};
    this.modelName = '';
    this.friendlyName = '';

    // Pending queries for state initialization
    this.pendingQueries = new Set();
    this.initialStateReceived = false;

    // Flag polling for change notifications
    this.pollInterval = options.pollInterval || 1000;  // Poll every 1 second
    this.pollTimer = null;

    // Flag constants (must match server)
    this.FLAG_ROUTING_CHANGED = 0x0001;
    this.FLAG_SOURCE_NAMES_CHANGED = 0x0002;
    this.FLAG_DEST_NAMES_CHANGED = 0x0004;
    this.FLAG_LEVEL_NAMES_CHANGED = 0x0008;
  }

  async connect() {
    if (this.connected || this.connecting) {
      return;
    }

    this.connecting = true;
    this.clearReconnectTimer();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.socket?.destroy();
        this.connecting = false;
        reject(new Error('Connection timeout'));
      }, this.timeout);

      this.socket = new net.Socket();

      this.socket.on('connect', () => {
        clearTimeout(timeout);
        this.connected = true;
        this.connecting = false;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.initialStateReceived = false;

        // Query router for initial state
        this.queryInitialState();
      });

      this.socket.on('data', (data) => {
        this.handleData(data);
      });

      this.socket.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.connecting = false;

        if (wasConnected) {
          this.emit('disconnected');
          if (this.autoReconnect) {
            this.scheduleReconnect();
          }
        }
      });

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        this.connecting = false;
        this.emit('error', err);

        if (!this.connected && this.autoReconnect) {
          this.scheduleReconnect();
        }

        if (!this.connected) {
          reject(err);
        }
      });

      this.socket.connect(this.port, this.host);

      // Resolve once we've received initial state
      const initialDataHandler = () => {
        clearTimeout(timeout);
        this.emit('connected');
        resolve();
      };

      this.once('initial-state-received', initialDataHandler);
    });
  }

  async disconnect() {
    this.autoReconnect = false;
    this.clearReconnectTimer();
    this.stopPolling();

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this.connected = false;
    this.connecting = false;
  }

  isConnected() {
    return this.connected;
  }

  clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      if (this.connected) {
        this.sendCommand('BK', ['F']);  // Query change flags
      }
    }, this.pollInterval);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  scheduleReconnect() {
    this.clearReconnectTimer();
    this.stopPolling();
    this.reconnectAttempts++;
    this.emit('reconnecting', this.reconnectAttempts);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
        // Will retry via scheduleReconnect called from error handler
      }
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  queryInitialState() {
    // Query device info
    this.sendCommand('BK', ['N']);  // Device name
    this.sendCommand('BK', ['d']);  // Model name
    this.pendingQueries.add('deviceInfo');

    // Query source names (with indices)
    this.sendCommand('QN', ['IS']);
    this.pendingQueries.add('sourceNames');

    // Query destination names (with indices)
    this.sendCommand('QN', ['ID']);
    this.pendingQueries.add('destNames');

    // Query level names
    this.sendCommand('QN', ['L']);
    this.pendingQueries.add('levelNames');

    // Query routing for all destinations (by index)
    this.sendCommand('QJ');
    this.pendingQueries.add('routing');
  }

  handleData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.processBuffer();
  }

  processBuffer() {
    // Look for SOH...EOT message frames
    while (this.buffer.length >= 6) {  // Minimum: SOH + N + 0 + XX + checksum(2) + EOT
      const sohPos = this.buffer.indexOf(SOH);
      if (sohPos === -1) {
        this.buffer = Buffer.alloc(0);
        return;
      }

      // Skip bytes before SOH
      if (sohPos > 0) {
        this.buffer = this.buffer.slice(sohPos);
      }

      // Find EOT
      const eotPos = this.buffer.indexOf(EOT, 1);
      if (eotPos === -1) {
        // Message not complete yet
        return;
      }

      // Extract message (SOH to EOT inclusive)
      const messageData = this.buffer.slice(1, eotPos);  // Exclude SOH and EOT

      // Parse and process the message
      const parsed = this.parseMessage(messageData);
      if (parsed) {
        this.processMessage(parsed);
      }

      // Move past this message
      this.buffer = this.buffer.slice(eotPos + 1);
    }
  }

  parseMessage(data) {
    // Format: protocol_id + seq_flag + command(2) + [params] + checksum(2)
    if (data.length < 6) return null;

    const protocolId = String.fromCharCode(data[0]);
    if (protocolId !== PROTOCOL_ID) return null;

    const seqFlag = String.fromCharCode(data[1]);
    const command = String.fromCharCode(data[2], data[3]);

    // Checksum is last 2 bytes as ASCII hex
    const checksumStr = data.slice(-2).toString('ascii');
    const receivedChecksum = parseInt(checksumStr, 16);

    // Data to verify (everything except checksum)
    const dataToVerify = data.slice(0, -2);

    // Calculate checksum
    const calculatedChecksum = this.calculateChecksum(dataToVerify);

    if (calculatedChecksum !== receivedChecksum) {
      console.warn(`GV Native checksum mismatch: expected ${calculatedChecksum.toString(16)}, got ${checksumStr}`);
    }

    // Extract parameters (between command and checksum)
    const paramsData = data.slice(4, -2);
    const params = this.parseParams(paramsData);

    return {
      seqFlag,
      command,
      params
    };
  }

  parseParams(data) {
    if (data.length === 0) return [];

    const paramsStr = data.toString('ascii');
    const parts = paramsStr.split(String.fromCharCode(HT));
    return parts.filter(p => p.length > 0);
  }

  calculateChecksum(data) {
    // Negative sum mod 256 of all bytes
    let sum = 0;
    for (const byte of data) {
      sum += byte;
    }
    return (256 - (sum % 256)) % 256;
  }

  buildMessage(command, params = []) {
    // Build: N + 0 + command + HT + params... + checksum + EOT
    const parts = [PROTOCOL_ID, '0', command];

    for (const param of params) {
      parts.push(String.fromCharCode(HT) + param);
    }

    const bodyStr = parts.join('');
    const bodyBuffer = Buffer.from(bodyStr, 'ascii');

    // Calculate checksum
    const checksum = this.calculateChecksum(bodyBuffer);
    const checksumStr = checksum.toString(16).toUpperCase().padStart(2, '0');

    // Build complete message
    return Buffer.concat([
      Buffer.from([SOH]),
      bodyBuffer,
      Buffer.from(checksumStr, 'ascii'),
      Buffer.from([EOT])
    ]);
  }

  sendCommand(command, params = []) {
    if (!this.connected || !this.socket) {
      return false;
    }

    const message = this.buildMessage(command, params);
    this.socket.write(message);
    return true;
  }

  processMessage(parsed) {
    const { command, params } = parsed;

    switch (command) {
      case 'KB':  // Background response
        this.handleBackgroundResponse(params);
        break;
      case 'NQ':  // Name query response
        this.handleNameQueryResponse(params);
        break;
      case 'JQ':  // Destination status by index response
      case 'jQ':
        this.handleDestStatusResponse(params);
        break;
      case 'IQ':  // Single destination/level status
      case 'iQ':
        this.handleSingleDestStatusResponse(params);
        break;
      case 'ER':  // Error or acknowledgment
        this.handleErrorResponse(params);
        break;
      case 'AT':  // Asynchronous take notification (routing change)
        this.handleAsyncTake(params);
        break;
      default:
        // Unknown response - ignore
        break;
    }
  }

  handleBackgroundResponse(params) {
    if (params.length < 2) return;

    const type = params[0];
    const value = params[1];

    switch (type) {
      case 'N':  // Device name
        this.friendlyName = value;
        this.pendingQueries.delete('deviceInfo');
        this.checkInitialStateComplete();
        break;
      case 'd':  // Model name
        this.modelName = value;
        this.pendingQueries.delete('deviceInfo');
        this.checkInitialStateComplete();
        break;
      case 'F':  // Change flags
        this.handleChangeFlags(value);
        break;
    }
  }

  handleChangeFlags(flagsHex) {
    const flags = parseInt(flagsHex, 16);
    if (flags === 0) return;  // No changes

    // Re-query changed data
    if (flags & this.FLAG_ROUTING_CHANGED) {
      this.sendCommand('QJ');  // Query all routing
    }
    if (flags & this.FLAG_SOURCE_NAMES_CHANGED) {
      this.sendCommand('QN', ['IS']);  // Query source names
    }
    if (flags & this.FLAG_DEST_NAMES_CHANGED) {
      this.sendCommand('QN', ['ID']);  // Query dest names
    }
    if (flags & this.FLAG_LEVEL_NAMES_CHANGED) {
      this.sendCommand('QN', ['L']);  // Query level names
    }

    // Clear flags after querying
    this.sendCommand('BK', ['f']);
  }

  handleNameQueryResponse(params) {
    if (params.length < 2) return;

    const type = params[0];
    const count = parseInt(params[1], 16);

    switch (type) {
      case 'S':  // Source names (without index)
      case 'IS':  // Source names (with index)
        this.parseSourceNames(params.slice(2), type === 'IS', count);
        this.pendingQueries.delete('sourceNames');
        this.emit('input-labels-changed', Object.keys(this.inputLabels).map(k => ({
          index: parseInt(k),
          label: this.inputLabels[k]
        })));
        break;
      case 'D':  // Destination names (without index)
      case 'ID':  // Destination names (with index)
        this.parseDestNames(params.slice(2), type === 'ID', count);
        this.pendingQueries.delete('destNames');
        this.emit('output-labels-changed', Object.keys(this.outputLabels).map(k => ({
          index: parseInt(k),
          label: this.outputLabels[k]
        })));
        break;
      case 'L':  // Level names
        this.parseLevelNames(params.slice(2), count);
        this.pendingQueries.delete('levelNames');
        break;
    }

    this.emit('state-updated', this.getState());
    this.checkInitialStateComplete();
  }

  parseSourceNames(params, withIndex, count) {
    this.inputs = count;
    let i = 0;
    let sourceIndex = 0;

    while (i < params.length && sourceIndex < count) {
      const name = params[i++];
      let idx = sourceIndex;

      if (withIndex) {
        idx = parseInt(params[i++], 16);
      }

      // Skip tie_flag
      i++;
      // Skip level_bitmap
      i++;

      this.inputLabels[idx] = name;
      sourceIndex++;
    }
  }

  parseDestNames(params, withIndex, count) {
    this.outputs = count;
    let i = 0;
    let destIndex = 0;

    while (i < params.length && destIndex < count) {
      const name = params[i++];
      let idx = destIndex;

      if (withIndex) {
        idx = parseInt(params[i++], 16);
      }

      // Skip tie_flag
      i++;
      // Skip level_bitmap
      i++;

      this.outputLabels[idx] = name;
      destIndex++;
    }
  }

  parseLevelNames(params, count) {
    this.levels = count;
    let i = 0;

    while (i < params.length) {
      const name = params[i++];
      const lvlNum = parseInt(params[i++], 16);
      // Skip restriction flag
      i++;

      this.levelNames[lvlNum] = name;
    }
  }

  handleDestStatusResponse(params) {
    // JQ,dest_index,nbr_sources[,src_entry1,...]
    // src_entry: <'N'|'P'>,<'N'|'C'>,src_index,level_bitmap
    if (params.length < 2) return;

    const destIndex = parseInt(params[0], 16);
    const nbrSources = parseInt(params[1], 16);

    let i = 2;
    const changes = [];
    for (let s = 0; s < nbrSources && i + 3 <= params.length; s++) {
      // Skip protection flag
      i++;
      // Skip chop flag
      i++;
      const srcIndex = parseInt(params[i++], 16);
      const levelBitmap = params[i++];

      const levels = this.parseLevelBitmap(levelBitmap);
      for (const level of levels) {
        if (!this.routing[level]) {
          this.routing[level] = {};
        }
        if (this.routing[level][destIndex] !== srcIndex) {
          this.routing[level][destIndex] = srcIndex;
          changes.push({ level, output: destIndex, input: srcIndex });
        }
      }
    }

    if (changes.length > 0) {
      this.emit('routing-changed', changes);
      this.emit('state-updated', this.getState());
    }
  }

  handleSingleDestStatusResponse(params) {
    // IQ,destIndex,lvlIndex,<'N'|'P'>,<'N'|'C'>,srcIndex
    if (params.length < 5) return;

    const destIndex = parseInt(params[0], 16);
    const lvlIndex = parseInt(params[1], 16);
    // Skip protection flag (params[2])
    // Skip chop flag (params[3])
    const srcIndex = parseInt(params[4], 16);

    if (!this.routing[lvlIndex]) {
      this.routing[lvlIndex] = {};
    }
    if (this.routing[lvlIndex][destIndex] !== srcIndex) {
      this.routing[lvlIndex][destIndex] = srcIndex;
      this.emit('routing-changed', [{ level: lvlIndex, output: destIndex, input: srcIndex }]);
      this.emit('state-updated', this.getState());
    }
  }

  handleErrorResponse(params) {
    // ER,error_code,command
    if (params.length < 2) return;

    const errorCode = params[0];
    const command = params[1];

    if (errorCode === '00') {
      // Success - end of query sequence
      if (command === 'QJ') {
        this.pendingQueries.delete('routing');
        this.checkInitialStateComplete();
      }
    } else {
      // Actual error
      const errorMessages = {
        '01': 'MCPU directed response error',
        '02': 'Invalid destination name',
        '03': 'Invalid source name',
        '04': 'Invalid level',
        '09': 'Missing parameter',
        '0A': 'Invalid parameter',
        '0F': 'Unknown command'
      };
      const message = errorMessages[errorCode] || `Unknown error ${errorCode}`;
      this.emit('error', `${command}: ${message}`);
    }
  }

  handleAsyncTake(params) {
    // Asynchronous take notification - routing has changed
    // Re-query the changed destination
    if (params.length >= 1) {
      const destIndex = parseInt(params[0], 16);
      // Query status for this destination
      this.sendCommand('QJ', [this.toHex4(destIndex)]);
    }
  }

  parseLevelBitmap(hexStr) {
    const bitmap = parseInt(hexStr, 16);
    const levels = [];
    for (let i = 0; i < 32; i++) {
      if (bitmap & (1 << i)) {
        levels.push(i);
      }
    }
    return levels;
  }

  toLevelBitmap(levels) {
    let bitmap = 0;
    if (Array.isArray(levels)) {
      for (const level of levels) {
        bitmap |= (1 << level);
      }
    } else {
      for (let i = 0; i < levels; i++) {
        bitmap |= (1 << i);
      }
    }
    return bitmap.toString(16).toUpperCase().padStart(8, '0');
  }

  toHex4(num) {
    return num.toString(16).toUpperCase().padStart(4, '0');
  }

  checkInitialStateComplete() {
    if (this.pendingQueries.size === 0 && !this.initialStateReceived) {
      this.initialStateReceived = true;
      this.emit('state-updated', this.getState());
      this.emit('initial-state-received');
      // Start polling for changes after initial state is received
      this.startPolling();
    }
  }

  getState(level = 0) {
    const levelRouting = {};
    for (let i = 0; i < this.outputs; i++) {
      levelRouting[i] = this.routing[level]?.[i] ?? 0;
    }

    const allRouting = {};
    for (let l = 0; l < this.levels; l++) {
      allRouting[l] = {};
      for (let i = 0; i < this.outputs; i++) {
        allRouting[l][i] = this.routing[l]?.[i] ?? 0;
      }
    }

    return {
      inputs: this.inputs,
      outputs: this.outputs,
      levels: this.levels,
      currentLevel: level,
      levelNames: { ...this.levelNames },
      modelName: this.modelName,
      friendlyName: this.friendlyName,
      routing: levelRouting,
      allRouting: allRouting,
      inputLabels: { ...this.inputLabels },
      outputLabels: { ...this.outputLabels },
      outputLocks: {}
    };
  }

  async setRoute(output, input, level = 0) {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    // TI,destIndex,srcIndex,levelIndex
    const params = [
      this.toHex4(output),
      this.toHex4(input),
      this.toHex4(level)
    ];

    this.sendCommand('TI', params);

    // Optimistically update local state
    if (!this.routing[level]) {
      this.routing[level] = {};
    }
    const oldInput = this.routing[level][output];
    if (oldInput !== input) {
      this.routing[level][output] = input;
      this.emit('routing-changed', [{ level, output, input }]);
      this.emit('state-updated', this.getState());
    }

    return true;
  }

  async setInputLabel(index, label) {
    // GV Native doesn't have a standard command for setting labels
    // Labels are typically configured on the router itself
    // We can only update local state for display purposes
    if (this.inputLabels[index] !== label) {
      this.inputLabels[index] = label;
      this.emit('input-labels-changed', [{ index, label }]);
    }
    return true;
  }

  async setOutputLabel(index, label) {
    // GV Native doesn't have a standard command for setting labels
    // Labels are typically configured on the router itself
    // We can only update local state for display purposes
    if (this.outputLabels[index] !== label) {
      this.outputLabels[index] = label;
      this.emit('output-labels-changed', [{ index, label }]);
    }
    return true;
  }

  getRoutingForLevel(level) {
    const levelRouting = {};
    for (let i = 0; i < this.outputs; i++) {
      levelRouting[i] = this.routing[level]?.[i] ?? 0;
    }
    return levelRouting;
  }

  setLevelName(level, name) {
    // GV Native doesn't support setting level names remotely
    // Update local state only
    if (level >= 0 && level < this.levels) {
      this.levelNames[level] = name;
      return true;
    }
    return false;
  }
}

module.exports = GVNativeController;
