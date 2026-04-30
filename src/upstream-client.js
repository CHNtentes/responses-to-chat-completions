import http from "node:http";
import { PassThrough, Transform } from "node:stream";
import tls from "node:tls";

export async function requestUpstream(url, chatRequest, cfg) {
  const proxyUrl = resolveProxyUrl(cfg, url);
  if (!proxyUrl) {
    return fetch(url, {
      method: "POST",
      headers: upstreamHeaders(cfg),
      body: JSON.stringify(chatRequest),
      signal: cfg.signal
    });
  }

  return requestViaProxy(url, proxyUrl, chatRequest, cfg);
}

function resolveProxyUrl(cfg, targetUrl) {
  if (shouldBypassProxy(targetUrl, cfg.noProxy)) return "";
  if (cfg.upstreamProxyUrl) return cfg.upstreamProxyUrl;

  const target = new URL(targetUrl);
  if (target.protocol === "https:") {
    return process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? "";
  }

  return process.env.HTTP_PROXY ?? process.env.http_proxy ?? "";
}

function shouldBypassProxy(targetUrl, configuredNoProxy = "") {
  const target = new URL(targetUrl);
  const hostname = target.hostname.toLowerCase();
  const noProxy = [
    configuredNoProxy,
    process.env.NO_PROXY,
    process.env.no_proxy,
    "localhost,127.0.0.1,::1"
  ]
    .filter(Boolean)
    .join(",");

  return noProxy
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === "*") return true;
      if (entry === hostname) return true;
      if (entry.startsWith(".")) return hostname.endsWith(entry);
      return hostname.endsWith(`.${entry}`);
    });
}

async function requestViaProxy(targetUrl, proxyUrl, chatRequest, cfg) {
  const target = new URL(targetUrl);
  const proxy = new URL(proxyUrl);
  const body = JSON.stringify(chatRequest);

  if (target.protocol === "http:") {
    return requestHttpThroughProxy(target, proxy, body, cfg);
  }

  if (target.protocol === "https:") {
    return requestHttpsThroughProxy(target, proxy, body, cfg);
  }

  throw new Error(`不支持的上游协议: ${target.protocol}`);
}

function requestHttpThroughProxy(target, proxy, body, cfg) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: proxy.hostname,
        port: proxy.port || 80,
        method: "POST",
        path: target.href,
        headers: {
          ...upstreamHeaders(cfg),
          ...proxyAuthorizationHeader(proxy),
          "content-length": Buffer.byteLength(body)
        },
        signal: cfg.signal
      },
      (res) => resolve(wrapNodeResponse(res))
    );

    req.on("error", reject);
    req.end(body);
  });
}

function requestHttpsThroughProxy(target, proxy, body, cfg) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const connectReq = http.request({
      hostname: proxy.hostname,
      port: proxy.port || 80,
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      headers: proxyAuthorizationHeader(proxy),
      signal: cfg.signal
    });

    connectReq.once("connect", (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败: HTTP ${res.statusCode}`));
        return;
      }

      if (head.length > 0) socket.unshift(head);

      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
        rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0"
      });

      tlsSocket.once("secureConnect", () => {
        writeHttpRequestToTlsSocket(tlsSocket, target, body, cfg);
      });

      let buffer = Buffer.alloc(0);
      const bodyStream = new PassThrough();

      tlsSocket.on("data", (chunk) => {
        if (settled) {
          bodyStream.write(chunk);
          return;
        }

        buffer = Buffer.concat([buffer, chunk]);
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const rawHeaders = buffer.slice(0, headerEnd).toString("latin1");
        const rest = buffer.slice(headerEnd + 4);
        logDebug(cfg, {
          event: "upstream.raw.headers",
          status_line: rawHeaders.split("\r\n")[0],
          headers: rawHeaders.split("\r\n").slice(1)
        });
        const response = parseRawHttpResponse(rawHeaders, bodyStream, cfg);
        settled = true;
        resolve(response);
        if (rest.length > 0) bodyStream.write(rest);
      });

      tlsSocket.once("end", () => bodyStream.end());
      tlsSocket.once("close", () => bodyStream.end());
      tlsSocket.once("error", (error) => {
        bodyStream.destroy(error);
        if (!settled) reject(error);
      });
    });

    connectReq.once("error", reject);
    connectReq.end();
  });
}

function writeHttpRequestToTlsSocket(socket, target, body, cfg) {
  const headers = {
    host: target.host,
    ...upstreamHeaders(cfg),
    accept: "application/json",
    connection: "close",
    "content-length": Buffer.byteLength(body)
  };
  const headerLines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  socket.write(`POST ${target.pathname}${target.search} HTTP/1.1\r\n`);
  socket.write(`${headerLines.join("\r\n")}\r\n\r\n`);
  socket.write(body);
}

function parseRawHttpResponse(rawHeaders, body, cfg = {}) {
  const [statusLine, ...headerLines] = rawHeaders.split("\r\n");
  const [, statusCodeText, ...statusTextParts] = statusLine.split(" ");
  const status = Number(statusCodeText);
  const headers = {};

  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  }

  const decodedBody = decodeResponseBody(body, headers, cfg);

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: statusTextParts.join(" "),
    headers,
    body: decodedBody,
    async json() {
      const text = await this.text();
      return JSON.parse(text);
    },
    async text() {
      let content = "";
      for await (const chunk of decodedBody) content += chunk;
      return content;
    }
  };
}

function decodeResponseBody(body, headers, cfg = {}) {
  if (headers["transfer-encoding"]?.toLowerCase().includes("chunked")) {
    return body.pipe(new ChunkedDecoder(cfg));
  }

  if (headers["content-length"]) {
    return body.pipe(new ContentLengthDecoder(Number(headers["content-length"]), cfg));
  }

  return body;
}

export class ContentLengthDecoder extends Transform {
  constructor(length, cfg = {}) {
    super();
    this.remaining = length;
    this.total = length;
    this.cfg = cfg;
  }

  _transform(chunk, encoding, callback) {
    if (this.remaining <= 0) {
      callback();
      return;
    }

    const slice = chunk.slice(0, this.remaining);
    this.remaining -= slice.length;
    this.push(slice);
    logDebug(this.cfg, {
      event: "upstream.body.content_length.chunk",
      chunk_bytes: chunk.length,
      pushed_bytes: slice.length,
      remaining_bytes: this.remaining,
      total_bytes: this.total
    });

    if (this.remaining === 0) {
      logDebug(this.cfg, {
        event: "upstream.body.content_length.done",
        total_bytes: this.total
      });
      this.push(null);
    }

    callback();
  }
}

export class ChunkedDecoder extends Transform {
  constructor(cfg = {}) {
    super();
    this.buffer = Buffer.alloc(0);
    this.expectedSize = null;
    this.done = false;
    this.cfg = cfg;
  }

  _transform(chunk, encoding, callback) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.processBuffer();
      callback();
    } catch (error) {
      callback(error);
    }
  }

  processBuffer() {
    while (!this.done) {
      if (this.expectedSize == null) {
        const lineEnd = this.buffer.indexOf("\r\n");
        if (lineEnd === -1) return;

        const sizeLine = this.buffer.slice(0, lineEnd).toString("ascii").split(";")[0];
        this.expectedSize = Number.parseInt(sizeLine, 16);
        this.buffer = this.buffer.slice(lineEnd + 2);

        if (this.expectedSize === 0) {
          this.done = true;
          logDebug(this.cfg, {
            event: "upstream.body.chunked.done"
          });
          this.push(null);
          return;
        }
      }

      if (this.buffer.length < this.expectedSize + 2) return;

      this.push(this.buffer.slice(0, this.expectedSize));
      logDebug(this.cfg, {
        event: "upstream.body.chunked.chunk",
        chunk_bytes: this.expectedSize
      });
      this.buffer = this.buffer.slice(this.expectedSize + 2);
      this.expectedSize = null;
    }
  }
}

function logDebug(cfg, entry) {
  if (!cfg.debugUpstreamBody) return;
  const logger = cfg.logger ?? console;
  const target = logger.log ?? console.log;
  target.call(logger, logger === console ? JSON.stringify(entry, null, 2) : entry);
}

function wrapNodeResponse(res) {
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: res.statusMessage,
    body: res,
    async json() {
      const text = await this.text();
      return JSON.parse(text);
    },
    async text() {
      let body = "";
      for await (const chunk of res) body += chunk;
      return body;
    }
  };
}

function upstreamHeaders(cfg) {
  const headers = { "content-type": "application/json" };
  if (cfg.upstreamApiKey) headers.authorization = `Bearer ${cfg.upstreamApiKey}`;
  return headers;
}

function proxyAuthorizationHeader(proxy) {
  if (!proxy.username) return {};

  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return {
    "proxy-authorization": `Basic ${Buffer.from(credentials).toString("base64")}`
  };
}
