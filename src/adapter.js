import crypto from "node:crypto";

const BUILT_IN_TOOL_TYPES = new Set([
  "web_search",
  "web_search_preview",
  "file_search",
  "computer_use",
  "computer_use_preview",
  "code_interpreter",
  "image_generation",
  "mcp"
]);

export class UnsupportedToolError extends Error {
  constructor(type) {
    super(`不支持 Responses 内置工具: ${type}`);
    this.name = "UnsupportedToolError";
    this.statusCode = 400;
  }
}

export function convertResponsesRequest(body, options = {}) {
  const model = mapModel(body.model, options.modelMap);
  const messages = [...(options.previousMessages ?? [])];

  if (body.instructions) {
    messages.push({ role: "system", content: stringifyContent(body.instructions) });
  }

  messages.push(...convertInputToMessages(body.input));

  const chatRequest = copyKnownChatFields(body);
  chatRequest.model = model;
  chatRequest.messages = messages;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    chatRequest.tools = body.tools.map(convertTool);
  }

  if (body.tool_choice) {
    chatRequest.tool_choice = body.tool_choice;
  }

  if (body.stream) {
    chatRequest.stream = true;
    chatRequest.stream_options = { include_usage: true };
  }

  return { chatRequest };
}

export function convertChatCompletionResponse(chatResponse, context = {}) {
  const id = context.id ?? makeId("resp");
  const choice = chatResponse.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const output = [];

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== "function") continue;
      output.push({
        id: makeId("fc"),
        type: "function_call",
        status: "completed",
        call_id: toolCall.id,
        name: toolCall.function?.name ?? "",
        arguments: toolCall.function?.arguments ?? "{}"
      });
    }
  }

  const text = contentToText(message.content);
  if (text) {
    output.push({
      id: makeId("msg"),
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }]
    });
  }

  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: chatResponse.model ?? context.model,
    output,
    output_text: outputText(output),
    usage: convertUsage(chatResponse.usage)
  };
}

export function chatResponseToAssistantMessages(chatResponse) {
  const message = chatResponse.choices?.[0]?.message;
  if (!message) return [];

  const result = {
    role: "assistant",
    content: message.content ?? ""
  };

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    result.tool_calls = message.tool_calls;
  }

  return [result];
}

export function convertChatCompletionChunk(chunk) {
  const choice = chunk.choices?.[0] ?? {};
  const delta = choice.delta ?? {};

  return {
    content: delta.content ?? "",
    toolCalls: delta.tool_calls ?? [],
    finishReason: choice.finish_reason ?? null,
    usage: chunk.usage ?? null
  };
}

export function buildResponsesStreamEvents({ id = makeId("resp"), model, chunks }) {
  let text = "";
  let usage = null;
  const events = [
    {
      event: "response.created",
      data: {
        response: {
          id,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "in_progress",
          model,
          output: [],
          output_text: ""
        }
      }
    }
  ];

  for (const chunk of chunks) {
    if (chunk.usage) usage = chunk.usage;
    if (!chunk.content) continue;

    text += chunk.content;
    events.push({
      event: "response.output_text.delta",
      data: {
        response_id: id,
        output_index: 0,
        content_index: 0,
        delta: chunk.content
      }
    });
  }

  const response = {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model,
    output: text
      ? [
          {
            id: makeId("msg"),
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text, annotations: [] }]
          }
        ]
      : [],
    output_text: text,
    usage: convertUsage(usage)
  };

  events.push({ event: "response.completed", data: { response } });
  return events;
}

export function convertInputToMessages(input) {
  if (input == null) return [];
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [{ role: "user", content: stringifyContent(input) }];

  return input.map((item) => {
    if (item.type === "function_call_output") {
      return {
        role: "tool",
        tool_call_id: item.call_id,
        content: stringifyContent(item.output)
      };
    }

    const role = normalizeRole(item.role);
    const message = { role, content: normalizeContent(item.content) };

    if (item.tool_call_id) message.tool_call_id = item.tool_call_id;
    if (item.name) message.name = item.name;
    if (Array.isArray(item.tool_calls)) message.tool_calls = item.tool_calls;

    return message;
  });
}

export function convertTool(tool) {
  if (BUILT_IN_TOOL_TYPES.has(tool.type)) {
    throw new UnsupportedToolError(tool.type);
  }

  if (tool.type !== "function") {
    throw new UnsupportedToolError(tool.type ?? "unknown");
  }

  if (tool.function) {
    return {
      type: "function",
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters ?? {}
      }
    };
  }

  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? {}
    }
  };
}

function copyKnownChatFields(body) {
  const fields = [
    "temperature",
    "top_p",
    "presence_penalty",
    "frequency_penalty",
    "max_tokens",
    "max_completion_tokens",
    "stop",
    "seed",
    "user",
    "parallel_tool_calls"
  ];
  const result = {};

  for (const field of fields) {
    if (body[field] !== undefined) result[field] = body[field];
  }

  if (body.max_output_tokens !== undefined && result.max_tokens === undefined) {
    result.max_tokens = body.max_output_tokens;
  }

  return result;
}

function normalizeRole(role) {
  if (role === "developer") return "system";
  if (role === "tool") return "tool";
  if (role === "assistant") return "assistant";
  return "user";
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringifyContent(content);

  const blocks = [];
  for (const part of content) {
    if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
      blocks.push({ type: "text", text: part.text ?? "" });
    } else if (part.type === "input_image") {
      blocks.push({
        type: "image_url",
        image_url: { url: part.image_url ?? part.url ?? "" }
      });
    } else {
      blocks.push({ type: "text", text: stringifyContent(part) });
    }
  }

  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => block.text).join("");
  }

  return blocks;
}

function stringifyContent(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function contentToText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringifyContent(content);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return part.text ?? "";
    })
    .join("");
}

function outputText(output) {
  return output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("");
}

function convertUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0
  };
}

function mapModel(model, modelMap = {}) {
  return modelMap[model] ?? model;
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}
