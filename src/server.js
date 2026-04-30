import http from "node:http";
import { pathToFileURL } from "node:url";

import {
  convertChatCompletionChunk,
  convertChatCompletionResponse,
  convertResponsesRequest,
  chatResponseToAssistantMessages,
  UnsupportedToolError
} from "./adapter.js";
import { loadConfig, resolveChatCompletionsUrl } from "./config.js";
import { requestUpstream } from "./upstream-client.js";

const config = loadConfig();
let nextSequenceNumber = 0;

export function createServer(options = {}) {
  const cfg = { ...config, ...options };
  const logger = cfg.logger ?? console;
  const history = new Map();
  const reasoningContentByToolCallId = new Map();
  cfg.reasoningContentByToolCallId = reasoningContentByToolCallId;

  return http.createServer(async (req, res) => {
    const requestId = makeRequestId();
    try {
      if (req.method === "GET" && req.url === "/health") {
        return sendJson(res, 200, { status: "ok" });
      }

      if (req.method === "GET" && req.url === "/v1/models") {
        return sendJson(res, 200, {
          object: "list",
          data: [{ id: cfg.defaultModel || "chat-completions-model", object: "model" }]
        });
      }

      if (req.method === "POST" && req.url === "/v1/responses") {
        const body = await readJson(req);
        log(logger, "log", {
          event: "responses.request.received",
          request_id: requestId,
          user_agent: req.headers["user-agent"] ?? "",
          accept: req.headers.accept ?? "",
          content_type: req.headers["content-type"] ?? "",
          stream: Boolean(body.stream),
          model: body.model ?? "",
          previous_response_id: body.previous_response_id ?? "",
          input_summary: summarizeResponsesInput(body.input),
          tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
          tool_types: Array.isArray(body.tools) ? body.tools.map((tool) => tool.type) : []
        });
        if (cfg.defaultModel && !body.model) body.model = cfg.defaultModel;
        const previousMessages = body.previous_response_id
          ? (history.get(body.previous_response_id) ?? [])
          : [];
        const { chatRequest } = convertResponsesRequest(body, {
          modelMap: cfg.modelMap,
          previousMessages,
          unsupportedToolPolicy: cfg.unsupportedToolPolicy,
          reasoningContentByToolCallId
        });
        log(logger, "log", {
          event: "chat.request.messages",
          request_id: requestId,
          previous_response_id: body.previous_response_id ?? "",
          previous_messages_found: previousMessages.length,
          summary: summarizeChatMessages(chatRequest.messages)
        });
        logOrphanToolMessages(logger, requestId, chatRequest.messages);

        if (body.stream) {
          if (!cfg.upstreamStreaming) {
            return proxyBufferedStreamingResponse(res, cfg, chatRequest, history, logger, requestId);
          }
          return proxyStreamingResponse(res, cfg, chatRequest, history, logger, requestId);
        }

        return proxyJsonResponse(res, cfg, chatRequest, history, logger, requestId);
      }

      sendJson(res, 404, { error: { message: "Not found", type: "not_found" } });
    } catch (error) {
      const statusCode = error.statusCode ?? 500;
      sendJson(res, statusCode, {
        error: {
          message: error.message,
          type: error instanceof UnsupportedToolError ? "unsupported_tool" : "server_error"
        }
      });
    }
  });
}

async function proxyBufferedStreamingResponse(res, cfg, chatRequest, history, logger, requestId) {
  attachDownstreamLogs(res, logger, requestId, "buffered_stream");
  const upstreamRequest = { ...chatRequest, stream: false };
  delete upstreamRequest.stream_options;

  const upstream = await fetchUpstream(cfg, upstreamRequest, logger, requestId);
  if (upstream.error) {
    return sendUpstreamFetchError(res, upstream.error, upstream.url);
  }

  log(logger, "log", {
    event: "upstream.json.read.start",
    request_id: requestId,
    status: upstream.status
  });
  const payload = await upstream.json().catch((error) => {
    log(logger, "error", {
      event: "upstream.json.read.failed",
      request_id: requestId,
      status: upstream.status,
      error: formatFetchError(error)
    });
    return null;
  });
  log(logger, "log", {
    event: "upstream.json.read.done",
    request_id: requestId,
    ok: Boolean(payload),
    status: upstream.status,
    summary: summarizeChatPayload(payload)
  });
  if (!upstream.ok) {
    return sendJson(res, upstream.status, payload ?? { error: { message: upstream.statusText } });
  }

  const responsePayload = convertChatCompletionResponse(payload, { model: chatRequest.model });
  rememberReasoningContent(payload, cfg.reasoningContentByToolCallId);
  history.set(responsePayload.id, [
    ...chatRequest.messages,
    ...chatResponseToAssistantMessages(payload)
  ]);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });

  writeSse(res, "response.created", {
    response: {
      ...responsePayload,
      status: "in_progress",
      output: [],
      output_text: ""
    }
  });

  const message = responsePayload.output.find((item) => item.type === "message");
  const contentPart = message?.content?.find((part) => part.type === "output_text");
  const functionCalls = responsePayload.output.filter((item) => item.type === "function_call");

  for (const [index, functionCall] of functionCalls.entries()) {
    writeSse(res, "response.output_item.added", {
      response_id: responsePayload.id,
      output_index: index,
      item: { ...functionCall, status: "in_progress" }
    });
    writeSse(res, "response.function_call_arguments.delta", {
      response_id: responsePayload.id,
      item_id: functionCall.id,
      output_index: index,
      delta: functionCall.arguments
    });
    writeSse(res, "response.function_call_arguments.done", {
      response_id: responsePayload.id,
      item_id: functionCall.id,
      output_index: index,
      arguments: functionCall.arguments
    });
    writeSse(res, "response.output_item.done", {
      response_id: responsePayload.id,
      output_index: index,
      item: functionCall
    });
  }

  if (message && contentPart) {
    const outputIndex = functionCalls.length;
    writeSse(res, "response.output_item.added", {
      response_id: responsePayload.id,
      output_index: outputIndex,
      item: {
        id: message.id,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: []
      }
    });
    writeSse(res, "response.content_part.added", {
      response_id: responsePayload.id,
      item_id: message.id,
      output_index: outputIndex,
      content_index: 0,
      part: {
        type: "output_text",
        text: "",
        annotations: []
      }
    });
    writeSse(res, "response.output_text.delta", {
      response_id: responsePayload.id,
      item_id: message.id,
      output_index: outputIndex,
      content_index: 0,
      delta: responsePayload.output_text
    });
    writeSse(res, "response.output_text.done", {
      response_id: responsePayload.id,
      item_id: message.id,
      output_index: outputIndex,
      content_index: 0,
      text: responsePayload.output_text
    });
    writeSse(res, "response.content_part.done", {
      response_id: responsePayload.id,
      item_id: message.id,
      output_index: outputIndex,
      content_index: 0,
      part: contentPart
    });
    writeSse(res, "response.output_item.done", {
      response_id: responsePayload.id,
      output_index: outputIndex,
      item: message
    });
  }

  writeSse(res, "response.completed", { response: responsePayload });
  log(logger, "log", {
    event: "downstream.response.completed.sent",
    request_id: requestId,
    response_id: responsePayload.id,
    output_text_length: responsePayload.output_text.length
  });
  res.end("data: [DONE]\n\n");
}

async function proxyJsonResponse(res, cfg, chatRequest, history, logger, requestId) {
  const upstream = await fetchUpstream(cfg, chatRequest, logger, requestId);
  if (upstream.error) {
    return sendUpstreamFetchError(res, upstream.error, upstream.url);
  }

  log(logger, "log", {
    event: "upstream.json.read.start",
    request_id: requestId,
    status: upstream.status
  });
  const payload = await upstream.json().catch((error) => {
    log(logger, "error", {
      event: "upstream.json.read.failed",
      request_id: requestId,
      status: upstream.status,
      error: formatFetchError(error)
    });
    return null;
  });
  log(logger, "log", {
    event: "upstream.json.read.done",
    request_id: requestId,
    ok: Boolean(payload),
    status: upstream.status,
    summary: summarizeChatPayload(payload)
  });

  if (!upstream.ok) {
    return sendJson(res, upstream.status, payload ?? { error: { message: upstream.statusText } });
  }

  const responsesPayload = convertChatCompletionResponse(payload, { model: chatRequest.model });
  rememberReasoningContent(payload, cfg.reasoningContentByToolCallId);
  history.set(responsesPayload.id, [
    ...chatRequest.messages,
    ...chatResponseToAssistantMessages(payload)
  ]);
  sendJson(res, 200, responsesPayload);
}

async function proxyStreamingResponse(res, cfg, chatRequest, history, logger, requestId) {
  attachDownstreamLogs(res, logger, requestId, "stream");
  const responseId = makeResponseId();
  const upstream = await fetchUpstream(cfg, chatRequest, logger, requestId);
  if (upstream.error) {
    return sendUpstreamFetchError(res, upstream.error, upstream.url);
  }

  if (!upstream.ok) {
    const payload = await upstream.json().catch(() => ({ error: { message: upstream.statusText } }));
    return sendJson(res, upstream.status, payload);
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });

  writeSse(res, "response.created", {
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "in_progress",
      model: chatRequest.model,
      output: [],
      output_text: ""
    }
  });

  let outputText = "";
  let usage = null;

  try {
    for await (const data of readSseData(upstream.body)) {
      if (data === "[DONE]") break;

      const chunk = JSON.parse(data);
      const converted = convertChatCompletionChunk(chunk);
      if (converted.usage) usage = converted.usage;

      if (converted.content) {
        outputText += converted.content;
        writeSse(res, "response.output_text.delta", {
          response_id: responseId,
          output_index: 0,
          content_index: 0,
          delta: converted.content
        });
      }
    }
  } catch (error) {
    log(logger, "error", {
      event: "upstream.stream.parse.failed",
      request_id: requestId,
      response_id: responseId,
      error: formatFetchError(error)
    });
    writeSse(res, "response.failed", {
      response: {
        id: responseId,
        object: "response",
        status: "failed",
        model: chatRequest.model,
        error: {
          message: error.message,
          type: "upstream_stream_parse_failed"
        }
      }
    });
    return res.end("data: [DONE]\n\n");
  }

  writeSse(res, "response.completed", {
    response: {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: chatRequest.model,
      output: outputText
        ? [
            {
              id: `msg_${Date.now()}`,
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: outputText, annotations: [] }]
            }
          ]
        : [],
      output_text: outputText,
      usage: usage
        ? {
            input_tokens: usage.prompt_tokens ?? 0,
            output_tokens: usage.completion_tokens ?? 0,
            total_tokens: usage.total_tokens ?? 0
          }
        : null
    }
  });
  history.set(responseId, [
    ...chatRequest.messages,
    { role: "assistant", content: outputText }
  ]);
  res.end("data: [DONE]\n\n");
}

async function fetchUpstream(cfg, chatRequest, logger, requestId) {
  const url = resolveChatCompletionsUrl(cfg);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cfg.upstreamTimeoutMs);

  log(logger, "log", {
    event: "upstream.fetch.start",
    request_id: requestId,
    url,
    proxy_url: getProxyLogValue(cfg, url),
    model: chatRequest.model,
    stream: Boolean(chatRequest.stream)
  });

  try {
    const requester = cfg.upstreamRequester ?? requestUpstream;
    const response = await requester(url, chatRequest, { ...cfg, signal: controller.signal });
    log(logger, "log", {
      event: "upstream.fetch.done",
      request_id: requestId,
      url,
      proxy_url: getProxyLogValue(cfg, url),
      status: response.status,
      headers: response.headers ?? {},
      duration_ms: Date.now() - startedAt
    });
    return response;
  } catch (error) {
    log(logger, "error", {
      event: "upstream.fetch.failed",
      request_id: requestId,
      url,
      proxy_url: getProxyLogValue(cfg, url),
      duration_ms: Date.now() - startedAt,
      error: formatFetchError(error)
    });
    return { error, url };
  } finally {
    clearTimeout(timeout);
  }
}

function sendUpstreamFetchError(res, error, url) {
  const cause = error.cause;
  const formatted = formatFetchError(error);
  sendJson(res, 502, {
    error: {
      message: "连接上游 Chat Completions 服务失败",
      type: "upstream_fetch_failed",
      detail: {
        url,
        name: formatted.name,
        code: formatted.code ?? cause?.code,
        message: formatted.cause ?? formatted.message,
        errors: formatted.errors
      }
    }
  });
}

function formatFetchError(error) {
  return {
    name: error.name,
    message: error.message,
    code: error.cause?.code,
    cause: error.cause?.message,
    errors: Array.isArray(error.errors)
      ? error.errors.map((nested) => ({
          name: nested.name,
          message: nested.message,
          code: nested.code,
          address: nested.address,
          port: nested.port,
          syscall: nested.syscall
        }))
      : undefined
  };
}

function summarizeChatPayload(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message) return null;
  return {
    finish_reason: payload.choices?.[0]?.finish_reason,
    content_length: typeof message.content === "string" ? message.content.length : 0,
    tool_call_count: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
    tool_call_names: Array.isArray(message.tool_calls)
      ? message.tool_calls.map((toolCall) => toolCall.function?.name).filter(Boolean)
      : []
  };
}

function summarizeResponsesInput(input) {
  if (typeof input === "string") {
    return { kind: "string", length: input.length };
  }
  if (!Array.isArray(input)) {
    return { kind: input == null ? "empty" : typeof input };
  }
  return {
    kind: "array",
    length: input.length,
    items: input.map((item, index) => ({
      index,
      type: item.type ?? "",
      role: item.role ?? "",
      call_id: item.call_id ?? "",
      content_length: typeof item.content === "string" ? item.content.length : 0
    }))
  };
}

function attachDownstreamLogs(res, logger, requestId, mode) {
  let bytes = 0;
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = (chunk, ...args) => {
    bytes += Buffer.byteLength(chunk);
    return originalWrite(chunk, ...args);
  };

  res.end = (chunk, ...args) => {
    if (chunk) bytes += Buffer.byteLength(chunk);
    log(logger, "log", {
      event: "downstream.response.end.called",
      request_id: requestId,
      mode,
      bytes
    });
    return originalEnd(chunk, ...args);
  };

  res.on("finish", () => {
    log(logger, "log", {
      event: "downstream.response.finish",
      request_id: requestId,
      mode,
      bytes
    });
  });

  res.on("close", () => {
    log(logger, "log", {
      event: "downstream.response.close",
      request_id: requestId,
      mode,
      bytes,
      writable_ended: res.writableEnded
    });
  });

  res.on("error", (error) => {
    log(logger, "error", {
      event: "downstream.response.error",
      request_id: requestId,
      mode,
      error: formatFetchError(error)
    });
  });
}

function rememberReasoningContent(payload, reasoningContentByToolCallId) {
  const message = payload?.choices?.[0]?.message;
  const reasoningContent = message?.reasoning_content;
  if (!reasoningContent || !Array.isArray(message.tool_calls)) return;

  for (const toolCall of message.tool_calls) {
    if (toolCall.id) reasoningContentByToolCallId.set(toolCall.id, reasoningContent);
  }
}

function summarizeChatMessages(messages) {
  return messages.map((message, index) => ({
    index,
    role: message.role,
    content_length: typeof message.content === "string" ? message.content.length : 0,
    tool_call_id: message.tool_call_id,
    tool_call_count: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
    tool_call_ids: Array.isArray(message.tool_calls)
      ? message.tool_calls.map((toolCall) => toolCall.id)
      : []
  }));
}

function logOrphanToolMessages(logger, requestId, messages) {
  const knownToolCallIds = new Set();

  for (const message of messages) {
    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) knownToolCallIds.add(toolCall.id);
    }

    if (message.role === "tool" && !knownToolCallIds.has(message.tool_call_id)) {
      log(logger, "error", {
        event: "chat.request.orphan_tool_message",
        request_id: requestId,
        tool_call_id: message.tool_call_id,
        summary: summarizeChatMessages(messages)
      });
    }
  }
}

function getProxyLogValue(cfg, url) {
  if (cfg.upstreamProxyUrl) return redactProxyCredentials(cfg.upstreamProxyUrl);
  const target = new URL(url);
  const value =
    target.protocol === "https:"
      ? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
      : process.env.HTTP_PROXY ?? process.env.http_proxy;
  return value ? redactProxyCredentials(value) : "";
}

function redactProxyCredentials(value) {
  try {
    const url = new URL(value);
    if (url.username) {
      url.username = "***";
      url.password = url.password ? "***" : "";
    }
    return url.toString();
  } catch {
    return value;
  }
}

function log(logger, level, entry) {
  const target = logger[level] ?? logger.log;
  if (logger === console) {
    target.call(logger, JSON.stringify(entry, null, 2));
    return;
  }
  target.call(logger, entry);
}

async function* readSseData(stream) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) yield line.slice(5).trimStart();
      }
    }
  }
}

function writeSse(res, event, data) {
  const payload =
    data && typeof data === "object" && !Array.isArray(data)
      ? { type: event, sequence_number: nextSequenceNumber++, ...data }
      : data;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function makeResponseId() {
  return `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function makeRequestId() {
  return `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer().listen(config.port, config.host, () => {
    console.log(`Responses proxy listening on http://${config.host}:${config.port}`);
    console.log(`Upstream chat completions: ${resolveChatCompletionsUrl(config)}`);
    console.log(`Upstream proxy: ${getProxyLogValue(config, resolveChatCompletionsUrl(config)) || "(none)"}`);
  });
}
