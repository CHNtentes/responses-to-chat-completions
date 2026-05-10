import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { FileHistoryStore, MemoryHistoryStore } from "./history-store.js";

test("memory history store saves response messages and reasoning content", async () => {
  const store = new MemoryHistoryStore();

  await store.set("resp_1", [{ role: "user", content: "hi" }]);
  await store.setReasoningContent("call_1", "需要调用工具。");

  assert.deepEqual(await store.get("resp_1"), [{ role: "user", content: "hi" }]);
  assert.equal(await store.getReasoningContent("call_1"), "需要调用工具。");
});

test("file history store reloads saved response messages after restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "responses-history-"));
  const filePath = path.join(dir, "history.json");

  try {
    const first = await FileHistoryStore.create({ filePath, maxResponses: 10 });
    await first.set("resp_1", [{ role: "user", content: "hi" }]);
    await first.setReasoningContent("call_1", "需要调用工具。");

    const second = await FileHistoryStore.create({ filePath, maxResponses: 10 });

    assert.deepEqual(await second.get("resp_1"), [{ role: "user", content: "hi" }]);
    assert.equal(await second.getReasoningContent("call_1"), "需要调用工具。");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file history store trims oldest responses when max responses is exceeded", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "responses-history-"));
  const filePath = path.join(dir, "history.json");

  try {
    const store = await FileHistoryStore.create({ filePath, maxResponses: 2 });

    await store.set("resp_1", [{ role: "user", content: "one" }]);
    await store.set("resp_2", [{ role: "user", content: "two" }]);
    await store.set("resp_3", [{ role: "user", content: "three" }]);

    assert.deepEqual(await store.get("resp_1"), []);
    assert.deepEqual(await store.get("resp_2"), [{ role: "user", content: "two" }]);
    assert.deepEqual(await store.get("resp_3"), [{ role: "user", content: "three" }]);

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(persisted.order, ["resp_2", "resp_3"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file history store serializes concurrent writes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "responses-history-"));
  const filePath = path.join(dir, "history.json");

  try {
    const store = await FileHistoryStore.create({ filePath, maxResponses: 10 });

    await Promise.all([
      store.set("resp_1", [{ role: "user", content: "one" }]),
      store.set("resp_2", [{ role: "user", content: "two" }]),
      store.set("resp_3", [{ role: "user", content: "three" }])
    ]);

    const reloaded = await FileHistoryStore.create({ filePath, maxResponses: 10 });
    assert.deepEqual(await reloaded.get("resp_1"), [{ role: "user", content: "one" }]);
    assert.deepEqual(await reloaded.get("resp_2"), [{ role: "user", content: "two" }]);
    assert.deepEqual(await reloaded.get("resp_3"), [{ role: "user", content: "three" }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file history store removes reasoning content for trimmed tool calls", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "responses-history-"));
  const filePath = path.join(dir, "history.json");

  try {
    const store = await FileHistoryStore.create({ filePath, maxResponses: 1 });

    await store.set("resp_1", [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "shell", arguments: "{}" }
          }
        ]
      }
    ]);
    await store.setReasoningContent("call_1", "old reasoning");
    await store.set("resp_2", [{ role: "assistant", content: "done" }]);

    assert.equal(await store.getReasoningContent("call_1"), "");
    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(persisted.reasoning_content_by_tool_call_id, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
