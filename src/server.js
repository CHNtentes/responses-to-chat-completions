import http from "node:http";
import { pathToFileURL } from "node:url";

import {
  convertChatCompletionChunk,
  convertChatCompletionResponse,
  convertResponsesRequest,
  chatResponseToAssistantMessages,
  UnsupportedToolError
} from "./adapter.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

export function createServer(options = {}) {
  const cfg = { ...config, ...options };
  const history = new Map();

  return http.createServer(async (req, res) => {
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
        if (cfg.defaultModel && !body.model) body.model = cfg.defaultModel;
        const previousMessages = body.previous_response_id
          ? (history.get(body.previous_response_id) ?? [])
          : [];
        const { chatRequest } = convertResponsesRequest(body, {
          modelMap: cfg.modelMap,
          previousMessages
        });

        if (body.stream) {
          return proxyStreamingResponse(res, cfg, chatRequest, history);
        }

        return proxyJsonResponse(res, cfg, chatRequest, history);
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

async function proxyJsonResponse(res, cfg, chatRequest, history) {
  const upstream = await fetch(`${cfg.upstreamBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: upstreamHeaders(cfg),
    body: JSON.stringify(chatRequest)
  });
  const payload = await upstream.json().catch(() => null);

  if (!upstream.ok) {
    return sendJson(res, upstream.status, payload ?? { error: { message: upstream.statusText } });
  }

  const responsesPayload = convertChatCompletionResponse(payload, { model: chatRequest.model });
  history.set(responsesPayload.id, [
    ...chatRequest.messages,
    ...chatResponseToAssistantMessages(payload)
  ]);
  sendJson(res, 200, responsesPayload);
}

async function proxyStreamingResponse(res, cfg, chatRequest, history) {
  const responseId = makeResponseId();
  const upstream = await fetch(`${cfg.upstreamBaseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: upstreamHeaders(cfg),
    body: JSON.stringify(chatRequest)
  });

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

function upstreamHeaders(cfg) {
  const headers = { "content-type": "application/json" };
  if (cfg.upstreamApiKey) headers.authorization = `Bearer ${cfg.upstreamApiKey}`;
  return headers;
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  createServer().listen(config.port, () => {
    console.log(`Responses proxy listening on http://127.0.0.1:${config.port}`);
    console.log(`Upstream chat completions: ${config.upstreamBaseUrl}/v1/chat/completions`);
  });
}
