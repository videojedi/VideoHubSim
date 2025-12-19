const net = require('net');
const EventEmitter = require('events');

// SW-P-08 Protocol Constants
const DLE = 0x10;  // Data Link Escape
const STX = 0x02;  // Start of Text
const ETX = 0x03;  // End of Text
const ACK = 0x06;  // Acknowledge
const NAK = 0x15;  // Negative Acknowledge

// Command codes based on Companion module implementation
const CMD = {
  // Standard commands (8-bit addressing, up to 1024 sources/dests)
  CROSSPOINT_INTERROGATE: 0x01,
  CROSSPOINT_CONNECT: 0x02,
  CROSSPOINT_TALLY: 0x03,
  CROSSPOINT_CONNECTED: 0x04,
  CROSSPOINT_TALLY_DUMP_REQUEST: 0x15,

  // Extended commands (16-bit addressing, up to 65536 sources/dests)
  EXTENDED_CROSSPOINT_INTERROGATE: 0x81,
  EXTENDED_CROSSPOINT_CONNECT: 0x82,
  EXTENDED_CROSSPOINT_TALLY: 0x83,
  EXTENDED_CROSSPOINT_CONNECTED: 0x84,
  EXTENDED_TALLY_DUMP_REQUEST: 0x95,

  // Name commands
  PROTOCOL_IMPLEMENTATION: 0x61,
  SOURCE_NAME_REQUEST: 0x64,
  DEST_NAME_REQUEST: 0x66,
  SOURCE_NAME_RESPONSE: 0x6a,
  DEST_NAME_RESPONSE: 0x6b,

  // Extended name commands
  EXTENDED_SOURCE_NAME_REQUEST: 0xe4,
  EXTENDED_DEST_NAME_REQUEST: 0xe6,
  EXTENDED_SOURCE_NAME_RESPONSE: 0xea,
  EXTENDED_DEST_NAME_RESPONSE: 0xeb
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

    // Default level names
    this.defaultLevelNames = [
      'Video', 'Audio 1', 'Audio 2', 'Audio 3',
      'Audio 4', 'Audio 5', 'Audio 6', 'Audio 7',
      'Audio 8', 'Audio 9', 'Audio 10', 'Audio 11',
      'Audio 12', 'Audio 13', 'Audio 14', 'Audio 15'
    ];

    // Initialize level names
    this.levelNames = {};
    for (let i = 0; i < this.levels; i++) {
      this.levelNames[i] = this.defaultLevelNames[i] || `Level ${i + 1}`;
    }

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

      // Find message end - look for DLE ETX sequence (not escaped DLE DLE)
      let msgEnd = -1;
      for (let i = 2; i < buffer.length - 1; i++) {
        if (buffer[i] === DLE) {
          if (buffer[i + 1] === DLE) {
            i++; // Skip escaped DLE
          } else if (buffer[i + 1] === ETX) {
            msgEnd = i;
            break;
          }
        }
      }

      if (msgEnd === -1) {
        // Message not complete yet
        callback(buffer);
        return;
      }

      // Extract message data (between DLE STX and DLE ETX)
      // Format: DLE STX [DATA] [BTC] [CHECKSUM] DLE ETX
      const rawData = buffer.slice(2, msgEnd);
      const unescaped = this.unescapeData(rawData);

      // Need at least 3 bytes: 1 data + BTC + checksum
      if (unescaped.length < 3) {
        // Invalid message, skip
        buffer = buffer.slice(msgEnd + 2);
        continue;
      }

      const checkByte = unescaped[unescaped.length - 1];  // Last byte is checksum
      const btc = unescaped[unescaped.length - 2];        // Second to last is BTC
      const msgData = unescaped.slice(0, -2);             // Data without BTC and checksum

      // Verify BTC (byte count should equal data length + 1)
      const expectedBtc = msgData.length + 1;
      if (btc !== expectedBtc) {
        // BTC mismatch - might be old format without BTC, try legacy parsing
        // Some implementations don't include BTC
        const legacyData = unescaped.slice(0, -1);
        const legacyCheck = unescaped[unescaped.length - 1];
        if (this.verifyChecksum(legacyData, legacyCheck)) {
          this.processMessage(socket, legacyData, clientId);
          socket.write(Buffer.from([DLE, ACK]));
          buffer = buffer.slice(msgEnd + 2);
          continue;
        }
        socket.write(Buffer.from([DLE, NAK]));
        buffer = buffer.slice(msgEnd + 2);
        continue;
      }

      // Verify checksum (calculated over data + BTC)
      const dataWithBtc = unescaped.slice(0, -1);  // Everything except checksum
      if (this.verifyChecksum(dataWithBtc, checkByte)) {
        this.processMessage(socket, msgData, clientId);
        socket.write(Buffer.from([DLE, ACK]));
      } else {
        socket.write(Buffer.from([DLE, NAK]));
      }

      // Move past this message (DLE ETX = 2 bytes)
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
    // SW-P-08 message format:
    // DLE STX [DATA] [BTC] [CHECKSUM] DLE ETX
    // BTC = byte count = data length (the number of data bytes, not including BTC or checksum)
    // Companion validates: packet[packet.length - 2] === packet.length - 2
    // So for 5 data bytes: payload is [5 bytes data][5][checksum] = 7 bytes
    // And packet.length - 2 = 5, which should equal BTC
    const btc = data.length;

    // Checksum is two's complement of (data + BTC)
    const dataWithBtc = Buffer.concat([data, Buffer.from([btc])]);
    const checksum = this.calculateChecksum(dataWithBtc);

    // Full payload: data + BTC + checksum
    const payload = Buffer.concat([dataWithBtc, Buffer.from([checksum])]);
    const escaped = this.escapeData(payload);

    return Buffer.concat([
      Buffer.from([DLE, STX]),
      escaped,
      Buffer.from([DLE, ETX])
    ]);
  }

  processMessage(socket, data, clientId) {
    if (data.length < 1) return;

    const cmd = data[0];
    const matrix = data.length > 1 ? data[1] : 0;
    const level = data.length > 2 ? data[2] : 0;

    this.emit('command-received', {
      clientId,
      command: `CMD:0x${cmd.toString(16).padStart(2, '0')} Matrix:${matrix} Level:${level} Len:${data.length} Data:${data.toString('hex')}`
    });

    switch (cmd) {
      case CMD.CROSSPOINT_INTERROGATE:
        this.handleCrosspointInterrogate(socket, data);
        break;
      case CMD.CROSSPOINT_CONNECT:
        this.handleCrosspointConnect(socket, data);
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
        this.handleExtendedCrosspointConnect(socket, data);
        break;
      case CMD.EXTENDED_SOURCE_NAME_REQUEST:
        this.handleExtendedSourceNameRequest(socket, data);
        break;
      case CMD.EXTENDED_DEST_NAME_REQUEST:
        this.handleExtendedDestNameRequest(socket, data);
        break;
      default:
        this.emit('unknown-command', { clientId, command: `0x${cmd.toString(16)}` });
    }
  }

  handleCrosspointInterrogate(socket, data) {
    // SW-P-08 Standard Crosspoint Interrogate (0x01)
    // Request: CMD MATRIX+LEVEL MULT DEST (4 bytes min)
    // Byte 1: ((matrix-1) << 4) | (level & 0x0f)
    // Byte 2: Multiplier - dest high bits in bits 4-6
    // Byte 3: Dest low byte (dest & 0x7f)
    if (data.length < 4) return;

    const matrixLevel = data[1];
    const matrix = ((matrixLevel >> 4) & 0x0F) + 1;
    const level = matrixLevel & 0x0F;
    const multiplier = data[2];
    const destLo = data[3];
    const destHi = (multiplier >> 4) & 0x07;
    const dest = (destHi << 7) | (destLo & 0x7F);

    const source = this.routing[level]?.[dest] ?? 0;

    // Response: CROSSPOINT_CONNECTED (0x04)
    // Byte 1: ((matrix-1) << 4) | (level & 0x0f)
    // Byte 2: Multiplier with source high (bits 0-2) and dest high (bits 4-6)
    // Byte 3: Dest low byte
    // Byte 4: Source low byte
    const srcHi = (source >> 7) & 0x07;
    const srcLo = source & 0x7F;
    const respMultiplier = (destHi << 4) | srcHi;

    const response = Buffer.from([
      CMD.CROSSPOINT_CONNECTED,
      matrixLevel,
      respMultiplier,
      destLo,
      srcLo
    ]);

    socket.write(this.buildMessage(response));
  }

  handleCrosspointConnect(socket, data) {
    // SW-P-08 Standard Crosspoint Connect (0x02)
    // Byte 0: CMD (0x02)
    // Byte 1: ((matrix-1) << 4) | (level & 0x0f)
    // Byte 2: Multiplier - source high (bits 0-2), dest high (bits 4-6)
    // Byte 3: Dest low byte (dest & 0x7f)
    // Byte 4: Source low byte (source & 0x7f)
    if (data.length < 5) return;

    const matrixLevel = data[1];
    const matrix = ((matrixLevel >> 4) & 0x0F) + 1;
    const level = matrixLevel & 0x0F;
    const multiplier = data[2];
    const destLo = data[3];
    const srcLo = data[4];

    const srcHi = multiplier & 0x07;
    const destHi = (multiplier >> 4) & 0x07;
    const source = (srcHi << 7) | (srcLo & 0x7F);
    const dest = (destHi << 7) | (destLo & 0x7F);

    // Ensure level exists in routing table
    if (!this.routing[level]) {
      this.routing[level] = {};
    }

    if (dest < this.outputs && source < this.inputs) {
      this.routing[level][dest] = source;

      // Send CROSSPOINT_CONNECTED (0x04) confirmation to all clients
      const respMultiplier = (destHi << 4) | srcHi;
      const response = Buffer.from([
        CMD.CROSSPOINT_CONNECTED,
        matrixLevel,
        respMultiplier,
        destLo,
        srcLo
      ]);
      this.broadcast(this.buildMessage(response));

      this.emit('routing-changed', [{ level, output: dest, input: source }]);
    }
  }

  handleExtendedCrosspointInterrogate(socket, data) {
    // Extended format (0x81) uses 16-bit addressing
    // Request: CMD MATRIX LEVEL DEST_HI DEST_LO (5 bytes)
    // Response: CMD MATRIX LEVEL DEST_HI DEST_LO SRC_HI SRC_LO (7 bytes)
    if (data.length < 5) return;

    const matrix = data[1];
    const level = data[2];
    const destHi = data[3];
    const destLo = data[4];
    const dest = (destHi << 8) | destLo;

    const source = this.routing[level]?.[dest] ?? 0;
    const srcHi = (source >> 8) & 0xFF;
    const srcLo = source & 0xFF;

    const response = Buffer.from([
      CMD.EXTENDED_CROSSPOINT_CONNECTED,
      matrix,
      level,
      destHi,
      destLo,
      srcHi,
      srcLo
    ]);

    socket.write(this.buildMessage(response));
  }

  handleExtendedCrosspointConnect(socket, data) {
    // Extended format (0x82): CMD MATRIX LEVEL DEST_HI DEST_LO SRC_HI SRC_LO (7 bytes)
    if (data.length < 7) return;

    const matrix = data[1];
    const level = data[2];
    const destHi = data[3];
    const destLo = data[4];
    const srcHi = data[5];
    const srcLo = data[6];

    const dest = (destHi << 8) | destLo;
    const source = (srcHi << 8) | srcLo;

    // Ensure level exists in routing table
    if (!this.routing[level]) {
      this.routing[level] = {};
    }

    if (dest < this.outputs && source < this.inputs) {
      this.routing[level][dest] = source;

      const response = Buffer.from([
        CMD.EXTENDED_CROSSPOINT_CONNECTED,
        matrix,
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
    // Tally dump request (0x15)
    // Send CROSSPOINT_TALLY (0x03) for each crosspoint
    const matrixLevel = data[1];
    const level = matrixLevel & 0x0F;

    // Send all crosspoints for this level using standard tally format
    for (let dest = 0; dest < this.outputs; dest++) {
      const source = this.routing[level]?.[dest] ?? 0;

      const srcHi = (source >> 7) & 0x07;
      const srcLo = source & 0x7F;
      const destHi = (dest >> 7) & 0x07;
      const destLo = dest & 0x7F;
      const multiplier = (destHi << 4) | srcHi;

      const response = Buffer.from([
        CMD.CROSSPOINT_TALLY,
        matrixLevel,
        multiplier,
        destLo,
        srcLo
      ]);
      socket.write(this.buildMessage(response));
    }
  }

  handleSourceNameRequest(socket, data) {
    // Source name request (0x64)
    // Format: CMD MATRIX+LEVEL CHAR_LEN (3 bytes minimum)
    // Companion sends: CMD, matrix<<4|level, charLenIndex
    // We respond with all source names
    if (data.length < 3) return;

    const matrixLevel = data[1];
    const charLenIndex = data[2];  // 0=4 chars, 1=8 chars, 2=12 chars
    const charLengths = [4, 8, 12];
    const charLen = charLengths[charLenIndex] || 8;

    // Send names in batches - Companion expects:
    // CMD, MATRIX+LEVEL, CHAR_LEN_INDEX, LABEL_NUM_HI, LABEL_NUM_LO, COUNT, [NAMES...]
    for (let i = 0; i < this.inputs; i++) {
      const label = this.inputLabels[i] || `IN ${i + 1}`;
      const paddedLabel = label.substring(0, charLen).padEnd(charLen);

      const response = Buffer.from([
        CMD.SOURCE_NAME_RESPONSE,
        matrixLevel,
        charLenIndex,
        (i >> 8) & 0xFF,  // Label number high byte
        i & 0xFF,          // Label number low byte
        1,                 // Count (1 label per message)
        ...Buffer.from(paddedLabel)
      ]);

      socket.write(this.buildMessage(response));
    }
  }

  handleDestNameRequest(socket, data) {
    // Dest name request (0x66)
    // Format: CMD MATRIX CHAR_LEN (3 bytes minimum)
    // Note: Dest names don't have level in the matrix byte
    if (data.length < 3) return;

    const matrix = data[1];
    const charLenIndex = data[2];  // 0=4 chars, 1=8 chars, 2=12 chars
    const charLengths = [4, 8, 12];
    const charLen = charLengths[charLenIndex] || 8;

    // Send names in batches - Companion expects:
    // CMD, MATRIX, CHAR_LEN_INDEX, LABEL_NUM_HI, LABEL_NUM_LO, COUNT, [NAMES...]
    for (let i = 0; i < this.outputs; i++) {
      const label = this.outputLabels[i] || `OUT ${i + 1}`;
      const paddedLabel = label.substring(0, charLen).padEnd(charLen);

      const response = Buffer.from([
        CMD.DEST_NAME_RESPONSE,
        matrix,
        charLenIndex,
        (i >> 8) & 0xFF,  // Label number high byte
        i & 0xFF,          // Label number low byte
        1,                 // Count (1 label per message)
        ...Buffer.from(paddedLabel)
      ]);

      socket.write(this.buildMessage(response));
    }
  }

  handleExtendedSourceNameRequest(socket, data) {
    // Extended source name request (0xe4)
    // Format: CMD MATRIX LEVEL CHAR_LEN (4 bytes minimum)
    if (data.length < 4) return;

    const matrix = data[1];
    const level = data[2];
    const charLenIndex = data[3];  // 0=4 chars, 1=8 chars, 2=12 chars
    const charLengths = [4, 8, 12];
    const charLen = charLengths[charLenIndex] || 8;

    // Send names - Extended format:
    // CMD, MATRIX, LEVEL, CHAR_LEN_INDEX, LABEL_NUM_HI, LABEL_NUM_LO, COUNT, [NAMES...]
    for (let i = 0; i < this.inputs; i++) {
      const label = this.inputLabels[i] || `IN ${i + 1}`;
      const paddedLabel = label.substring(0, charLen).padEnd(charLen);

      const response = Buffer.from([
        CMD.EXTENDED_SOURCE_NAME_RESPONSE,
        matrix,
        level,
        charLenIndex,
        (i >> 8) & 0xFF,  // Label number high byte
        i & 0xFF,          // Label number low byte
        1,                 // Count (1 label per message)
        ...Buffer.from(paddedLabel)
      ]);

      socket.write(this.buildMessage(response));
    }
  }

  handleExtendedDestNameRequest(socket, data) {
    // Extended dest name request (0xe6)
    // Format: CMD MATRIX LEVEL CHAR_LEN (4 bytes minimum)
    if (data.length < 4) return;

    const matrix = data[1];
    const level = data[2];
    const charLenIndex = data[3];  // 0=4 chars, 1=8 chars, 2=12 chars
    const charLengths = [4, 8, 12];
    const charLen = charLengths[charLenIndex] || 8;

    // Send names - Extended format:
    // CMD, MATRIX, LEVEL, CHAR_LEN_INDEX, LABEL_NUM_HI, LABEL_NUM_LO, COUNT, [NAMES...]
    for (let i = 0; i < this.outputs; i++) {
      const label = this.outputLabels[i] || `OUT ${i + 1}`;
      const paddedLabel = label.substring(0, charLen).padEnd(charLen);

      const response = Buffer.from([
        CMD.EXTENDED_DEST_NAME_RESPONSE,
        matrix,
        level,
        charLenIndex,
        (i >> 8) & 0xFF,  // Label number high byte
        i & 0xFF,          // Label number low byte
        1,                 // Count (1 label per message)
        ...Buffer.from(paddedLabel)
      ]);

      socket.write(this.buildMessage(response));
    }
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
    // Ensure level exists
    if (!this.routing[level]) {
      this.routing[level] = {};
    }

    if (output < this.outputs && input < this.inputs) {
      this.routing[level][output] = input;

      // Broadcast CROSSPOINT_CONNECTED (0x04) using standard format
      const matrixLevel = (0 << 4) | (level & 0x0F);  // matrix 1, level
      const srcHi = (input >> 7) & 0x07;
      const srcLo = input & 0x7F;
      const destHi = (output >> 7) & 0x07;
      const destLo = output & 0x7F;
      const multiplier = (destHi << 4) | srcHi;

      const response = Buffer.from([
        CMD.CROSSPOINT_CONNECTED,
        matrixLevel,
        multiplier,
        destLo,
        srcLo
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

  getState(level = 0) {
    // Get routing for specified level
    const levelRouting = {};
    for (let i = 0; i < this.outputs; i++) {
      levelRouting[i] = this.routing[level]?.[i] ?? 0;
    }

    // Get all levels routing for complete state
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
      outputLocks: {},  // SW-P-08 doesn't have built-in locks in basic protocol
      clientCount: this.clients.size
    };
  }

  getRoutingForLevel(level) {
    const levelRouting = {};
    for (let i = 0; i < this.outputs; i++) {
      levelRouting[i] = this.routing[level]?.[i] ?? 0;
    }
    return levelRouting;
  }

  setLevelName(level, name) {
    if (level >= 0 && level < this.levels) {
      this.levelNames[level] = name;
      this.emit('level-names-changed', [{ level, name }]);
      return true;
    }
    return false;
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
      // Initialize level name if needed
      if (this.levelNames[level] === undefined) {
        this.levelNames[level] = this.defaultLevelNames[level] || `Level ${level + 1}`;
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
