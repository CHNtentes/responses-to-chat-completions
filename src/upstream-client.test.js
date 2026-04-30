import assert from "node:assert/strict";
import test from "node:test";

import { ChunkedDecoder, ContentLengthDecoder } from "./upstream-client.js";

test("chunked decoder ends when it reads the terminating zero chunk", async () => {
  const decoder = new ChunkedDecoder();
  const chunks = [];
  let ended = false;

  decoder.on("data", (chunk) => chunks.push(chunk.toString()));
  decoder.on("end", () => {
    ended = true;
  });

  decoder.write(Buffer.from("5\r\nhello\r\n"));
  decoder.write(Buffer.from("0\r\n\r\n"));

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(chunks, ["hello"]);
  assert.equal(ended, true);
});

test("content length decoder ends after the declared byte count", async () => {
  const decoder = new ContentLengthDecoder(5);
  const chunks = [];
  let ended = false;

  decoder.on("data", (chunk) => chunks.push(chunk.toString()));
  decoder.on("end", () => {
    ended = true;
  });

  decoder.write(Buffer.from("hello extra bytes that belong to keep-alive"));

  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(chunks, ["hello"]);
  assert.equal(ended, true);
});
