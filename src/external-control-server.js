const http = require('http');
const { URL } = require('url');

class ExternalControlServer {
  constructor(options) {
    this.options = options;
    this.server = null;
    this.clients = new Set();
    this.heartbeatIntervalMs = 15000;
    this.heartbeatTimer = null;
    this.config = {
      enabled: false,
      host: '127.0.0.1',
      port: 9123,
      authToken: ''
    };
  }

  updateConfig(config = {}) {
    this.config = {
      ...this.config,
      ...config
    };
  }

  isRunning() {
    return Boolean(this.server?.listening);
  }

  getListeningPort() {
    const address = this.server?.address?.();
    return typeof address === 'object' && address ? address.port : this.config.port;
  }

  async start(config = {}) {
    this.updateConfig(config);

    if (this.isRunning()) {
      return this.getListeningPort();
    }

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch(err => {
        this.sendJson(res, 500, {
          success: false,
          error: err.message || 'Internal server error'
        });
      });
    });

    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', reject);
        this.startHeartbeat();
        resolve(this.getListeningPort());
      });
    });
  }

  async stop() {
    if (!this.server) {
      return;
    }

    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    this.stopHeartbeat();

    await new Promise((resolve, reject) => {
      this.server.close(err => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    this.server = null;
  }

  publish(event, payload) {
    if (!this.clients.size) {
      return;
    }

    for (const client of [...this.clients]) {
      if (client.destroyed) {
        this.clients.delete(client);
        continue;
      }

      this.writeSseEvent(client, event, payload);
    }
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.clients.size) {
        return;
      }

      this.publish('heartbeat', {
        timestamp: new Date().toISOString()
      });
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeat() {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async handleRequest(req, res) {
    this.setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!this.isAuthorized(req)) {
      this.sendJson(res, 401, { success: false, error: 'Unauthorized' });
      return;
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/health') {
      this.sendJson(res, 200, this.options.getHealth());
      return;
    }

    if (req.method === 'GET' && pathname === '/api/state') {
      this.sendJson(res, 200, {
        success: true,
        data: this.options.getState(url.searchParams.get('target') || 'active')
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/choices') {
      this.sendJson(res, 200, {
        success: true,
        data: this.options.getChoices(url.searchParams.get('target') || 'active')
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/salvos') {
      this.sendJson(res, 200, {
        success: true,
        data: this.options.getSalvos()
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      this.handleEventsRequest(res, url.searchParams.get('target') || 'active');
      return;
    }

    if (req.method === 'POST' && pathname === '/api/route') {
      const body = await this.readJsonBody(req);
      const result = await this.options.setRoute(body);
      this.sendJson(res, 200, {
        success: true,
        data: result
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/salvos/capture') {
      const body = await this.readJsonBody(req);
      const result = await this.options.captureSalvo(body);
      this.sendJson(res, 200, {
        success: result.success !== false,
        data: result
      });
      return;
    }

    const salvoMatch = pathname.match(/^\/api\/salvos\/([^/]+)\/recall$/);
    if (req.method === 'POST' && salvoMatch) {
      const body = await this.readJsonBody(req);
      const salvoId = decodeURIComponent(salvoMatch[1]);
      const result = await this.options.recallSalvo({
        salvoId,
        target: body.target || 'active'
      });
      this.sendJson(res, 200, {
        success: result.success !== false,
        data: result
      });
      return;
    }

    this.sendJson(res, 404, { success: false, error: 'Not found' });
  }

  handleEventsRequest(res, target) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    });
    res.write('\n');
    this.clients.add(res);

    this.writeSseEvent(res, 'health', this.options.getHealth());
    this.writeSseEvent(res, 'state', this.options.getState(target));
    this.writeSseEvent(res, 'choices', this.options.getChoices(target));
    this.writeSseEvent(res, 'salvos', this.options.getSalvos());

    res.on('close', () => {
      this.clients.delete(res);
    });
  }

  writeSseEvent(res, event, payload) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  async readJsonBody(req) {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    if (chunks.length === 0) {
      return {};
    }

    const body = Buffer.concat(chunks).toString('utf8');
    if (!body.trim()) {
      return {};
    }

    try {
      return JSON.parse(body);
    } catch (err) {
      throw new Error('Invalid JSON body');
    }
  }

  isAuthorized(req) {
    if (!this.config.authToken) {
      return true;
    }

    const authHeader = req.headers.authorization || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const headerToken = req.headers['x-auth-token'];
    return bearer === this.config.authToken || headerToken === this.config.authToken;
  }

  setCorsHeaders(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Auth-Token');
  }

  sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload, null, 2));
  }
}

module.exports = ExternalControlServer;