import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResponsesStreamEvents,
  chatResponseToAssistantMessages,
  convertChatCompletionChunk,
  convertChatCompletionResponse,
  convertResponsesRequest,
  UnsupportedToolError
} from "./adapter.js";

test("converts instructions and string input to chat messages", () => {
  const result = convertResponsesRequest({
    model: "codex-model",
    instructions: "你是一个编码助手",
    input: "列出文件",
    temperature: 0.2
  });

  assert.deepEqual(result.chatRequest.messages, [
    { role: "system", content: "你是一个编码助手" },
    { role: "user", content: "列出文件" }
  ]);
  assert.equal(result.chatRequest.model, "codex-model");
  assert.equal(result.chatRequest.temperature, 0.2);
});

test("converts response message input and function output to chat messages", () => {
  const result = convertResponsesRequest({
    model: "m",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "运行命令" }]
      },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: "ok"
      }
    ]
  });

  assert.deepEqual(result.chatRequest.messages, [
    { role: "user", content: "运行命令" },
    { role: "tool", tool_call_id: "call_1", content: "ok" }
  ]);
});

test("converts responses function_call items before tool outputs", () => {
  const result = convertResponsesRequest({
    model: "m",
    input: [
      {
        type: "function_call",
        call_id: "call_00",
        name: "shell",
        arguments: "{\"cmd\":\"dir\"}"
      },
      {
        type: "function_call",
        call_id: "call_01",
        name: "read_file",
        arguments: "{\"path\":\"README.md\"}"
      },
      {
        type: "function_call_output",
        call_id: "call_00",
        output: "listing"
      },
      {
        type: "function_call_output",
        call_id: "call_01",
        output: "content"
      }
    ]
  });

  assert.deepEqual(result.chatRequest.messages, [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_00",
          type: "function",
          function: { name: "shell", arguments: "{\"cmd\":\"dir\"}" }
        },
        {
          id: "call_01",
          type: "function",
          function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" }
        }
      ]
    },
    { role: "tool", tool_call_id: "call_00", content: "listing" },
    { role: "tool", tool_call_id: "call_01", content: "content" }
  ]);
});

test("restores reasoning_content for responses function_call history", () => {
  const result = convertResponsesRequest(
    {
      model: "m",
      input: [
        {
          type: "function_call",
          call_id: "call_00",
          name: "shell",
          arguments: "{\"cmd\":\"dir\"}"
        },
        {
          type: "function_call_output",
          call_id: "call_00",
          output: "listing"
        }
      ]
    },
    {
      reasoningContentByToolCallId: new Map([["call_00", "我需要先查看目录。"]])
    }
  );

  assert.equal(result.chatRequest.messages[0].reasoning_content, "我需要先查看目录。");
});

test("preserves reasoning_content from chat responses in assistant history", () => {
  const messages = chatResponseToAssistantMessages({
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          reasoning_content: "我需要调用工具。",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "shell", arguments: "{\"cmd\":\"dir\"}" }
            }
          ]
        }
      }
    ]
  });

  assert.equal(messages[0].reasoning_content, "我需要调用工具。");
});

test("converts function tools and ignores built in tools by default", () => {
  const result = convertResponsesRequest({
    model: "m",
    input: "hi",
    tools: [
      {
        type: "function",
        name: "shell",
        description: "运行 shell",
        parameters: { type: "object", properties: {} }
      }
    ]
  });

  assert.deepEqual(result.chatRequest.tools, [
    {
      type: "function",
      function: {
        name: "shell",
        description: "运行 shell",
        parameters: { type: "object", properties: {} }
      }
    }
  ]);

  const ignored = convertResponsesRequest({
    model: "m",
    input: "hi",
    tools: [{ type: "web_search" }]
  });

  assert.equal(ignored.chatRequest.tools, undefined);
});

test("rejects built in tools in strict mode", () => {
  assert.throws(
    () =>
      convertResponsesRequest(
        {
          model: "m",
          input: "hi",
          tools: [{ type: "web_search" }]
        },
        { unsupportedToolPolicy: "error" }
      ),
    UnsupportedToolError
  );
});

test("wraps a chat completion response as a responses object", () => {
  const response = convertChatCompletionResponse(
    {
      id: "chatcmpl_1",
      model: "m",
      choices: [
        {
          message: {
            role: "assistant",
            content: "完成"
          },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5
      }
    },
    { model: "m" }
  );

  assert.equal(response.object, "response");
  assert.equal(response.status, "completed");
  assert.equal(response.output_text, "完成");
  assert.deepEqual(response.output[0].content[0], {
    type: "output_text",
    text: "完成",
    annotations: []
  });
  assert.deepEqual(response.usage, {
    input_tokens: 3,
    output_tokens: 2,
    total_tokens: 5
  });
});

test("wraps assistant tool calls as function_call output items", () => {
  const response = convertChatCompletionResponse(
    {
      model: "m",
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "shell",
                  arguments: "{\"cmd\":\"pwd\"}"
                }
              }
            ]
          },
          finish_reason: "tool_calls"
        }
      ]
    },
    { model: "m" }
  );

  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.output[0].call_id, "call_1");
  assert.equal(response.output[0].name, "shell");
  assert.equal(response.output[0].arguments, "{\"cmd\":\"pwd\"}");
});

test("converts chat stream chunks to responses text deltas", () => {
  const events = buildResponsesStreamEvents({
    id: "resp_1",
    model: "m",
    chunks: [
      convertChatCompletionChunk({
        choices: [{ delta: { content: "你" } }]
      }),
      convertChatCompletionChunk({
        choices: [{ delta: { content: "好" }, finish_reason: "stop" }]
      })
    ]
  });

  assert.equal(events[0].event, "response.created");
  assert.equal(events[1].event, "response.output_text.delta");
  assert.equal(events[1].data.delta, "你");
  assert.equal(events[2].data.delta, "好");
  assert.equal(events.at(-1).event, "response.completed");
  assert.equal(events.at(-1).data.response.output_text, "你好");
});
