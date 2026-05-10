import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { readSseData } from "./sse.js";

test("reads SSE data frames separated by CRLF", async () => {
  const stream = Readable.from([
    Buffer.from('data: {"one":1}\r\n\r\n'),
    Buffer.from('data: {"two":2}\r\n\r\n')
  ]);

  assert.deepEqual(await collect(stream), ['{"one":1}', '{"two":2}']);
});

test("joins multi-line SSE data fields and ignores comments", async () => {
  const stream = Readable.from([
    Buffer.from(': keepalive\r\n'),
    Buffer.from('event: message\r\n'),
    Buffer.from('data: {"text":"hello"\r\n'),
    Buffer.from('data: ,"more":"world"}\r\n\r\n')
  ]);

  assert.deepEqual(await collect(stream), ['{"text":"hello"\n,"more":"world"}']);
});

async function collect(stream) {
  const result = [];
  for await (const data of readSseData(stream)) result.push(data);
  return result;
}
