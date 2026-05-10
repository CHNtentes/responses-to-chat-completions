import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STATE = {
  version: 1,
  responses: {},
  reasoning_content_by_tool_call_id: {},
  order: []
};

export class MemoryHistoryStore {
  constructor() {
    this.responses = new Map();
    this.reasoningContentByToolCallId = new Map();
  }

  async get(responseId) {
    return this.responses.get(responseId) ?? [];
  }

  async set(responseId, messages) {
    this.responses.set(responseId, messages);
  }

  async getReasoningContent(toolCallId) {
    return this.reasoningContentByToolCallId.get(toolCallId) ?? "";
  }

  async setReasoningContent(toolCallId, reasoningContent) {
    this.reasoningContentByToolCallId.set(toolCallId, reasoningContent);
  }
}

export class FileHistoryStore {
  static async create(options = {}) {
    const store = new FileHistoryStore(options);
    await store.load();
    return store;
  }

  constructor({ filePath = ".data/history.json", maxResponses = 200 } = {}) {
    this.filePath = filePath;
    this.maxResponses = maxResponses;
    this.state = structuredClone(EMPTY_STATE);
    this.writeQueue = Promise.resolve();
    this.reasoningContentByToolCallId = {
      get: (toolCallId) => this.state.reasoning_content_by_tool_call_id[toolCallId] ?? ""
    };
  }

  async load() {
    try {
      this.state = normalizeState(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") {
        this.state = structuredClone(EMPTY_STATE);
        return;
      }
      throw new Error(`读取历史文件失败: ${this.filePath}: ${error.message}`);
    }
  }

  async get(responseId) {
    return this.state.responses[responseId] ?? [];
  }

  async set(responseId, messages) {
    if (!this.state.responses[responseId]) this.state.order.push(responseId);
    this.state.responses[responseId] = messages;
    this.trim();
    this.pruneReasoningContent();
    await this.persist();
  }

  async getReasoningContent(toolCallId) {
    return this.state.reasoning_content_by_tool_call_id[toolCallId] ?? "";
  }

  async setReasoningContent(toolCallId, reasoningContent) {
    this.state.reasoning_content_by_tool_call_id[toolCallId] = reasoningContent;
    await this.persist();
  }

  trim() {
    while (this.state.order.length > this.maxResponses) {
      const oldest = this.state.order.shift();
      delete this.state.responses[oldest];
    }
  }

  pruneReasoningContent() {
    const referencedToolCallIds = new Set();
    for (const messages of Object.values(this.state.responses)) {
      for (const message of messages) {
        if (!Array.isArray(message.tool_calls)) continue;
        for (const toolCall of message.tool_calls) {
          if (toolCall.id) referencedToolCallIds.add(toolCall.id);
        }
      }
    }

    for (const toolCallId of Object.keys(this.state.reasoning_content_by_tool_call_id)) {
      if (!referencedToolCallIds.has(toolCallId)) {
        delete this.state.reasoning_content_by_tool_call_id[toolCallId];
      }
    }
  }

  async persist() {
    this.writeQueue = this.writeQueue.then(() => this.writeState());
    return this.writeQueue;
  }

  async writeState() {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }
}

export async function createHistoryStore(cfg) {
  if (cfg.historyStoreType === "file") {
    return FileHistoryStore.create({
      filePath: cfg.historyFilePath,
      maxResponses: cfg.historyMaxResponses
    });
  }

  return new MemoryHistoryStore();
}

function normalizeState(value) {
  return {
    version: 1,
    responses: isPlainObject(value?.responses) ? value.responses : {},
    reasoning_content_by_tool_call_id: isPlainObject(value?.reasoning_content_by_tool_call_id)
      ? value.reasoning_content_by_tool_call_id
      : {},
    order: Array.isArray(value?.order) ? value.order : Object.keys(value?.responses ?? {})
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
