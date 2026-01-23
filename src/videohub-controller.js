const net = require('net');
const EventEmitter = require('events');

class VideoHubController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 9990;
    this.timeout = options.timeout || 5000;
    this.autoReconnect = options.autoReconnect !== false;
    this.reconnectDelay = 1000;
    this.maxReconnectDelay = 30000;
    this.reconnectAttempts = 0;

    this.socket = null;
    this.connected = false;
    this.connecting = false;
    this.buffer = '';
    this.reconnectTimer = null;

    // Router state
    this.inputs = 0;
    this.outputs = 0;
    this.routing = {};
    this.inputLabels = {};
    this.outputLabels = {};
    this.outputLocks = {};
    this.modelName = '';
    this.friendlyName = '';
    this.uniqueId = '';

    // Track pending route changes for NAK handling
    this.pendingRouteChanges = [];
    this.pendingLockChanges = [];
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
        // Don't emit connected yet - wait for initial data
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

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  handleData(data) {
    this.buffer += data.toString();

    // Process complete blocks (terminated by double newline)
    const blocks = this.buffer.split('\n\n');
    this.buffer = blocks.pop(); // Keep incomplete block in buffer

    for (const block of blocks) {
      if (block.trim()) {
        this.processBlock(block.trim());
      }
    }
  }

  processBlock(block) {
    const lines = block.split('\n');
    const header = lines[0];

    if (header === 'PROTOCOL PREAMBLE:') {
      // Protocol version info
    } else if (header === 'VIDEOHUB DEVICE:') {
      this.parseDeviceInfo(lines.slice(1));
    } else if (header === 'INPUT LABELS:') {
      this.parseInputLabels(lines.slice(1));
    } else if (header === 'OUTPUT LABELS:') {
      this.parseOutputLabels(lines.slice(1));
    } else if (header === 'VIDEO OUTPUT ROUTING:') {
      this.parseRouting(lines.slice(1));
    } else if (header === 'VIDEO OUTPUT LOCKS:') {
      this.parseLocks(lines.slice(1));
    } else if (header === 'ACK') {
      // Command acknowledged - clear pending changes
      this.pendingRouteChanges = [];
      this.pendingLockChanges = [];
    } else if (header === 'NAK') {
      // Command rejected - revert any pending changes
      this.revertPendingRouteChanges();
      this.revertPendingLockChanges();
      this.emit('error', 'Command rejected by router');
    }

    // Check if we've received enough data to consider initial state complete
    if (this.inputs > 0 && this.outputs > 0 && Object.keys(this.routing).length > 0) {
      this.emit('initial-state-received');
    }
  }

  parseDeviceInfo(lines) {
    for (const line of lines) {
      const colonPos = line.indexOf(':');
      if (colonPos === -1) continue;

      const key = line.substring(0, colonPos).trim();
      const value = line.substring(colonPos + 1).trim();

      switch (key) {
        case 'Model name':
          this.modelName = value;
          break;
        case 'Friendly name':
          this.friendlyName = value;
          break;
        case 'Unique ID':
          this.uniqueId = value;
          break;
        case 'Video inputs':
          this.inputs = parseInt(value) || 0;
          break;
        case 'Video outputs':
          this.outputs = parseInt(value) || 0;
          break;
      }
    }

    this.emit('state-updated', this.getState());
  }

  parseInputLabels(lines) {
    const changes = [];
    for (const line of lines) {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (match) {
        const index = parseInt(match[1]);
        const label = match[2];
        if (this.inputLabels[index] !== label) {
          this.inputLabels[index] = label;
          changes.push({ index, label });
        }
      }
    }

    if (changes.length > 0) {
      this.emit('input-labels-changed', changes);
    }
  }

  parseOutputLabels(lines) {
    const changes = [];
    for (const line of lines) {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (match) {
        const index = parseInt(match[1]);
        const label = match[2];
        if (this.outputLabels[index] !== label) {
          this.outputLabels[index] = label;
          changes.push({ index, label });
        }
      }
    }

    if (changes.length > 0) {
      this.emit('output-labels-changed', changes);
    }
  }

  parseRouting(lines) {
    const changes = [];
    for (const line of lines) {
      const match = line.match(/^(\d+)\s+(\d+)$/);
      if (match) {
        const output = parseInt(match[1]);
        const input = parseInt(match[2]);

        // Clear any pending changes for this output since router confirmed state
        this.pendingRouteChanges = this.pendingRouteChanges.filter(p => p.output !== output);

        if (this.routing[output] !== input) {
          this.routing[output] = input;
          changes.push({ output, input });
        }
      }
    }

    if (changes.length > 0) {
      this.emit('routing-changed', changes);
    }
  }

  parseLocks(lines) {
    const changes = [];
    for (const line of lines) {
      const match = line.match(/^(\d+)\s+(\S+)$/);
      if (match) {
        const output = parseInt(match[1]);
        const lock = match[2];

        // Clear any pending lock changes for this output since router confirmed state
        this.pendingLockChanges = this.pendingLockChanges.filter(p => p.output !== output);

        if (this.outputLocks[output] !== lock) {
          this.outputLocks[output] = lock;
          changes.push({ output, lock });
        }
      }
    }

    if (changes.length > 0) {
      this.emit('locks-changed', changes);
    }
  }

  getState() {
    return {
      inputs: this.inputs,
      outputs: this.outputs,
      routing: { ...this.routing },
      inputLabels: { ...this.inputLabels },
      outputLabels: { ...this.outputLabels },
      outputLocks: { ...this.outputLocks },
      modelName: this.modelName,
      friendlyName: this.friendlyName
    };
  }

  async setRoute(output, input, level = 0) {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    const command = `VIDEO OUTPUT ROUTING:\n${output} ${input}\n\n`;

    // Track the old value before optimistic update
    const oldInput = this.routing[output];
    if (oldInput !== input) {
      // Store pending change for potential rollback on NAK
      this.pendingRouteChanges.push({ output, oldInput, newInput: input });

      // Optimistically update local state
      this.routing[output] = input;
      this.emit('routing-changed', [{ output, input }]);
    }

    this.socket.write(command);
    return true;
  }

  revertPendingRouteChanges() {
    if (this.pendingRouteChanges.length === 0) {
      return;
    }

    const changes = [];
    for (const pending of this.pendingRouteChanges) {
      // Revert to the old input value
      if (pending.oldInput !== undefined) {
        this.routing[pending.output] = pending.oldInput;
        changes.push({ output: pending.output, input: pending.oldInput });
      }
    }

    // Clear pending changes
    this.pendingRouteChanges = [];

    // Emit routing changed event to update UI with reverted values
    if (changes.length > 0) {
      this.emit('routing-changed', changes);
    }
  }

  revertPendingLockChanges() {
    if (this.pendingLockChanges.length === 0) {
      return;
    }

    const changes = [];
    for (const pending of this.pendingLockChanges) {
      // Revert to the old lock value
      if (pending.oldLock !== undefined) {
        this.outputLocks[pending.output] = pending.oldLock;
        changes.push({ output: pending.output, lock: pending.oldLock });
      }
    }

    // Clear pending changes
    this.pendingLockChanges = [];

    // Emit locks changed event to update UI with reverted values
    if (changes.length > 0) {
      this.emit('locks-changed', changes);
    }
  }

  async setLock(output, lock) {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    // Valid lock states: O = owned/locked, U = unlocked, F = force unlock
    // Note: L (locked by other) is receive-only, cannot be sent
    if (!['O', 'U', 'F'].includes(lock)) {
      throw new Error('Invalid lock state. Use O (lock), U (unlock), or F (force unlock)');
    }

    const command = `VIDEO OUTPUT LOCKS:\n${output} ${lock}\n\n`;

    // Track the old value before optimistic update
    const oldLock = this.outputLocks[output];
    // F (force unlock) results in U (unlocked) state
    const newLockState = lock === 'F' ? 'U' : lock;

    if (oldLock !== newLockState) {
      // Store pending change for potential rollback on NAK
      this.pendingLockChanges.push({ output, oldLock, newLock: newLockState });

      // Optimistically update local state
      this.outputLocks[output] = newLockState;
      this.emit('locks-changed', [{ output, lock: newLockState }]);
    }

    this.socket.write(command);
    return true;
  }

  async setInputLabel(index, label) {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    const command = `INPUT LABELS:\n${index} ${label}\n\n`;
    this.socket.write(command);

    // Optimistically update local state
    if (this.inputLabels[index] !== label) {
      this.inputLabels[index] = label;
      this.emit('input-labels-changed', [{ index, label }]);
    }

    return true;
  }

  async setOutputLabel(index, label) {
    if (!this.connected) {
      throw new Error('Not connected');
    }

    const command = `OUTPUT LABELS:\n${index} ${label}\n\n`;
    this.socket.write(command);

    // Optimistically update local state
    if (this.outputLabels[index] !== label) {
      this.outputLabels[index] = label;
      this.emit('output-labels-changed', [{ index, label }]);
    }

    return true;
  }

  // For API compatibility with multi-level protocols
  getRoutingForLevel(level) {
    return this.routing;
  }

  setLevelName(level, name) {
    // VideoHub doesn't support levels
    return false;
  }

  // Lock helper methods
  getLock(output) {
    return this.outputLocks[output] || 'U';
  }

  isLocked(output) {
    const lock = this.outputLocks[output];
    return lock === 'O' || lock === 'L';
  }

  getAllLocks() {
    return { ...this.outputLocks };
  }
}

module.exports = VideoHubController;
