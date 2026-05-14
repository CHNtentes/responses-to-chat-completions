import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { reloadConfigFromEnvFile } from './config.js';

export class LogBus {
  #listeners = new Set();
  #history = [];
  #maxEntries = 200;
  #consoleTarget = console;

  setConsole(c) {
    this.#consoleTarget = c;
  }

  publish(level, entry) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, level, entry };
    this.#history.push(logEntry);
    if (this.#history.length > this.#maxEntries) {
      this.#history.shift();
    }

    for (const res of this.#listeners) {
      this.#writeSseEvent(res, logEntry);
    }
  }

  addListener(res) {
    for (const entry of this.#history) {
      this.#writeSseEvent(res, entry);
    }
    this.#listeners.add(res);
  }

  removeListener(res) {
    this.#listeners.delete(res);
  }

  get listenerCount() {
    return this.#listeners.size;
  }

  #writeSseEvent(res, logEntry) {
    if (res.writableEnded) {
      this.#listeners.delete(res);
      return;
    }
    try {
      res.write('event: log\n');
      res.write('data: ' + JSON.stringify(logEntry) + '\n\n');
    } catch {
      this.#listeners.delete(res);
    }
  }

  destroy() {
    this.#listeners.clear();
    this.#history = [];
  }
}

export function createLogBus() {
  return new LogBus();
}

// ---- 管理路由 ----

const SENSITIVE_KEYS = new Set(['UPSTREAM_API_KEY', 'CLIENT_API_KEY']);

function readEnvFile() {
  const paths = ['.env', '.env.example'];
  for (const p of paths) {
    if (existsSync(p)) {
      return readFileSync(p, 'utf8');
    }
  }
  return '';
}

function parseEnvDot(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // 去掉首尾引号
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

function maskSensitive(config) {
  const masked = { ...config };
  for (const key of SENSITIVE_KEYS) {
    if (masked[key]) masked[key] = '******';
  }
  return masked;
}

function writeEnvFile(newConfig) {
  let content = '';
  if (existsSync('.env')) {
    content = readFileSync('.env', 'utf8');
  } else if (existsSync('.env.example')) {
    content = readFileSync('.env.example', 'utf8');
  }

  const lines = content.split(/\r?\n/);
  const updatedKeys = new Set(Object.keys(newConfig));
  const newLines = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      newLines.push(line);
      continue;
    }
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) {
      newLines.push(line);
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    if (updatedKeys.has(key)) {
      newLines.push(key + '=' + String(newConfig[key]));
      updatedKeys.delete(key);
    } else {
      newLines.push(line);
    }
  }

  for (const key of updatedKeys) {
    newLines.push(key + '=' + String(newConfig[key]));
  }

  const result = newLines.join('\n');
  writeFileSync('.env', result, 'utf8');
  return result;
}

export function adminRouter(cfg, logBus) {
  let adminHtml = null;
  const adminHtmlPath = new URL('./admin-ui.html', import.meta.url);

  function getAdminHtml() {
    if (adminHtml) return adminHtml;
    try {
      adminHtml = readFileSync(adminHtmlPath, 'utf8');
    } catch {
      adminHtml = '<html><body><h1>Admin UI not found</h1></body></html>';
    }
    return adminHtml;
  }

  function isAuthorizedByToken(url) {
    if (!cfg.clientApiKey) return true;
    const token = url.searchParams.get('token');
    if (token === cfg.clientApiKey) return true;
    return false;
  }

  function isAuthorizedByHeader(req) {
    if (!cfg.clientApiKey) return true;
    const auth = req.headers.authorization || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match && match[1] === cfg.clientApiKey;
  }

  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/admin') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(getAdminHtml());
      return true;
    }

    if (req.method === 'POST' && pathname === '/admin/verify') {
      return handleVerify(req, res, cfg);
    }

    if (req.method === 'GET' && pathname === '/admin/config') {
      return handleGetConfig(req, res, cfg, url);
    }

    if (req.method === 'POST' && pathname === '/admin/config') {
      return handlePostConfig(req, res, cfg, url);
    }

    if (req.method === 'POST' && pathname === '/admin/restart') {
      return handleRestart(req, res, cfg, url);
    }

    if (req.method === 'GET' && pathname === '/admin/logs/stream') {
      return handleLogsStream(req, res, cfg, logBus, url);
    }

    return false;
  };

  async function readJsonBody(req) {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (!body.trim()) return {};
    return JSON.parse(body);
  }

  function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(payload));
  }

  async function handleVerify(req, res, cfg) {
    try {
      const body = await readJsonBody(req);
      if (body.api_key && body.api_key === cfg.clientApiKey) {
        sendJson(res, 200, { status: 'ok' });
      } else {
        sendJson(res, 401, { error: { message: 'Invalid API key', type: 'unauthorized' } });
      }
    } catch (e) {
      sendJson(res, 400, { error: { message: e.message, type: 'bad_request' } });
    }
    return true;
  }

  async function handleGetConfig(req, res, cfg, url) {
    if (cfg.clientApiKey && !isAuthorizedByToken(url) && !isAuthorizedByHeader(req)) {
      sendJson(res, 401, { error: { message: 'Unauthorized', type: 'unauthorized' } });
      return true;
    }
    try {
      const envText = readEnvFile();
      const parsed = parseEnvDot(envText);
      sendJson(res, 200, { config: maskSensitive(parsed) });
    } catch (e) {
      sendJson(res, 500, { error: { message: e.message, type: 'server_error' } });
    }
    return true;
  }

  async function handlePostConfig(req, res, cfg, url) {
    if (cfg.clientApiKey && !isAuthorizedByToken(url) && !isAuthorizedByHeader(req)) {
      sendJson(res, 401, { error: { message: 'Unauthorized', type: 'unauthorized' } });
      return true;
    }
    try {
      const body = await readJsonBody(req);
      const newConfig = body.config || {};

      writeEnvFile(newConfig);
      const newCfg = reloadConfigFromEnvFile();

      const changes = [];
      const RESTART_KEYS = new Set(['port', 'host', 'historyStoreType', 'historyFilePath', 'historyMaxResponses']);
      const restartRequired = [];
      for (const key of Object.keys(newCfg)) {
        if (key === 'upstreamApiKey' || key === 'clientApiKey') continue;
        if (JSON.stringify(newCfg[key]) !== JSON.stringify(cfg[key])) {
          changes.push(key);
          if (RESTART_KEYS.has(key)) restartRequired.push(key);
        }
      }

      Object.assign(cfg, newCfg);

      sendJson(res, 200, {
        status: 'ok',
        message: restartRequired.length > 0
          ? '\u90e8\u5206\u914d\u7f6e\u9700\u91cd\u542f\u670d\u52a1\u624d\u80fd\u751f\u6548'
          : '\u914d\u7f6e\u5df2\u4fdd\u5b58\u5e76\u70ed\u91cd\u8f7d',
        changed_keys: changes,
        restart_required: restartRequired
      });
    } catch (e) {
      sendJson(res, 500, { error: { message: e.message, type: 'server_error' } });
    }
    return true;
  }

  async function handleRestart(req, res, cfg, url) {
    if (cfg.clientApiKey && !isAuthorizedByToken(url) && !isAuthorizedByHeader(req)) {
      sendJson(res, 401, { error: { message: 'Unauthorized', type: 'unauthorized' } });
      return true;
    }
    // 发送响应后优雅退出
    res.on('finish', () => {
      const server = cfg._server;
      if (server) {
        server.close(() => {
          process.exit(0);
        });
        // 强制超时：5秒后直接退出
        setTimeout(() => process.exit(0), 5000);
      } else {
        process.exit(0);
      }
    });
    sendJson(res, 200, { status: 'ok', message: '服务正在重启...' });
    return true;
  }

  async function handleLogsStream(req, res, cfg, logBus, url) {
    if (cfg.clientApiKey && !isAuthorizedByToken(url)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized', type: 'unauthorized' } }));
      return true;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive'
    });

    res.write('event: connected\n');
    res.write('data: {}\n\n');

    logBus.addListener(res);

    const cleanup = () => logBus.removeListener(res);
    res.on('close', cleanup);
    res.on('error', cleanup);

    return true;
  }
}
