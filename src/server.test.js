import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createServer } from "./server.js";

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
    modelMap: { "codex-model": "upstream-model" }
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

test("streams chat completion chunks as responses SSE events", async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"O"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"K"},"finish_reason":"stop"}]}\n\n');
    res.end("data: [DONE]\n\n");
  });

  await listen(upstream);
  const proxy = createServer({
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}`
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
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}`
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
