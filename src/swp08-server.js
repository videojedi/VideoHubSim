const net = require('net');
const EventEmitter = require('events');

// SW-P-08 Protocol Constants
const DLE = 0x10;  // Data Link Escape
const STX = 0x02;  // Start of Text
const ACK = 0x06;  // Acknowledge
const NAK = 0x15;  // Negative Acknowledge

// Command codes (SOM - Start of Message)
const CMD = {
  CROSSPOINT_INTERROGATE: 0x01,
  CROSSPOINT_CONNECTED: 0x02,
  CROSSPOINT_CONNECT: 0x02,
  CROSSPOINT_TALLY: 0x03,
  CROSSPOINT_TALLY_DUMP_REQUEST: 0x21,
  CROSSPOINT_TALLY_DUMP_RESPONSE: 0x22,
  SOURCE_NAME_REQUEST: 0x61,
  SOURCE_NAME_RESPONSE: 0x62,
  DEST_NAME_REQUEST: 0x63,
  DEST_NAME_RESPONSE: 0x64,
  EXTENDED_CROSSPOINT_CONNECT: 0x04,
  EXTENDED_CROSSPOINT_CONNECTED: 0x05,
  EXTENDED_CROSSPOINT_INTERROGATE: 0x06,
  EXTENDED_CROSSPOINT_TALLY: 0x07
};

class SWP08Server extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 8910;
    this.inputs = options.inputs || 12;
    this.outputs = options.outputs || 12;
    this.levels = options.levels || 1;  // Number of matrix levels (video, audio, etc.)
    this.modelName = options.modelName || 'SW-P-08 Router Simulator';
    this.friendlyName = options.friendlyName || 'SWP08 Simulator';

    // Initialize routing table per level: routing[level][dest] = source
    this.routing = {};
    for (let level = 0; level < this.levels; level++) {
      this.routing[level] = {};
      for (let dest = 0; dest < this.outputs; dest++) {
        this.routing[level][dest] = dest < this.inputs ? dest : 0;
      }
    }

    // Initialize labels with TV station example names
    this.defaultInputLabels = [
      'CAM 1', 'CAM 2', 'CAM 3', 'CAM 4',
      'GFX', 'VTR 1', 'VTR 2', 'LIVE',
      'SAT RX', 'STU A', 'STU B', 'RMT 1',
      'EDIT 1', 'EDIT 2', 'COLOR', 'BOOTH',
      'SVR 1', 'SVR 2', 'SVR 3', 'SVR 4'
    ];
    this.defaultOutputLabels = [
      'PGM', 'PVW', 'MV 1', 'MV 2',
      'TX 1', 'TX 2', 'REC 1', 'REC 2',
      'EDT1 I', 'EDT2 I', 'CLR IN', 'QC MON',
      'MCR', 'STREAM', 'CONF', 'ARCH',
      'STU MN', 'GRN RM', 'LOBBY', 'WEB'
    ];

    this.inputLabels = {};
    this.outputLabels = {};
    for (let i = 0; i < this.inputs; i++) {
      // SW-P-08 labels are 8 characters max
      this.inputLabels[i] = (this.defaultInputLabels[i] || `IN ${i + 1}`).substring(0, 8).padEnd(8);
    }
    for (let i = 0; i < this.outputs; i++) {
      this.outputLabels[i] = (this.defaultOutputLabels[i] || `OUT ${i + 1}`).substring(0, 8).padEnd(8);
    }

    this.clients = new Set();
    this.server = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.server.listen(this.port, () => {
        this.emit('started', this.port);
        resolve(this.port);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      for (const client of this.clients) {
        client.destroy();
      }
      this.clients.clear();

      if (this.server) {
        this.server.close(() => {
          this.emit('stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  handleConnection(socket) {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    this.clients.add(socket);
    this.emit('client-connected', clientId);

    let buffer = Buffer.alloc(0);

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      this.processBuffer(socket, buffer, clientId, (remaining) => {
        buffer = remaining;
      });
    });

    socket.on('close', () => {
      this.clients.delete(socket);
      this.emit('client-disconnected', clientId);
    });

    socket.on('error', (err) => {
      this.emit('client-error', { clientId, error: err });
      this.clients.delete(socket);
    });
  }

  processBuffer(socket, buffer, clientId, callback) {
    // Look for DLE STX sequence
    while (buffer.length >= 4) {
      const dlePos = buffer.indexOf(DLE);
      if (dlePos === -1) {
        callback(Buffer.alloc(0));
        return;
      }

      // Skip bytes before DLE
      if (dlePos > 0) {
        buffer = buffer.slice(dlePos);
      }

      // Check for STX after DLE
      if (buffer.length < 2 || buffer[1] !== STX) {
        buffer = buffer.slice(1);
        continue;
      }

      // Find message end - look for next DLE that's not escaped (DLE DLE)
      let msgEnd = -1;
      for (let i = 2; i < buffer.length - 1; i++) {
        if (buffer[i] === DLE && buffer[i + 1] !== DLE) {
          msgEnd = i;
          break;
        }
        if (buffer[i] === DLE && buffer[i + 1] === DLE) {
          i++; // Skip escaped DLE
        }
      }

      if (msgEnd === -1) {
        // Message not complete yet
        callback(buffer);
        return;
      }

      // Extract message (without DLE STX and trailing DLE)
      const msgData = this.unescapeData(buffer.slice(2, msgEnd));
      const checkByte = buffer[msgEnd + 1]; // Byte after trailing DLE

      // Verify checksum
      if (this.verifyChecksum(msgData, checkByte)) {
        this.processMessage(socket, msgData, clientId);
        socket.write(Buffer.from([DLE, ACK]));
      } else {
        socket.write(Buffer.from([DLE, NAK]));
      }

      // Move past this message
      buffer = buffer.slice(msgEnd + 2);
    }

    callback(buffer);
  }

  unescapeData(data) {
    const result = [];
    for (let i = 0; i < data.length; i++) {
      if (data[i] === DLE && i + 1 < data.length && data[i + 1] === DLE) {
        result.push(DLE);
        i++;
      } else {
        result.push(data[i]);
      }
    }
    return Buffer.from(result);
  }

  escapeData(data) {
    const result = [];
    for (const byte of data) {
      result.push(byte);
      if (byte === DLE) {
        result.push(DLE); // Escape DLE by doubling it
      }
    }
    return Buffer.from(result);
  }

  calculateChecksum(data) {
    let sum = 0;
    for (const byte of data) {
      sum = (sum + byte) & 0xFF;
    }
    return (~sum + 1) & 0xFF; // Two's complement
  }

  verifyChecksum(data, checkByte) {
    const calculated = this.calculateChecksum(data);
    return calculated === checkByte;
  }

  buildMessage(data) {
    const escaped = this.escapeData(data);
    const checksum = this.calculateChecksum(data);
    return Buffer.concat([
      Buffer.from([DLE, STX]),
      escaped,
      Buffer.from([DLE, checksum])
    ]);
  }

  processMessage(socket, data, clientId) {
    if (data.length < 4) return;

    const cmd = data[0];
    const matrix = data[1];
    const level = data[2];
    const multiplier = data[3];

    this.emit('command-received', {
      clientId,
      command: `CMD:0x${cmd.toString(16)} Matrix:${matrix} Level:${level}`
    });

    switch (cmd) {
      case CMD.CROSSPOINT_INTERROGATE:
        this.handleCrosspointInterrogate(socket, data);
        break;
      case CMD.CROSSPOINT_CONNECT:
        this.handleCrosspointConnect(socket, data, clientId);
        break;
      case CMD.CROSSPOINT_TALLY_DUMP_REQUEST:
        this.handleTallyDumpRequest(socket, data);
        break;
      case CMD.SOURCE_NAME_REQUEST:
        this.handleSourceNameRequest(socket, data);
        break;
      case CMD.DEST_NAME_REQUEST:
        this.handleDestNameRequest(socket, data);
        break;
      case CMD.EXTENDED_CROSSPOINT_INTERROGATE:
        this.handleExtendedCrosspointInterrogate(socket, data);
        break;
      case CMD.EXTENDED_CROSSPOINT_CONNECT:
        this.handleExtendedCrosspointConnect(socket, data, clientId);
        break;
      default:
        this.emit('unknown-command', { clientId, command: `0x${cmd.toString(16)}` });
    }
  }

  handleCrosspointInterrogate(socket, data) {
    // Response: CROSSPOINT_CONNECTED
    const level = data[2] & 0x0F;
    const destByte = data.length > 4 ? data[4] : 0;
    const dest = destByte;

    const source = this.routing[level]?.[dest] ?? 0;

    const response = Buffer.from([
      CMD.CROSSPOINT_CONNECTED,
      data[1],  // matrix
      level,
      0,        // multiplier (dest high byte)
      dest,     // destination
      0,        // multiplier (source high byte)
      source    // source
    ]);

    socket.write(this.buildMessage(response));
  }

  handleCrosspointConnect(socket, data, clientId) {
    const level = data[2] & 0x0F;
    const dest = data[4];
    const source = data[6];

    if (level < this.levels && dest < this.outputs && source < this.inputs) {
      this.routing[level][dest] = source;

      // Send connected confirmation to all clients
      const response = Buffer.from([
        CMD.CROSSPOINT_CONNECTED,
        data[1],
        level,
        0,
        dest,
        0,
        source
      ]);
      this.broadcast(this.buildMessage(response));

      this.emit('routing-changed', [{ level, output: dest, input: source }]);
    }
  }

  handleExtendedCrosspointInterrogate(socket, data) {
    // Extended format uses 16-bit source/dest
    const level = data[2] & 0x0F;
    const destHi = data[3];
    const destLo = data[4];
    const dest = (destHi << 8) | destLo;

    const source = this.routing[level]?.[dest] ?? 0;
    const srcHi = (source >> 8) & 0xFF;
    const srcLo = source & 0xFF;

    const response = Buffer.from([
      CMD.EXTENDED_CROSSPOINT_CONNECTED,
      data[1],
      level,
      destHi,
      destLo,
      srcHi,
      srcLo
    ]);

    socket.write(this.buildMessage(response));
  }

  handleExtendedCrosspointConnect(socket, data, clientId) {
    const level = data[2] & 0x0F;
    const destHi = data[3];
    const destLo = data[4];
    const srcHi = data[5];
    const srcLo = data[6];

    const dest = (destHi << 8) | destLo;
    const source = (srcHi << 8) | srcLo;

    if (level < this.levels && dest < this.outputs && source < this.inputs) {
      this.routing[level][dest] = source;

      const response = Buffer.from([
        CMD.EXTENDED_CROSSPOINT_CONNECTED,
        data[1],
        level,
        destHi,
        destLo,
        srcHi,
        srcLo
      ]);
      this.broadcast(this.buildMessage(response));

      this.emit('routing-changed', [{ level, output: dest, input: source }]);
    }
  }

  handleTallyDumpRequest(socket, data) {
    const level = data[2] & 0x0F;

    // Send all crosspoints for this level
    for (let dest = 0; dest < this.outputs; dest++) {
      const source = this.routing[level]?.[dest] ?? 0;
      const response = Buffer.from([
        CMD.CROSSPOINT_TALLY_DUMP_RESPONSE,
        data[1],
        level,
        0,
        dest,
        0,
        source
      ]);
      socket.write(this.buildMessage(response));
    }
  }

  handleSourceNameRequest(socket, data) {
    const charStart = data[3]; // Character position start (usually 0)
    const source = data[4];

    const label = this.inputLabels[source] || `IN ${source + 1}`.padEnd(8);

    const response = Buffer.from([
      CMD.SOURCE_NAME_RESPONSE,
      data[1],
      data[2],
      charStart,
      source,
      ...Buffer.from(label.substring(0, 8).padEnd(8))
    ]);

    socket.write(this.buildMessage(response));
  }

  handleDestNameRequest(socket, data) {
    const charStart = data[3];
    const dest = data[4];

    const label = this.outputLabels[dest] || `OUT ${dest + 1}`.padEnd(8);

    const response = Buffer.from([
      CMD.DEST_NAME_RESPONSE,
      data[1],
      data[2],
      charStart,
      dest,
      ...Buffer.from(label.substring(0, 8).padEnd(8))
    ]);

    socket.write(this.buildMessage(response));
  }

  broadcast(message) {
    for (const client of this.clients) {
      try {
        client.write(message);
      } catch (err) {
        // Client may have disconnected
      }
    }
  }

  // API methods for UI control
  setRoute(output, input, level = 0) {
    if (level < this.levels && output < this.outputs && input < this.inputs) {
      this.routing[level][output] = input;

      const response = Buffer.from([
        CMD.CROSSPOINT_CONNECTED,
        0,
        level,
        0,
        output,
        0,
        input
      ]);
      this.broadcast(this.buildMessage(response));
      this.emit('routing-changed', [{ level, output, input }]);
      return true;
    }
    return false;
  }

  setInputLabel(input, label) {
    if (input >= 0 && input < this.inputs) {
      this.inputLabels[input] = label.substring(0, 8).padEnd(8);
      this.emit('input-labels-changed', [{ input, label: this.inputLabels[input] }]);
      return true;
    }
    return false;
  }

  setOutputLabel(output, label) {
    if (output >= 0 && output < this.outputs) {
      this.outputLabels[output] = label.substring(0, 8).padEnd(8);
      this.emit('output-labels-changed', [{ output, label: this.outputLabels[output] }]);
      return true;
    }
    return false;
  }

  getState() {
    // Flatten routing for UI (use level 0 as primary)
    const flatRouting = {};
    for (let i = 0; i < this.outputs; i++) {
      flatRouting[i] = this.routing[0]?.[i] ?? 0;
    }

    return {
      inputs: this.inputs,
      outputs: this.outputs,
      levels: this.levels,
      modelName: this.modelName,
      friendlyName: this.friendlyName,
      routing: flatRouting,
      inputLabels: { ...this.inputLabels },
      outputLabels: { ...this.outputLabels },
      outputLocks: {},  // SW-P-08 doesn't have built-in locks in basic protocol
      clientCount: this.clients.size
    };
  }

  updateConfig(config) {
    if (config.inputs !== undefined) this.inputs = config.inputs;
    if (config.outputs !== undefined) this.outputs = config.outputs;
    if (config.levels !== undefined) this.levels = config.levels;
    if (config.modelName !== undefined) this.modelName = config.modelName;
    if (config.friendlyName !== undefined) this.friendlyName = config.friendlyName;

    // Reinitialize routing and labels
    for (let level = 0; level < this.levels; level++) {
      if (!this.routing[level]) {
        this.routing[level] = {};
      }
      for (let dest = 0; dest < this.outputs; dest++) {
        if (this.routing[level][dest] === undefined) {
          this.routing[level][dest] = dest < this.inputs ? dest : 0;
        }
      }
    }

    for (let i = 0; i < this.inputs; i++) {
      if (this.inputLabels[i] === undefined) {
        this.inputLabels[i] = (this.defaultInputLabels[i] || `IN ${i + 1}`).substring(0, 8).padEnd(8);
      }
    }
    for (let i = 0; i < this.outputs; i++) {
      if (this.outputLabels[i] === undefined) {
        this.outputLabels[i] = (this.defaultOutputLabels[i] || `OUT ${i + 1}`).substring(0, 8).padEnd(8);
      }
    }
  }
}

module.exports = SWP08Server;
