import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "./config.js";

test("loads valid numeric and enum config values", () => {
  const cfg = loadConfig({
    PORT: "9000",
    UPSTREAM_TIMEOUT_MS: "60000",
    HISTORY_MAX_RESPONSES: "50",
    HISTORY_STORE: "file",
    UNSUPPORTED_TOOL_POLICY: "error"
  });

  assert.equal(cfg.port, 9000);
  assert.equal(cfg.upstreamTimeoutMs, 60000);
  assert.equal(cfg.historyMaxResponses, 50);
  assert.equal(cfg.historyStoreType, "file");
  assert.equal(cfg.unsupportedToolPolicy, "error");
});

test("rejects invalid numeric config values", () => {
  assert.throws(() => loadConfig({ PORT: "abc" }), /PORT 必须是 1 到 65535 之间的整数/);
  assert.throws(() => loadConfig({ PORT: "70000" }), /PORT 必须是 1 到 65535 之间的整数/);
  assert.throws(
    () => loadConfig({ UPSTREAM_TIMEOUT_MS: "0" }),
    /UPSTREAM_TIMEOUT_MS 必须是正整数/
  );
  assert.throws(
    () => loadConfig({ HISTORY_MAX_RESPONSES: "-1" }),
    /HISTORY_MAX_RESPONSES 必须是正整数/
  );
});

test("rejects invalid enum config values", () => {
  assert.throws(() => loadConfig({ HISTORY_STORE: "sqlite" }), /HISTORY_STORE 必须是以下值之一: memory, file/);
  assert.throws(
    () => loadConfig({ UNSUPPORTED_TOOL_POLICY: "warn" }),
    /UNSUPPORTED_TOOL_POLICY 必须是以下值之一: ignore, error/
  );
});
