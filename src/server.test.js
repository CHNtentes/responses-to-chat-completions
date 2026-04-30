import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createServer } from "./server.js";

const silentLogger = { log: () => {}, error: () => {} };

test("proxies non-streaming responses requests to chat completions upstream", async () => {
  let capturedRequest;
  const upstream = http.createServer(async (req, res) => {
    capturedRequest = await readJson(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "upstream-model",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })
    );
  });

  await listen(upstream);
  const proxy = createServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    upstreamApiKey: "test-key",
    modelMap: { "codex-model": "upstream-model" },
    logger: silentLogger
  });
  await listen(proxy);

  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "codex-model",
      instructions: "系统",
      input: "你好"
    })
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(capturedRequest.model, "upstream-model");
  assert.deepEqual(capturedRequest.messages, [
    { role: "system", content: "系统" },
    { role: "user", content: "你好" }
  ]);
  assert.equal(payload.output_text, "ok");

  await close(proxy);
  await close(upstream);
});

test("uses a full upstream chat completions URL when configured", async () => {
  let requestedUrl;
  const upstream = http.createServer(async (req, res) => {
    requestedUrl = req.url;
    await readJson(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "m",
        choices: [{ message: { role: "assistant", content: "ok" } }]
      })
    );
  });

  await listen(upstream);
  const proxy = createServer({
    upstreamChatCompletionsUrl: `http://127.0.0.1:${upstream.address().port}/chat/completions`,
    logger: silentLogger
  });
  await listen(proxy);

  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", input: "hi" })
  });

  assert.equal(response.status, 200);
  assert.equal(requestedUrl, "/chat/completions");

  await close(proxy);
  await close(upstream);
});

test("sends upstream requests through a configured HTTP proxy", async () => {
  let proxySawRequest = false;
  const httpProxy = http.createServer(async (req, res) => {
    proxySawRequest = true;
    assert.equal(req.url, "http://example.test/chat/completions");
    await readJson(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "m",
        choices: [{ message: { role: "assistant", content: "proxied" } }]
      })
    );
  });

  await listen(httpProxy);
  const proxy = createServer({
    upstreamChatCompletionsUrl: "http://example.test/chat/completions",
    upstreamProxyUrl: `http://127.0.0.1:${httpProxy.address().port}`,
    logger: silentLogger
  });
  await listen(proxy);

  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", input: "hi" })
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(proxySawRequest, true);
  assert.equal(payload.output_text, "proxied");

  await close(proxy);
  await close(httpProxy);
});

test("streams chat completion chunks as responses SSE events", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"O"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"K"},"finish_reason":"stop"}]}\n\n');
    res.end("data: [DONE]\n\n");
  });

  await listen(upstream);
  const proxy = createServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    logger: silentLogger
  });
  await listen(proxy);

  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", input: "hi", stream: true })
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(text, /event: response.created/);
  assert.match(text, /event: response.output_text.delta/);
  assert.match(text, /"delta":"O"/);
  assert.match(text, /"delta":"K"/);
  assert.match(text, /event: response.completed/);

  await close(proxy);
  await close(upstream);
});

test("can answer streaming responses from a non-streaming upstream request", async () => {
  let upstreamRequest;
  const upstream = http.createServer(async (req, res) => {
    upstreamRequest = await readJson(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "m",
        choices: [{ message: { role: "assistant", content: "buffered" } }]
      })
    );
  });

  await listen(upstream);
  const proxy = createServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    upstreamStreaming: false,
    logger: silentLogger
  });
  await listen(proxy);

  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", input: "hi", stream: true })
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.equal(upstreamRequest.stream, false);
  assert.match(text, /"type":"response.created"/);
  assert.match(text, /event: response.output_item.added/);
  assert.match(text, /"type":"response.output_item.added"/);
  assert.match(text, /event: response.content_part.added/);
  assert.match(text, /event: response.output_text.delta/);
  assert.match(text, /"delta":"buffered"/);
  assert.match(text, /event: response.output_text.done/);
  assert.match(text, /event: response.content_part.done/);
  assert.match(text, /event: response.output_item.done/);
  assert.match(text, /event: response.completed/);
  assert.match(text, /"type":"response.completed"/);
  assert.match(text, /"sequence_number":/);

  await close(proxy);
  await close(upstream);
});

test("can stream function call output items from a non-streaming upstream request", async () => {
  const upstream = http.createServer(async (req, res) => {
    await readJson(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "m",
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "shell", arguments: "{\"cmd\":\"dir\"}" }
                }
              ]
            },
            finish_reason: "tool_calls"
          }
        ]
      })
    );
  });

  await listen(upstream);
  const proxy = createServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    upstreamStreaming: false,
    logger: silentLogger
  });
  await listen(proxy);

  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", input: "list files", stream: true })
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(text, /event: response.output_item.added/);
  assert.match(text, /"type":"function_call"/);
  assert.match(text, /"call_id":"call_1"/);
  assert.match(text, /event: response.output_item.done/);
  assert.match(text, /event: response.completed/);

  await close(proxy);
  await close(upstream);
});

test("returns a gateway error when upstream fetch fails", async () => {
  const logs = [];
  const proxy = createServer({
    upstreamChatCompletionsUrl: "http://127.0.0.1:9/chat/completions",
    logger: { log: (entry) => logs.push(entry), error: (entry) => logs.push(entry) }
  });
  await listen(proxy);

  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", input: "hi" })
  });
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.equal(payload.error.type, "upstream_fetch_failed");
  assert.equal(logs.some((entry) => entry.event === "upstream.fetch.failed"), true);
  assert.equal(logs.find((entry) => entry.event === "upstream.fetch.failed").url, "http://127.0.0.1:9/chat/completions");

  await close(proxy);
});

test("includes nested AggregateError details in gateway errors", async () => {
  const nested = new Error("connect ECONNREFUSED 10.0.0.1:80");
  nested.code = "ECONNREFUSED";
  const error = new AggregateError([nested], "proxy connect failed");
  const logs = [];
  const proxy = createServer({
    upstreamChatCompletionsUrl: "http://example.test/chat/completions",
    upstreamRequester: async () => {
      throw error;
    },
    logger: { log: (entry) => logs.push(entry), error: (entry) => logs.push(entry) }
  });
  await listen(proxy);

  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", input: "hi" })
  });
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.equal(payload.error.detail.errors[0].code, "ECONNREFUSED");
  assert.equal(logs.find((entry) => entry.event === "upstream.fetch.failed").error.errors[0].code, "ECONNREFUSED");

  await close(proxy);
});

test("returns a streaming gateway error event when upstream fetch fails", async () => {
  const proxy = createServer({
    upstreamChatCompletionsUrl: "http://127.0.0.1:9/chat/completions",
    logger: silentLogger
  });
  await listen(proxy);

  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", input: "hi", stream: true })
  });
  const text = await response.text();

  assert.equal(response.status, 502);
  assert.match(text, /upstream_fetch_failed/);

  await close(proxy);
});

test("prepends stored messages when previous_response_id is supplied", async () => {
  const capturedRequests = [];
  const upstream = http.createServer(async (req, res) => {
    capturedRequests.push(await readJson(req));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        model: "m",
        choices: [{ message: { role: "assistant", content: `reply-${capturedRequests.length}` } }]
      })
    );
  });

  await listen(upstream);
  const proxy = createServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    logger: silentLogger
  });
  await listen(proxy);

  const first = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", input: "first" })
  });
  const firstPayload = await first.json();

  await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "m",
      previous_response_id: firstPayload.id,
      input: "second"
    })
  });

  assert.deepEqual(capturedRequests[1].messages, [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply-1" },
    { role: "user", content: "second" }
  ]);

  await close(proxy);
  await close(upstream);
});

test("stores assistant tool calls before later tool output messages", async () => {
  const capturedRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    capturedRequests.push(body);
    res.writeHead(200, { "content-type": "application/json" });

    if (capturedRequests.length === 1) {
      res.end(
        JSON.stringify({
          model: "m",
          choices: [
            {
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "shell", arguments: "{\"cmd\":\"dir\"}" }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ]
        })
      );
      return;
    }

    res.end(
      JSON.stringify({
        model: "m",
        choices: [{ message: { role: "assistant", content: "done" } }]
      })
    );
  });

  await listen(upstream);
  const proxy = createServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    upstreamStreaming: false,
    logger: silentLogger
  });
  await listen(proxy);

  const first = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", input: "list files", stream: true })
  });
  const firstText = await first.text();
  const firstCompleted = parseSseEvent(firstText, "response.completed");

  await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "m",
      previous_response_id: firstCompleted.response.id,
      input: [{ type: "function_call_output", call_id: "call_1", output: "file.txt" }],
      stream: true
    })
  });

  assert.deepEqual(capturedRequests[1].messages, [
    { role: "user", content: "list files" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "shell", arguments: "{\"cmd\":\"dir\"}" }
        }
      ]
    },
    { role: "tool", tool_call_id: "call_1", content: "file.txt" }
  ]);

  await close(proxy);
  await close(upstream);
});

test("restores DeepSeek reasoning_content when Codex sends full function call history in input", async () => {
  const capturedRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const body = await readJson(req);
    capturedRequests.push(body);
    res.writeHead(200, { "content-type": "application/json" });

    if (capturedRequests.length === 1) {
      res.end(
        JSON.stringify({
          model: "m",
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                reasoning_content: "需要先读取目录。",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "shell", arguments: "{\"cmd\":\"dir\"}" }
                  }
                ]
              },
              finish_reason: "tool_calls"
            }
          ]
        })
      );
      return;
    }

    res.end(
      JSON.stringify({
        model: "m",
        choices: [{ message: { role: "assistant", content: "done" } }]
      })
    );
  });

  await listen(upstream);
  const proxy = createServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    upstreamStreaming: false,
    logger: silentLogger
  });
  await listen(proxy);

  await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", input: "list files", stream: true })
  });

  await fetch(`http://127.0.0.1:${proxy.address().port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "m",
      input: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "shell",
          arguments: "{\"cmd\":\"dir\"}"
        },
        { type: "function_call_output", call_id: "call_1", output: "file.txt" }
      ],
      stream: true
    })
  });

  assert.equal(capturedRequests[1].messages[0].reasoning_content, "需要先读取目录。");

  await close(proxy);
  await close(upstream);
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return JSON.parse(body);
}

function parseSseEvent(text, eventName) {
  const frames = text.split("\n\n");
  for (const frame of frames) {
    if (!frame.includes(`event: ${eventName}`)) continue;
    const data = frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice(6);
    if (data) return JSON.parse(data);
  }
  throw new Error(`missing event ${eventName}`);
}
