const net = require('net');
const EventEmitter = require('events');

// Protocol constants
const DLE = 0x10;
const STX = 0x02;
const ETX = 0x03;

// Command codes
const CMD = {
  CROSSPOINT_INTERROGATE: 0x01,
  CROSSPOINT_CONNECT: 0x02,
  CROSSPOINT_TALLY: 0x03,
  CROSSPOINT_CONNECTED: 0x04,
  TALLY_DUMP_REQUEST: 0x15,
  SOURCE_NAME_REQUEST: 0x64,
  SOURCE_NAME_RESPONSE: 0x6a,
  DEST_NAME_REQUEST: 0x66,
  DEST_NAME_RESPONSE: 0x6b,
  // Extended (16-bit addressing)
  EXTENDED_CROSSPOINT_INTERROGATE: 0x81,
  EXTENDED_CROSSPOINT_CONNECT: 0x82,
  EXTENDED_CROSSPOINT_TALLY: 0x83,
  EXTENDED_CROSSPOINT_CONNECTED: 0x84,
  EXTENDED_SOURCE_NAME_REQUEST: 0xe4,
  EXTENDED_SOURCE_NAME_RESPONSE: 0xea,
  EXTENDED_DEST_NAME_REQUEST: 0xe6,
  EXTENDED_DEST_NAME_RESPONSE: 0xeb
};

class SWP08Controller extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 8910;
    this.timeout = options.timeout || 5000;
    this.autoReconnect = options.autoReconnect !== false;
    this.levels = options.levels || 1;
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
    this.routing = {};  // { level: { dest: source } }
    this.inputLabels = {};
    this.outputLabels = {};
    this.levelNames = {};

    // Initialize routing for all levels
    for (let l = 0; l < this.levels; l++) {
      this.routing[l] = {};
    }
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

        // Query router state
        this.queryRouterState().then(() => {
          this.emit('connected');
          resolve();
        }).catch((err) => {
          this.emit('error', err);
          resolve(); // Still resolve, connected but couldn't query
        });
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
    });
  }

  async disconnect() {
    this.autoReconnect = false;
    this.clearReconnectTimer();

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

  scheduleReconnect() {
    this.clearReconnectTimer();
    this.reconnectAttempts++;
    this.emit('reconnecting', this.reconnectAttempts);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
        // Will retry via scheduleReconnect called from error handler
      }
    }, this.reconnectDelay);

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  async queryRouterState() {
    // Request tally dump for all levels
    for (let level = 0; level < this.levels; level++) {
      this.sendTallyDumpRequest(level);
    }

    // Request names
    this.sendSourceNameRequest();
    this.sendDestNameRequest();

    // Give time for responses
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  handleData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.processBuffer();
  }

  processBuffer() {
    while (this.buffer.length >= 5) {
      // Look for DLE STX
      const startIdx = this.findFrameStart();
      if (startIdx === -1) {
        // No valid start found, clear buffer up to last byte
        if (this.buffer.length > 1) {
          this.buffer = this.buffer.slice(-1);
        }
        break;
      }

      // Remove any bytes before the frame
      if (startIdx > 0) {
        this.buffer = this.buffer.slice(startIdx);
      }

      // Look for DLE ETX
      const endIdx = this.findFrameEnd();
      if (endIdx === -1) {
        // Incomplete frame, wait for more data
        break;
      }

      // Extract the frame (including DLE STX and DLE ETX)
      const frame = this.buffer.slice(0, endIdx + 2);
      this.buffer = this.buffer.slice(endIdx + 2);

      // Process the frame
      this.processFrame(frame);
    }
  }

  findFrameStart() {
    for (let i = 0; i < this.buffer.length - 1; i++) {
      if (this.buffer[i] === DLE && this.buffer[i + 1] === STX) {
        return i;
      }
    }
    return -1;
  }

  findFrameEnd() {
    for (let i = 2; i < this.buffer.length - 1; i++) {
      if (this.buffer[i] === DLE) {
        if (this.buffer[i + 1] === ETX) {
          return i;
        } else if (this.buffer[i + 1] === DLE) {
          i++; // Skip escaped DLE
        }
      }
    }
    return -1;
  }

  processFrame(frame) {
    // Remove DLE STX and DLE ETX
    const data = this.unescapeData(frame.slice(2, -2));
    if (data.length < 2) return;

    // Last byte is checksum, second to last is byte count
    const payload = data.slice(0, -2);
    const btc = data[data.length - 2];
    const checksum = data[data.length - 1];

    // Verify checksum
    if (!this.verifyChecksum(payload, btc, checksum)) {
      return;
    }

    // Process command
    const cmd = payload[0];
    this.processCommand(cmd, payload.slice(1));
  }

  unescapeData(data) {
    const result = [];
    for (let i = 0; i < data.length; i++) {
      if (data[i] === DLE && i + 1 < data.length && data[i + 1] === DLE) {
        result.push(DLE);
        i++; // Skip second DLE
      } else {
        result.push(data[i]);
      }
    }
    return Buffer.from(result);
  }

  verifyChecksum(payload, btc, checksum) {
    let sum = 0;
    for (const byte of payload) {
      sum = (sum + byte) & 0xFF;
    }
    sum = (sum + btc) & 0xFF;
    const expected = (~sum + 1) & 0xFF;
    return checksum === expected;
  }

  calculateChecksum(data) {
    let sum = 0;
    for (const byte of data) {
      sum = (sum + byte) & 0xFF;
    }
    return (~sum + 1) & 0xFF;
  }

  processCommand(cmd, data) {
    switch (cmd) {
      case CMD.CROSSPOINT_CONNECTED:
        this.handleCrosspointConnected(data, false);
        break;
      case CMD.CROSSPOINT_TALLY:
        this.handleCrosspointTally(data, false);
        break;
      case CMD.EXTENDED_CROSSPOINT_CONNECTED:
        this.handleCrosspointConnected(data, true);
        break;
      case CMD.EXTENDED_CROSSPOINT_TALLY:
        this.handleCrosspointTally(data, true);
        break;
      case CMD.SOURCE_NAME_RESPONSE:
        this.handleSourceNames(data, false);
        break;
      case CMD.DEST_NAME_RESPONSE:
        this.handleDestNames(data, false);
        break;
      case CMD.EXTENDED_SOURCE_NAME_RESPONSE:
        this.handleSourceNames(data, true);
        break;
      case CMD.EXTENDED_DEST_NAME_RESPONSE:
        this.handleDestNames(data, true);
        break;
    }
  }

  handleCrosspointConnected(data, extended) {
    if (extended) {
      if (data.length < 6) return;
      const matrix = data[0];
      const level = data[1];
      const dest = (data[2] << 8) | data[3];
      const source = (data[4] << 8) | data[5];
      this.updateRouting(level, dest, source);
    } else {
      if (data.length < 4) return;
      const matrixLevel = data[0];
      const level = matrixLevel & 0x0F;
      const multiplier = data[1];
      const destLow = data[2];
      const sourceLow = data[3];

      const destHigh = (multiplier >> 4) & 0x07;
      const sourceHigh = multiplier & 0x07;
      const dest = (destHigh << 7) | (destLow & 0x7F);
      const source = (sourceHigh << 7) | (sourceLow & 0x7F);

      this.updateRouting(level, dest, source);
    }
  }

  handleCrosspointTally(data, extended) {
    // Same format as connected
    this.handleCrosspointConnected(data, extended);
  }

  handleSourceNames(data, extended) {
    // Parse source name response
    if (data.length < 5) return;

    let offset = 0;
    const matrixLevel = data[offset++];
    const charLenIndex = data[offset++];
    const charLen = [4, 8, 12][charLenIndex] || 8;

    let labelNumHi, labelNumLo, count;
    if (extended) {
      labelNumHi = data[offset++];
      labelNumLo = data[offset++];
      count = (data[offset++] << 8) | data[offset++];
    } else {
      labelNumHi = data[offset++];
      labelNumLo = data[offset++];
      count = data[offset++];
    }

    const startLabel = (labelNumHi << 8) | labelNumLo;

    for (let i = 0; i < count && offset + charLen <= data.length; i++) {
      const labelBytes = data.slice(offset, offset + charLen);
      const label = labelBytes.toString('ascii').replace(/\0/g, '').trim();
      this.inputLabels[startLabel + i] = label;
      offset += charLen;
    }

    // Update inputs count if we learned more
    const maxInput = startLabel + count;
    if (maxInput > this.inputs) {
      this.inputs = maxInput;
    }

    this.emit('input-labels-changed', Object.keys(this.inputLabels).map(k => ({
      index: parseInt(k),
      label: this.inputLabels[k]
    })));
    this.emit('state-updated', this.getState());
  }

  handleDestNames(data, extended) {
    // Parse destination name response
    if (data.length < 5) return;

    let offset = 0;
    const matrix = data[offset++];
    const charLenIndex = data[offset++];
    const charLen = [4, 8, 12][charLenIndex] || 8;

    let labelNumHi, labelNumLo, count;
    if (extended) {
      labelNumHi = data[offset++];
      labelNumLo = data[offset++];
      count = (data[offset++] << 8) | data[offset++];
    } else {
      labelNumHi = data[offset++];
      labelNumLo = data[offset++];
      count = data[offset++];
    }

    const startLabel = (labelNumHi << 8) | labelNumLo;

    for (let i = 0; i < count && offset + charLen <= data.length; i++) {
      const labelBytes = data.slice(offset, offset + charLen);
      const label = labelBytes.toString('ascii').replace(/\0/g, '').trim();
      this.outputLabels[startLabel + i] = label;
      offset += charLen;
    }

    // Update outputs count if we learned more
    const maxOutput = startLabel + count;
    if (maxOutput > this.outputs) {
      this.outputs = maxOutput;
    }

    this.emit('output-labels-changed', Object.keys(this.outputLabels).map(k => ({
      index: parseInt(k),
      label: this.outputLabels[k]
    })));
    this.emit('state-updated', this.getState());
  }

  updateRouting(level, dest, source) {
    if (!this.routing[level]) {
      this.routing[level] = {};
    }

    if (this.routing[level][dest] !== source) {
      this.routing[level][dest] = source;
      this.emit('routing-changed', [{ output: dest, input: source, level }]);
      this.emit('state-updated', this.getState());
    }

    // Update dimensions
    if (dest + 1 > this.outputs) this.outputs = dest + 1;
    if (source + 1 > this.inputs) this.inputs = source + 1;
  }

  buildFrame(data) {
    // Calculate byte count and checksum
    const btc = data.length;
    const checksum = this.calculateChecksum(Buffer.concat([data, Buffer.from([btc])]));

    // Build payload with BTC and checksum
    const payload = Buffer.concat([data, Buffer.from([btc, checksum])]);

    // Escape any DLE bytes in payload
    const escaped = this.escapeData(payload);

    // Add framing
    return Buffer.concat([
      Buffer.from([DLE, STX]),
      escaped,
      Buffer.from([DLE, ETX])
    ]);
  }

  escapeData(data) {
    const result = [];
    for (const byte of data) {
      result.push(byte);
      if (byte === DLE) {
        result.push(DLE);
      }
    }
    return Buffer.from(result);
  }

  sendTallyDumpRequest(level) {
    if (!this.connected) return;

    const matrix = 1;
    const data = Buffer.from([
      CMD.TALLY_DUMP_REQUEST,
      ((matrix - 1) << 4) | (level & 0x0F)
    ]);

    this.socket.write(this.buildFrame(data));
  }

  sendSourceNameRequest() {
    if (!this.connected) return;

    const data = Buffer.from([
      CMD.SOURCE_NAME_REQUEST,
      0x00, // Matrix + Level
      1,    // Char length index (8 chars)
      0, 0, // Label number (start at 0)
      0     // Count (0 = all)
    ]);

    this.socket.write(this.buildFrame(data));
  }

  sendDestNameRequest() {
    if (!this.connected) return;

    const data = Buffer.from([
      CMD.DEST_NAME_REQUEST,
      0x00, // Matrix
      1,    // Char length index (8 chars)
      0, 0, // Label number (start at 0)
      0     // Count (0 = all)
    ]);

    this.socket.write(this.buildFrame(data));
  }

  getState() {
    // Return routing for level 0 as the default "routing" for compatibility
    return {
      inputs: this.inputs,
      outputs: this.outputs,
      levels: this.levels,
      routing: this.routing[0] || {},
      allRouting: { ...this.routing },
      inputLabels: { ...this.inputLabels },
      outputLabels: { ...this.outputLabels },
      levelNames: { ...this.levelNames }
    };
  }

  getRoutingForLevel(level) {
    return this.routing[level] || {};
  }

  setLevelName(level, name) {
    this.levelNames[level] = name;
    return true;
  }

  async setRoute(output, input, level = 0) {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    const useExtended = output > 1023 || input > 1023;

    let data;
    if (useExtended) {
      data = Buffer.from([
        CMD.EXTENDED_CROSSPOINT_CONNECT,
        1, // Matrix
        level & 0xFF,
        (output >> 8) & 0xFF,
        output & 0xFF,
        (input >> 8) & 0xFF,
        input & 0xFF
      ]);
    } else {
      const destHigh = (output >> 7) & 0x07;
      const destLow = output & 0x7F;
      const sourceHigh = (input >> 7) & 0x07;
      const sourceLow = input & 0x7F;
      const multiplier = (destHigh << 4) | sourceHigh;

      data = Buffer.from([
        CMD.CROSSPOINT_CONNECT,
        (0 << 4) | (level & 0x0F), // Matrix 1, level
        multiplier,
        destLow,
        sourceLow
      ]);
    }

    this.socket.write(this.buildFrame(data));

    // Optimistically update local state
    if (!this.routing[level]) {
      this.routing[level] = {};
    }
    this.routing[level][output] = input;
    this.emit('routing-changed', [{ output, input, level }]);

    return true;
  }

  async setInputLabel(index, label) {
    // SW-P-08 doesn't typically support setting labels from controllers
    // Just update local state
    this.inputLabels[index] = label;
    this.emit('input-labels-changed', [{ index, label }]);
    return true;
  }

  async setOutputLabel(index, label) {
    // SW-P-08 doesn't typically support setting labels from controllers
    // Just update local state
    this.outputLabels[index] = label;
    this.emit('output-labels-changed', [{ index, label }]);
    return true;
  }
}

module.exports = SWP08Controller;
