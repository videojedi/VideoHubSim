const net = require('net');
const EventEmitter = require('events');

class VideoHubServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 9990;
    this.inputs = options.inputs || 12;
    this.outputs = options.outputs || 12;
    this.modelName = options.modelName || 'Blackmagic Smart Videohub 12x12';
    this.friendlyName = options.friendlyName || 'VideoHub Simulator';
    this.protocolVersion = '2.8';

    // Initialize routing table (output -> input mapping)
    this.routing = {};
    for (let i = 0; i < this.outputs; i++) {
      this.routing[i] = i < this.inputs ? i : 0;
    }

    // Initialize labels with TV station / edit suite example names
    this.defaultInputLabels = [
      'CAM 1', 'CAM 2', 'CAM 3', 'CAM 4',
      'Graphics', 'VTR 1', 'VTR 2', 'Live Feed',
      'Sat Receiver', 'Studio A', 'Studio B', 'Remote 1',
      'Edit 1 Out', 'Edit 2 Out', 'Color Out', 'Audio Booth',
      'Server Ch1', 'Server Ch2', 'Server Ch3', 'Server Ch4'
    ];
    this.defaultOutputLabels = [
      'PGM', 'PVW', 'Multiview 1', 'Multiview 2',
      'TX Main', 'TX Backup', 'Record 1', 'Record 2',
      'Edit 1 In', 'Edit 2 In', 'Color In', 'QC Monitor',
      'Master Ctrl', 'Streaming', 'Confidence', 'Archive',
      'Studio Mon', 'Green Room', 'Lobby', 'Web Encoder'
    ];

    this.inputLabels = {};
    this.outputLabels = {};
    for (let i = 0; i < this.inputs; i++) {
      this.inputLabels[i] = this.defaultInputLabels[i] || `Input ${i + 1}`;
    }
    for (let i = 0; i < this.outputs; i++) {
      this.outputLabels[i] = this.defaultOutputLabels[i] || `Output ${i + 1}`;
    }

    // Initialize locks (U = unlocked, O = owned/locked by client, L = locked by other)
    this.outputLocks = {};
    for (let i = 0; i < this.outputs; i++) {
      this.outputLocks[i] = 'U';
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

    // Send initial status dump
    socket.write(this.getFullStatus());

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      // Process complete blocks (terminated by double newline)
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop(); // Keep incomplete block in buffer

      for (const block of blocks) {
        if (block.trim()) {
          this.processCommand(socket, block.trim(), clientId);
        }
      }
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

  processCommand(socket, block, clientId) {
    const lines = block.split('\n');
    const header = lines[0];

    this.emit('command-received', { clientId, command: block });

    if (header === 'PING:') {
      socket.write('ACK\n\n');
      return;
    }

    if (header === 'VIDEO OUTPUT ROUTING:') {
      const changes = [];
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(' ');
        if (parts.length === 2) {
          const output = parseInt(parts[0], 10);
          const input = parseInt(parts[1], 10);

          if (output >= 0 && output < this.outputs &&
              input >= 0 && input < this.inputs &&
              this.outputLocks[output] !== 'L') {
            this.routing[output] = input;
            changes.push({ output, input });
          }
        }
      }

      if (changes.length > 0) {
        socket.write('ACK\n\n');
        this.broadcastRoutingChange(changes);
        this.emit('routing-changed', changes);
      } else {
        socket.write('NAK\n\n');
      }
      return;
    }

    if (header === 'VIDEO OUTPUT LOCKS:') {
      const changes = [];
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(' ');
        if (parts.length === 2) {
          const output = parseInt(parts[0], 10);
          const lockState = parts[1];

          if (output >= 0 && output < this.outputs &&
              ['O', 'U', 'F'].includes(lockState)) {
            // F = force unlock
            if (lockState === 'F') {
              this.outputLocks[output] = 'U';
            } else {
              this.outputLocks[output] = lockState === 'O' ? 'O' : 'U';
            }
            changes.push({ output, lock: this.outputLocks[output] });
          }
        }
      }

      if (changes.length > 0) {
        socket.write('ACK\n\n');
        this.broadcastLockChange(changes);
        this.emit('locks-changed', changes);
      } else {
        socket.write('NAK\n\n');
      }
      return;
    }

    if (header === 'INPUT LABELS:') {
      const changes = [];
      for (let i = 1; i < lines.length; i++) {
        const match = lines[i].match(/^(\d+)\s+(.*)$/);
        if (match) {
          const input = parseInt(match[1], 10);
          const label = match[2];

          if (input >= 0 && input < this.inputs) {
            this.inputLabels[input] = label;
            changes.push({ input, label });
          }
        }
      }

      if (changes.length > 0) {
        socket.write('ACK\n\n');
        this.broadcastInputLabelChange(changes);
        this.emit('input-labels-changed', changes);
      } else {
        socket.write('NAK\n\n');
      }
      return;
    }

    if (header === 'OUTPUT LABELS:') {
      const changes = [];
      for (let i = 1; i < lines.length; i++) {
        const match = lines[i].match(/^(\d+)\s+(.*)$/);
        if (match) {
          const output = parseInt(match[1], 10);
          const label = match[2];

          if (output >= 0 && output < this.outputs) {
            this.outputLabels[output] = label;
            changes.push({ output, label });
          }
        }
      }

      if (changes.length > 0) {
        socket.write('ACK\n\n');
        this.broadcastOutputLabelChange(changes);
        this.emit('output-labels-changed', changes);
      } else {
        socket.write('NAK\n\n');
      }
      return;
    }

    // Unknown command - ignore as per protocol spec
    this.emit('unknown-command', { clientId, command: block });
  }

  getFullStatus() {
    let status = '';

    // Protocol preamble
    status += 'PROTOCOL PREAMBLE:\n';
    status += `Version: ${this.protocolVersion}\n`;
    status += '\n';

    // Device info
    status += 'VIDEOHUB DEVICE:\n';
    status += 'Device present: true\n';
    status += `Model name: ${this.modelName}\n`;
    status += `Friendly name: ${this.friendlyName}\n`;
    status += 'Unique ID: VIDEOHUB-SIM-001\n';
    status += `Video inputs: ${this.inputs}\n`;
    status += `Video processing units: 0\n`;
    status += `Video outputs: ${this.outputs}\n`;
    status += `Video monitoring outputs: 0\n`;
    status += 'Serial ports: 0\n';
    status += '\n';

    // Input labels
    status += 'INPUT LABELS:\n';
    for (let i = 0; i < this.inputs; i++) {
      status += `${i} ${this.inputLabels[i]}\n`;
    }
    status += '\n';

    // Output labels
    status += 'OUTPUT LABELS:\n';
    for (let i = 0; i < this.outputs; i++) {
      status += `${i} ${this.outputLabels[i]}\n`;
    }
    status += '\n';

    // Video output locks
    status += 'VIDEO OUTPUT LOCKS:\n';
    for (let i = 0; i < this.outputs; i++) {
      status += `${i} ${this.outputLocks[i]}\n`;
    }
    status += '\n';

    // Video output routing
    status += 'VIDEO OUTPUT ROUTING:\n';
    for (let i = 0; i < this.outputs; i++) {
      status += `${i} ${this.routing[i]}\n`;
    }
    status += '\n';

    return status;
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

  broadcastRoutingChange(changes) {
    let message = 'VIDEO OUTPUT ROUTING:\n';
    for (const change of changes) {
      message += `${change.output} ${change.input}\n`;
    }
    message += '\n';
    this.broadcast(message);
  }

  broadcastLockChange(changes) {
    let message = 'VIDEO OUTPUT LOCKS:\n';
    for (const change of changes) {
      message += `${change.output} ${change.lock}\n`;
    }
    message += '\n';
    this.broadcast(message);
  }

  broadcastInputLabelChange(changes) {
    let message = 'INPUT LABELS:\n';
    for (const change of changes) {
      message += `${change.input} ${change.label}\n`;
    }
    message += '\n';
    this.broadcast(message);
  }

  broadcastOutputLabelChange(changes) {
    let message = 'OUTPUT LABELS:\n';
    for (const change of changes) {
      message += `${change.output} ${change.label}\n`;
    }
    message += '\n';
    this.broadcast(message);
  }

  // API methods for UI control
  setRoute(output, input) {
    if (output >= 0 && output < this.outputs &&
        input >= 0 && input < this.inputs) {
      this.routing[output] = input;
      this.broadcastRoutingChange([{ output, input }]);
      this.emit('routing-changed', [{ output, input }]);
      return true;
    }
    return false;
  }

  setInputLabel(input, label) {
    if (input >= 0 && input < this.inputs) {
      this.inputLabels[input] = label;
      this.broadcastInputLabelChange([{ input, label }]);
      this.emit('input-labels-changed', [{ input, label }]);
      return true;
    }
    return false;
  }

  setOutputLabel(output, label) {
    if (output >= 0 && output < this.outputs) {
      this.outputLabels[output] = label;
      this.broadcastOutputLabelChange([{ output, label }]);
      this.emit('output-labels-changed', [{ output, label }]);
      return true;
    }
    return false;
  }

  setLock(output, lock) {
    if (output >= 0 && output < this.outputs && ['O', 'U', 'F'].includes(lock)) {
      const newLockState = lock === 'F' ? 'U' : lock;
      this.outputLocks[output] = newLockState;
      this.broadcastLockChange([{ output, lock: newLockState }]);
      this.emit('locks-changed', [{ output, lock: newLockState }]);
      return true;
    }
    return false;
  }

  getState() {
    return {
      inputs: this.inputs,
      outputs: this.outputs,
      modelName: this.modelName,
      friendlyName: this.friendlyName,
      routing: { ...this.routing },
      inputLabels: { ...this.inputLabels },
      outputLabels: { ...this.outputLabels },
      outputLocks: { ...this.outputLocks },
      clientCount: this.clients.size
    };
  }

  updateConfig(config) {
    if (config.inputs !== undefined) this.inputs = config.inputs;
    if (config.outputs !== undefined) this.outputs = config.outputs;
    if (config.port !== undefined) this.port = config.port;
    if (config.modelName !== undefined) this.modelName = config.modelName;
    if (config.friendlyName !== undefined) this.friendlyName = config.friendlyName;

    // Reinitialize arrays if size changed
    for (let i = 0; i < this.inputs; i++) {
      if (this.inputLabels[i] === undefined) {
        this.inputLabels[i] = this.defaultInputLabels[i] || `Input ${i + 1}`;
      }
    }
    for (let i = 0; i < this.outputs; i++) {
      if (this.outputLabels[i] === undefined) {
        this.outputLabels[i] = this.defaultOutputLabels[i] || `Output ${i + 1}`;
      }
      if (this.routing[i] === undefined) {
        this.routing[i] = i < this.inputs ? i : 0;
      }
      if (this.outputLocks[i] === undefined) {
        this.outputLocks[i] = 'U';
      }
    }
  }
}

module.exports = VideoHubServer;
