const net = require('net');
const EventEmitter = require('events');

// GV Native Protocol Constants
const SOH = 0x01;  // Start of Header
const EOT = 0x04;  // End of Transmission
const HT = 0x09;   // Horizontal Tab (field separator)
const PROTOCOL_ID = 'N';  // Native Protocol identifier

// Command names for logging
const CMD_NAMES = {
  'QN': 'Query Names',
  'QD': 'Query Destination Status',
  'Qd': 'Query Destination Status (with NO_XPT)',
  'QJ': 'Query Destination Status by Index',
  'Qj': 'Query Destination Status by Index (with NO_XPT)',
  'QI': 'Query Destination Status by Index (single)',
  'Qi': 'Query Destination Status by Index (single, with NO_XPT)',
  'TA': 'Request Take',
  'TD': 'Request Take Destination',
  'TI': 'Request Take Index (single level)',
  'TJ': 'Request Take Index (multi-level)',
  'BK': 'Background Activities',
  'QE': 'Query Error Definition',
  'QT': 'Query Date/Time'
};

class GVNativeServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 12345;
    this.inputs = options.inputs || 12;
    this.outputs = options.outputs || 12;
    this.levels = options.levels || 1;
    this.modelName = options.modelName || 'GV Native Router Simulator';
    this.friendlyName = options.friendlyName || 'GV Native Simulator';

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

    // Initialize labels (GV Native uses 8 chars max)
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
      this.inputLabels[i] = (this.defaultInputLabels[i] || `Input${String(i + 1).padStart(3, '0')}`).substring(0, 8);
    }
    for (let i = 0; i < this.outputs; i++) {
      this.outputLabels[i] = (this.defaultOutputLabels[i] || `Output${String(i + 1).padStart(2, '0')}`).substring(0, 8);
    }

    // Echo mode for Level 4 acknowledgments
    this.echoEnabled = true;

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
      buffer = this.processBuffer(socket, buffer, clientId);
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

  processBuffer(socket, buffer, clientId) {
    // Look for SOH...EOT message frames
    while (buffer.length >= 6) {  // Minimum: SOH + N + 0 + XX + checksum(2) + EOT
      const sohPos = buffer.indexOf(SOH);
      if (sohPos === -1) {
        return Buffer.alloc(0);
      }

      // Skip bytes before SOH
      if (sohPos > 0) {
        buffer = buffer.slice(sohPos);
      }

      // Find EOT
      const eotPos = buffer.indexOf(EOT, 1);
      if (eotPos === -1) {
        // Message not complete yet
        return buffer;
      }

      // Extract message (SOH to EOT inclusive)
      const messageData = buffer.slice(1, eotPos);  // Exclude SOH and EOT

      // Parse and process the message
      const parsed = this.parseMessage(messageData);
      if (parsed) {
        this.processMessage(socket, parsed, clientId);
      }

      // Move past this message
      buffer = buffer.slice(eotPos + 1);
    }

    return buffer;
  }

  parseMessage(data) {
    // Format: protocol_id + seq_flag + command(2) + [params] + checksum(2)
    // Minimum length: N + 0 + XX + CC = 6 bytes
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
      // Checksum mismatch - still process but log warning
      console.warn(`GV Native checksum mismatch: expected ${calculatedChecksum.toString(16)}, got ${checksumStr}`);
    }

    // Extract parameters (between command and checksum)
    // Parameters are separated by HT (0x09)
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
    // Parameters are HT-separated, first HT is prefix
    const parts = paramsStr.split(String.fromCharCode(HT));
    // Filter empty strings (first element is empty due to leading HT)
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

    // Add trailing HT for responses
    if (params.length > 0) {
      parts.push(String.fromCharCode(HT));
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

  processMessage(socket, parsed, clientId) {
    const { command, params } = parsed;
    const cmdName = CMD_NAMES[command] || command;

    this.emit('command-received', {
      clientId,
      command: `${cmdName} (${command}) Params: ${params.join(', ') || '(none)'}`
    });

    switch (command) {
      case 'QN':
        this.handleQueryNames(socket, params);
        break;
      case 'QD':
      case 'Qd':
        this.handleQueryDestStatus(socket, params, command === 'Qd');
        break;
      case 'QJ':
      case 'Qj':
        this.handleQueryDestStatusByIndex(socket, params, command === 'Qj');
        break;
      case 'QI':
      case 'Qi':
        this.handleQueryDestStatusByIndexSingle(socket, params, command === 'Qi');
        break;
      case 'TA':
        this.handleTake(socket, params);
        break;
      case 'TD':
        this.handleTakeDestination(socket, params);
        break;
      case 'TI':
        this.handleTakeIndex(socket, params);
        break;
      case 'TJ':
        this.handleTakeIndexMulti(socket, params);
        break;
      case 'BK':
        this.handleBackground(socket, params);
        break;
      case 'QE':
        this.handleQueryError(socket, params);
        break;
      case 'QT':
        this.handleQueryTime(socket);
        break;
      default:
        // Send error for unknown command
        this.sendError(socket, '0F', command);  // Unknown command error
    }
  }

  // Helper to convert number to 4-digit hex string
  toHex4(num) {
    return num.toString(16).toUpperCase().padStart(4, '0');
  }

  // Helper to convert number to 8-digit hex string (level bitmap)
  toLevelBitmap(levels) {
    // Create bitmap where bit N = level N is present
    let bitmap = 0;
    if (Array.isArray(levels)) {
      for (const level of levels) {
        bitmap |= (1 << level);
      }
    } else {
      // Single number of levels - set bits 0 to levels-1
      for (let i = 0; i < levels; i++) {
        bitmap |= (1 << i);
      }
    }
    return bitmap.toString(16).toUpperCase().padStart(8, '0');
  }

  // Parse level bitmap from hex string
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

  // Find source name by label
  findSourceByName(name) {
    for (let i = 0; i < this.inputs; i++) {
      if (this.inputLabels[i] === name || this.inputLabels[i].trim() === name.trim()) {
        return i;
      }
    }
    return -1;
  }

  // Find destination name by label
  findDestByName(name) {
    for (let i = 0; i < this.outputs; i++) {
      if (this.outputLabels[i] === name || this.outputLabels[i].trim() === name.trim()) {
        return i;
      }
    }
    return -1;
  }

  handleQueryNames(socket, params) {
    // QN,<type> where type is S, D, L, IS, ID, XS, XD, XL
    const type = params[0] || 'S';

    switch (type) {
      case 'S':  // Source names
        this.sendSourceNames(socket, false);
        break;
      case 'D':  // Destination names
        this.sendDestNames(socket, false);
        break;
      case 'L':  // Level names
        this.sendLevelNames(socket);
        break;
      case 'IS':  // Sources with indices
        this.sendSourceNames(socket, true);
        break;
      case 'ID':  // Destinations with indices
        this.sendDestNames(socket, true);
        break;
      case 'XS':  // Source indices only
        this.sendSourceIndices(socket);
        break;
      case 'XD':  // Destination indices only
        this.sendDestIndices(socket);
        break;
      case 'XL':  // Level indices only
        this.sendLevelIndices(socket);
        break;
      default:
        this.sendError(socket, '0A', 'QN');  // Invalid parameter
    }
  }

  sendSourceNames(socket, withIndex) {
    // NQ,S,nbr_sources[,src_name_entry1,...,src_name_entryn]
    // src_name_entry: src_name,<'N'|'T'>,level_bitmap
    // or with index: src_name,src_index,<'N'|'T'>,level_bitmap
    const entries = [];
    const levelBitmap = this.toLevelBitmap(this.levels);

    for (let i = 0; i < this.inputs; i++) {
      const name = this.inputLabels[i];
      if (withIndex) {
        entries.push(`${name}`, this.toHex4(i), 'N', levelBitmap);
      } else {
        entries.push(`${name}`, 'N', levelBitmap);
      }
    }

    const response = this.buildMessage('NQ', ['S', this.inputs.toString(16).toUpperCase(), ...entries]);
    socket.write(response);
  }

  sendDestNames(socket, withIndex) {
    // NQ,D,nbr_destns[,dest_name_entry1,...,dest_name_entryn]
    const entries = [];
    const levelBitmap = this.toLevelBitmap(this.levels);

    for (let i = 0; i < this.outputs; i++) {
      const name = this.outputLabels[i];
      if (withIndex) {
        entries.push(`${name}`, this.toHex4(i), 'N', levelBitmap);
      } else {
        entries.push(`${name}`, 'N', levelBitmap);
      }
    }

    const response = this.buildMessage('NQ', ['D', this.outputs.toString(16).toUpperCase(), ...entries]);
    socket.write(response);
  }

  sendLevelNames(socket) {
    // NQ,L,nbr_levels[,lvl_name_entry1,...,lvl_name_entryn]
    // lvl_name_entry: lvl_name,lvl_number,<'R'|'N'>
    const entries = [];

    for (let i = 0; i < this.levels; i++) {
      const name = this.levelNames[i];
      const lvlNum = i.toString(16).toUpperCase().padStart(2, '0');
      entries.push(`${name}`, lvlNum, 'N');  // N = not restricted
    }

    const response = this.buildMessage('NQ', ['L', this.levels.toString(16).toUpperCase(), ...entries]);
    socket.write(response);
  }

  sendSourceIndices(socket) {
    // NQ,XS,No_entries,src_index_entry1...,src_index_entryN
    // src_index_entry: src_index, Tie_flag, src_levelbitmap
    const entries = [];
    const levelBitmap = this.toLevelBitmap(this.levels);

    for (let i = 0; i < this.inputs; i++) {
      entries.push(this.toHex4(i), 'N', levelBitmap);
    }

    const response = this.buildMessage('NQ', ['XS', this.inputs.toString(16).toUpperCase(), ...entries]);
    socket.write(response);
  }

  sendDestIndices(socket) {
    // NQ,XD,No_entries,dest_index_entry1...dest_index_entryN
    const entries = [];
    const levelBitmap = this.toLevelBitmap(this.levels);

    for (let i = 0; i < this.outputs; i++) {
      entries.push(this.toHex4(i), 'N', levelBitmap);
    }

    const response = this.buildMessage('NQ', ['XD', this.outputs.toString(16).toUpperCase(), ...entries]);
    socket.write(response);
  }

  sendLevelIndices(socket) {
    // NQ,XL,No_entries,levelIndex1,...,levelIndexN
    const entries = [];

    for (let i = 0; i < this.levels; i++) {
      entries.push(i.toString(16).toUpperCase().padStart(2, '0'));
    }

    const response = this.buildMessage('NQ', ['XL', this.levels.toString(16).toUpperCase(), ...entries]);
    socket.write(response);
  }

  handleQueryDestStatus(socket, params, withNoXpt) {
    // QD[,dest_name]
    // If no dest_name, return status for all destinations
    const destName = params[0];

    if (destName) {
      // Query single destination
      const destIndex = this.findDestByName(destName);
      if (destIndex < 0) {
        this.sendError(socket, '02', 'QD');  // Invalid destination name
        return;
      }
      this.sendDestStatus(socket, destIndex, withNoXpt ? 'dQ' : 'DQ');
    } else {
      // Query all destinations
      for (let i = 0; i < this.outputs; i++) {
        this.sendDestStatus(socket, i, withNoXpt ? 'dQ' : 'DQ');
      }
      // Send ER,00 to indicate end if echo enabled
      if (this.echoEnabled) {
        this.sendError(socket, '00', 'QD');
      }
    }
  }

  handleQueryDestStatusByIndex(socket, params, withNoXpt) {
    // QJ[,dest_index]
    const destIndexStr = params[0];

    if (destIndexStr) {
      const destIndex = parseInt(destIndexStr, 16);
      if (destIndex < 0 || destIndex >= this.outputs) {
        this.sendError(socket, '02', 'QJ');  // Invalid destination
        return;
      }
      this.sendDestStatusByIndex(socket, destIndex, withNoXpt ? 'jQ' : 'JQ');
    } else {
      // Query all destinations
      for (let i = 0; i < this.outputs; i++) {
        this.sendDestStatusByIndex(socket, i, withNoXpt ? 'jQ' : 'JQ');
      }
      // Send ER,00 to indicate end
      if (this.echoEnabled) {
        this.sendError(socket, '00', 'QJ');
      }
    }
  }

  handleQueryDestStatusByIndexSingle(socket, params, withNoXpt) {
    // QI,destIndex,lvlIndex
    if (params.length < 2) {
      this.sendError(socket, '09', 'QI');  // Missing parameter
      return;
    }

    const destIndex = parseInt(params[0], 16);
    const lvlIndex = parseInt(params[1], 16);

    if (destIndex < 0 || destIndex >= this.outputs) {
      this.sendError(socket, '02', 'QI');
      return;
    }
    if (lvlIndex < 0 || lvlIndex >= this.levels) {
      this.sendError(socket, '04', 'QI');  // Invalid level
      return;
    }

    const source = this.routing[lvlIndex]?.[destIndex] ?? 0;
    const srcIndex = this.toHex4(source);

    // IQ,destIndex,lvlIndex,<'N'|'P'>,<'N'|'C'>,srcIndex,[chop-SrcIndex]
    const response = this.buildMessage(withNoXpt ? 'iQ' : 'IQ', [
      this.toHex4(destIndex),
      this.toHex4(lvlIndex),
      'N',  // Not protected
      'N',  // Not chopping
      srcIndex
    ]);
    socket.write(response);
  }

  sendDestStatus(socket, destIndex, responseCmd) {
    // DQ,dest_name,nbr_sources[,src_name_entry1,...,src_name_entryn]
    // src_name_entry: <'N'|'P'>,<'N'|'C'>,src_name,level_bitmap,[device_name],[chop_src_name]
    const destName = this.outputLabels[destIndex];
    const entries = [];

    // Group sources by their level bitmap
    const sourceGroups = new Map();

    for (let level = 0; level < this.levels; level++) {
      const srcIndex = this.routing[level]?.[destIndex] ?? 0;
      const srcName = this.inputLabels[srcIndex];

      if (!sourceGroups.has(srcName)) {
        sourceGroups.set(srcName, []);
      }
      sourceGroups.get(srcName).push(level);
    }

    // Build entries
    for (const [srcName, levels] of sourceGroups) {
      const levelBitmap = this.toLevelBitmap(levels);
      entries.push('N', 'N', srcName, levelBitmap);
    }

    const response = this.buildMessage(responseCmd, [destName, sourceGroups.size.toString(16).toUpperCase(), ...entries]);
    socket.write(response);
  }

  sendDestStatusByIndex(socket, destIndex, responseCmd) {
    // JQ,dest_index,nbr_sources[,src_name_entry1,...,src_name_entryn]
    // src_name_entry: <'N'|'P'>,<'N'|'C'>,src_index,level_bitmap,[device_name],[chop_src_index]
    const entries = [];

    // Group sources by their level bitmap
    const sourceGroups = new Map();

    for (let level = 0; level < this.levels; level++) {
      const srcIndex = this.routing[level]?.[destIndex] ?? 0;

      if (!sourceGroups.has(srcIndex)) {
        sourceGroups.set(srcIndex, []);
      }
      sourceGroups.get(srcIndex).push(level);
    }

    // Build entries
    for (const [srcIndex, levels] of sourceGroups) {
      const levelBitmap = this.toLevelBitmap(levels);
      entries.push('N', 'N', this.toHex4(srcIndex), levelBitmap);
    }

    const response = this.buildMessage(responseCmd, [this.toHex4(destIndex), sourceGroups.size.toString(16).toUpperCase(), ...entries]);
    socket.write(response);
  }

  handleTake(socket, params) {
    // TA,dest_name,nbr_sources,src_name_entry1,...,src_name_entryn
    // src_name_entry: src_name,level_bitmap
    if (params.length < 3) {
      this.sendError(socket, '09', 'TA');  // Missing parameter
      return;
    }

    const destName = params[0];
    const nbrSources = parseInt(params[1], 16);
    const destIndex = this.findDestByName(destName);

    if (destIndex < 0) {
      this.sendError(socket, '02', 'TA');  // Invalid destination
      return;
    }

    const changes = [];
    let paramIndex = 2;

    for (let i = 0; i < nbrSources && paramIndex + 1 < params.length; i++) {
      const srcName = params[paramIndex++];
      const levelBitmap = params[paramIndex++];
      const srcIndex = this.findSourceByName(srcName);

      if (srcIndex < 0) {
        this.sendError(socket, '03', 'TA');  // Invalid source
        return;
      }

      const levels = this.parseLevelBitmap(levelBitmap);
      for (const level of levels) {
        if (level < this.levels) {
          if (!this.routing[level]) this.routing[level] = {};
          this.routing[level][destIndex] = srcIndex;
          changes.push({ level, output: destIndex, input: srcIndex });
        }
      }
    }

    if (changes.length > 0) {
      this.emit('routing-changed', changes);
    }

    // Send acknowledgment
    if (this.echoEnabled) {
      this.sendError(socket, '00', 'TA');
    }
  }

  handleTakeDestination(socket, params) {
    // TD,dest_name,src_name[,levelbitmap]
    if (params.length < 2) {
      this.sendError(socket, '09', 'TD');
      return;
    }

    const destName = params[0];
    const srcName = params[1];
    const levelBitmap = params[2];

    const destIndex = this.findDestByName(destName);
    const srcIndex = this.findSourceByName(srcName);

    if (destIndex < 0) {
      this.sendError(socket, '02', 'TD');
      return;
    }
    if (srcIndex < 0) {
      this.sendError(socket, '03', 'TD');
      return;
    }

    const changes = [];
    let levels;

    if (levelBitmap) {
      levels = this.parseLevelBitmap(levelBitmap);
    } else {
      // All levels
      levels = [];
      for (let i = 0; i < this.levels; i++) {
        levels.push(i);
      }
    }

    for (const level of levels) {
      if (level < this.levels) {
        if (!this.routing[level]) this.routing[level] = {};
        this.routing[level][destIndex] = srcIndex;
        changes.push({ level, output: destIndex, input: srcIndex });
      }
    }

    if (changes.length > 0) {
      this.emit('routing-changed', changes);
    }

    if (this.echoEnabled) {
      this.sendError(socket, '00', 'TD');
    }
  }

  handleTakeIndex(socket, params) {
    // TI,destIndex,srcIndex[,levelIndex]
    if (params.length < 2) {
      this.sendError(socket, '09', 'TI');
      return;
    }

    const destIndex = parseInt(params[0], 16);
    const srcIndex = parseInt(params[1], 16);
    const levelIndex = params[2] !== undefined ? parseInt(params[2], 16) : -1;

    if (destIndex < 0 || destIndex >= this.outputs) {
      this.sendError(socket, '02', 'TI');
      return;
    }
    if (srcIndex < 0 || srcIndex >= this.inputs) {
      this.sendError(socket, '03', 'TI');
      return;
    }

    const changes = [];

    if (levelIndex >= 0) {
      // Single level
      if (levelIndex >= this.levels) {
        this.sendError(socket, '04', 'TI');
        return;
      }
      if (!this.routing[levelIndex]) this.routing[levelIndex] = {};
      this.routing[levelIndex][destIndex] = srcIndex;
      changes.push({ level: levelIndex, output: destIndex, input: srcIndex });
    } else {
      // All levels
      for (let level = 0; level < this.levels; level++) {
        if (!this.routing[level]) this.routing[level] = {};
        this.routing[level][destIndex] = srcIndex;
        changes.push({ level, output: destIndex, input: srcIndex });
      }
    }

    if (changes.length > 0) {
      this.emit('routing-changed', changes);
    }

    if (this.echoEnabled) {
      this.sendError(socket, '00', 'TI');
    }
  }

  handleTakeIndexMulti(socket, params) {
    // TJ,dest_index,nbr_sources,src_name_entry1,...,src_name_entryn
    // src_name_entry: src_index,level_bitmap
    if (params.length < 3) {
      this.sendError(socket, '09', 'TJ');
      return;
    }

    const destIndex = parseInt(params[0], 16);
    const nbrSources = parseInt(params[1], 16);

    if (destIndex < 0 || destIndex >= this.outputs) {
      this.sendError(socket, '02', 'TJ');
      return;
    }

    const changes = [];
    let paramIndex = 2;

    for (let i = 0; i < nbrSources && paramIndex + 1 < params.length; i++) {
      const srcIndex = parseInt(params[paramIndex++], 16);
      const levelBitmap = params[paramIndex++];

      if (srcIndex < 0 || srcIndex >= this.inputs) {
        this.sendError(socket, '03', 'TJ');
        return;
      }

      const levels = this.parseLevelBitmap(levelBitmap);
      for (const level of levels) {
        if (level < this.levels) {
          if (!this.routing[level]) this.routing[level] = {};
          this.routing[level][destIndex] = srcIndex;
          changes.push({ level, output: destIndex, input: srcIndex });
        }
      }
    }

    if (changes.length > 0) {
      this.emit('routing-changed', changes);
    }

    if (this.echoEnabled) {
      this.sendError(socket, '00', 'TJ');
    }
  }

  handleBackground(socket, params) {
    // BK[,parameter[,value]]
    const param = params[0];

    if (!param) {
      // No params - just a keepalive, no response needed for Ethernet
      return;
    }

    switch (param) {
      case 'N':  // Device name
        socket.write(this.buildMessage('KB', ['N', this.friendlyName]));
        break;
      case 'R':  // Software revision
        socket.write(this.buildMessage('KB', ['R', '1.0.0']));
        break;
      case 'T':  // Software title with version
        socket.write(this.buildMessage('KB', ['T', 'GV Native Simulator 1.0']));
        break;
      case 't':  // Protocol title with version
        socket.write(this.buildMessage('KB', ['t', 'Series 7000 Native Protocol 1.0']));
        break;
      case 'd':  // Device/port name
        socket.write(this.buildMessage('KB', ['d', this.modelName]));
        break;
      case 'I':  // Refresh interval
        const interval = params[1];
        if (interval !== undefined) {
          // Set interval (we don't actually enforce this)
        }
        socket.write(this.buildMessage('KB', ['I', '0']));  // 0 = disabled
        break;
      case 'E':  // Echo on/off
        const echoVal = params[1];
        if (echoVal === 'ON') {
          this.echoEnabled = true;
        } else if (echoVal === 'OFF') {
          this.echoEnabled = false;
        }
        socket.write(this.buildMessage('KB', ['E', this.echoEnabled ? 'ON' : 'OFF']));
        break;
      case 'F':  // Flags
        socket.write(this.buildMessage('KB', ['F', '0000']));  // No changes
        break;
      case 'f':  // Clear flags
        // No action needed
        break;
      case 'D':  // Clear QD flags
        // No action needed
        break;
      case 'A':  // Clear QA flags
        // No action needed
        break;
      case 'P':  // Port configuration
        socket.write(this.buildMessage('KB', [
          'P',
          'PnlLck=OFF',
          'ChopLck=OFF',
          'SlvLck=OFF',
          'ProtOvrd=OFF',
          'MonCtl=OFF',
          `CtlblLvls=${this.toLevelBitmap(this.levels)}`
        ]));
        break;
      default:
        this.sendError(socket, '0A', 'BK');  // Invalid parameter
    }
  }

  handleQueryError(socket, params) {
    // QE,error_code or QE (all errors)
    const errorCode = params[0];

    const errors = {
      '00': 'No error',
      '01': 'MCPU directed response error',
      '02': 'Invalid destination name',
      '03': 'Invalid source name',
      '04': 'Invalid level',
      '09': 'Missing parameter',
      '0A': 'Invalid parameter',
      '0F': 'Unknown command'
    };

    if (errorCode) {
      const desc = errors[errorCode] || 'Unknown error';
      socket.write(this.buildMessage('EQ', [errorCode, desc]));
    } else {
      // Send all errors
      for (const [code, desc] of Object.entries(errors)) {
        socket.write(this.buildMessage('EQ', [code, desc]));
      }
      if (this.echoEnabled) {
        this.sendError(socket, '00', 'QE');
      }
    }
  }

  handleQueryTime(socket) {
    // QT - returns ST,yyyymmddhhmmss
    const now = new Date();
    const timeStr = now.getFullYear().toString() +
      (now.getMonth() + 1).toString().padStart(2, '0') +
      now.getDate().toString().padStart(2, '0') +
      now.getHours().toString().padStart(2, '0') +
      now.getMinutes().toString().padStart(2, '0') +
      now.getSeconds().toString().padStart(2, '0');

    socket.write(this.buildMessage('ST', [timeStr]));
  }

  sendError(socket, errorCode, command) {
    // ER,error_code,command
    socket.write(this.buildMessage('ER', [errorCode, command]));
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
    if (!this.routing[level]) {
      this.routing[level] = {};
    }

    if (output < this.outputs && input < this.inputs) {
      this.routing[level][output] = input;
      this.emit('routing-changed', [{ level, output, input }]);
      return true;
    }
    return false;
  }

  setInputLabel(input, label) {
    if (input >= 0 && input < this.inputs) {
      this.inputLabels[input] = label.substring(0, 8);
      this.emit('input-labels-changed', [{ input, label: this.inputLabels[input] }]);
      return true;
    }
    return false;
  }

  setOutputLabel(output, label) {
    if (output >= 0 && output < this.outputs) {
      this.outputLabels[output] = label.substring(0, 8);
      this.emit('output-labels-changed', [{ output, label: this.outputLabels[output] }]);
      return true;
    }
    return false;
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
      outputLocks: {},
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
    if (config.port !== undefined) this.port = config.port;
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
      if (this.levelNames[level] === undefined) {
        this.levelNames[level] = this.defaultLevelNames[level] || `Level ${level + 1}`;
      }
    }

    for (let i = 0; i < this.inputs; i++) {
      if (this.inputLabels[i] === undefined) {
        this.inputLabels[i] = (this.defaultInputLabels[i] || `Input${String(i + 1).padStart(3, '0')}`).substring(0, 8);
      }
    }
    for (let i = 0; i < this.outputs; i++) {
      if (this.outputLabels[i] === undefined) {
        this.outputLabels[i] = (this.defaultOutputLabels[i] || `Output${String(i + 1).padStart(2, '0')}`).substring(0, 8);
      }
    }
  }
}

module.exports = GVNativeServer;
