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
  const previousMessages = options.previousMessages ?? [];
  const currentMessages = [];

  if (body.instructions) {
    currentMessages.push({ role: "system", content: stringifyContent(body.instructions) });
  }

  currentMessages.push(...convertInputToMessages(body.input, options));

  const previousMessagesStartIndex = findToolCallNormalizationStartIndex(previousMessages);
  const messages = [
    ...previousMessages.slice(0, previousMessagesStartIndex),
    ...normalizeToolCallTurns([
      ...previousMessages.slice(previousMessagesStartIndex),
      ...currentMessages
    ])
  ];

  const chatRequest = copyKnownChatFields(body);
  chatRequest.model = model;
  chatRequest.messages = messages;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools = body.tools
      .map((tool) => convertTool(tool, options))
      .filter(Boolean);
    if (tools.length > 0) chatRequest.tools = tools;
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

  if (message.reasoning_content) {
    result.reasoning_content = message.reasoning_content;
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

export function createToolCallAccumulator() {
  const toolCallsByIndex = new Map();

  return {
    addDelta(toolCallDeltas = []) {
      const changes = [];

      for (const delta of toolCallDeltas) {
        const index = delta.index ?? toolCallsByIndex.size;
        let toolCall = toolCallsByIndex.get(index);
        const started = !toolCall;

        if (!toolCall) {
          toolCall = {
            id: delta.id ?? `call_${index}`,
            type: delta.type ?? "function",
            function: {
              name: "",
              arguments: ""
            }
          };
          toolCallsByIndex.set(index, toolCall);
        }

        if (delta.id) toolCall.id = delta.id;
        if (delta.type) toolCall.type = delta.type;
        if (delta.function?.name) toolCall.function.name += delta.function.name;

        const argumentsDelta = delta.function?.arguments ?? "";
        if (argumentsDelta) toolCall.function.arguments += argumentsDelta;

        changes.push({
          index,
          started,
          toolCall: cloneToolCall(toolCall),
          argumentsDelta
        });
      }

      return changes;
    },

    completedToolCalls() {
      return [...toolCallsByIndex.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, toolCall]) => cloneToolCall(toolCall));
    }
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

export function convertInputToMessages(input, options = {}) {
  if (input == null) return [];
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [{ role: "user", content: stringifyContent(input) }];

  const messages = [];
  let pendingToolCalls = [];

  const flushToolCalls = () => {
    if (pendingToolCalls.length === 0) return;
    const message = {
      role: "assistant",
      content: "",
      tool_calls: pendingToolCalls
    };
    const reasoningContent = findReasoningContentForToolCalls(
      pendingToolCalls,
      options.reasoningContentByToolCallId
    );
    if (reasoningContent) message.reasoning_content = reasoningContent;
    messages.push(message);
    pendingToolCalls = [];
  };

  for (const item of input) {
    if (item.type === "function_call") {
      pendingToolCalls.push({
        id: item.call_id ?? item.id,
        type: "function",
        function: {
          name: item.name ?? "",
          arguments: item.arguments ?? "{}"
        }
      });
      continue;
    }

    flushToolCalls();

    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: stringifyContent(item.output)
      });
      continue;
    }

    const role = normalizeRole(item.role);
    const message = { role, content: normalizeContent(item.content) };

    if (item.tool_call_id) message.tool_call_id = item.tool_call_id;
    if (item.name) message.name = item.name;
    if (Array.isArray(item.tool_calls)) message.tool_calls = item.tool_calls;

    messages.push(message);
  }

  flushToolCalls();
  return messages;
}

function normalizeToolCallTurns(messages) {
  const result = [];
  const consumed = new Set();

  for (let index = 0; index < messages.length; index += 1) {
    if (consumed.has(index)) continue;

    const message = messages[index];
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      if (message.role !== "tool") result.push(message);
      continue;
    }

    const toolCallIds = new Set(message.tool_calls.map((toolCall) => toolCall.id).filter(Boolean));
    const matchingToolMessagesById = new Map();

    for (let nextIndex = index + 1; nextIndex < messages.length; nextIndex += 1) {
      const nextMessage = messages[nextIndex];
      if (consumed.has(nextIndex)) continue;
      if (nextMessage.role !== "tool") continue;
      if (!toolCallIds.has(nextMessage.tool_call_id)) continue;
      if (matchingToolMessagesById.has(nextMessage.tool_call_id)) continue;

      matchingToolMessagesById.set(nextMessage.tool_call_id, nextMessage);
      consumed.add(nextIndex);
    }

    const matchedToolCalls = message.tool_calls.filter((toolCall) =>
      matchingToolMessagesById.has(toolCall.id)
    );

    if (matchedToolCalls.length > 0) {
      result.push({ ...message, tool_calls: matchedToolCalls });
      for (const toolCall of matchedToolCalls) {
        result.push(matchingToolMessagesById.get(toolCall.id));
      }
      continue;
    }

    if (message.content) {
      const { tool_calls: _toolCalls, ...messageWithoutToolCalls } = message;
      result.push(messageWithoutToolCalls);
    }
  }

  return result;
}

function findToolCallNormalizationStartIndex(messages) {
  if (messages.length === 0) return 0;

  const lastMessage = messages[messages.length - 1];
  if (
    lastMessage.role === "assistant" &&
    Array.isArray(lastMessage.tool_calls) &&
    lastMessage.tool_calls.length > 0
  ) {
    return messages.length - 1;
  }

  return messages.length;
}

function findReasoningContentForToolCalls(toolCalls, reasoningContentByToolCallId) {
  if (!reasoningContentByToolCallId) return "";

  for (const toolCall of toolCalls) {
    const value = reasoningContentByToolCallId.get?.(toolCall.id);
    if (value) return value;
  }

  return "";
}

export function convertTool(tool, options = {}) {
  if (BUILT_IN_TOOL_TYPES.has(tool.type)) {
    if (options.unsupportedToolPolicy === "error") {
      throw new UnsupportedToolError(tool.type);
    }
    return null;
  }

  if (tool.type !== "function") {
    if (options.unsupportedToolPolicy === "ignore") return null;
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
      const url = normalizeImageUrl(part);
      if (url) {
        blocks.push({
          type: "image_url",
          image_url: { url }
        });
      } else {
        blocks.push({ type: "text", text: stringifyContent(part) });
      }
    } else {
      blocks.push({ type: "text", text: stringifyContent(part) });
    }
  }

  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => block.text).join("");
  }

  return blocks;
}

function normalizeImageUrl(part) {
  if (typeof part.image_url === "string") return part.image_url;
  if (typeof part.image_url?.url === "string") return part.image_url.url;
  if (typeof part.url === "string") return part.url;
  return "";
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

function cloneToolCall(toolCall) {
  return {
    id: toolCall.id,
    type: toolCall.type,
    function: {
      name: toolCall.function?.name ?? "",
      arguments: toolCall.function?.arguments ?? ""
    }
  };
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
