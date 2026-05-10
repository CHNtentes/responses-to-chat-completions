export function loadConfig(env = process.env) {
  return {
    port: parsePort(env.PORT ?? 8688),
    host: env.HOST ?? "127.0.0.1",
    upstreamBaseUrl: stripTrailingSlash(env.UPSTREAM_BASE_URL ?? "http://127.0.0.1:8000"),
    upstreamChatCompletionsUrl: env.UPSTREAM_CHAT_COMPLETIONS_URL ?? "",
    upstreamApiKey: env.UPSTREAM_API_KEY ?? "",
    clientApiKey: env.CLIENT_API_KEY ?? "",
    upstreamProxyUrl: env.UPSTREAM_PROXY_URL ?? "",
    noProxy: env.NO_PROXY ?? env.no_proxy ?? "localhost,127.0.0.1,::1",
    defaultModel: env.DEFAULT_MODEL ?? "",
    unsupportedToolPolicy: parseEnum("UNSUPPORTED_TOOL_POLICY", env.UNSUPPORTED_TOOL_POLICY ?? "ignore", [
      "ignore",
      "error"
    ]),
    upstreamTimeoutMs: parsePositiveInteger("UPSTREAM_TIMEOUT_MS", env.UPSTREAM_TIMEOUT_MS ?? 30000),
    upstreamStreaming: parseBoolean(env.UPSTREAM_STREAMING ?? "true"),
    debugUpstreamBody: parseBoolean(env.DEBUG_UPSTREAM_BODY ?? "false"),
    historyStoreType: parseEnum("HISTORY_STORE", env.HISTORY_STORE ?? "memory", ["memory", "file"]),
    historyFilePath: env.HISTORY_FILE_PATH ?? ".data/history.json",
    historyMaxResponses: parsePositiveInteger("HISTORY_MAX_RESPONSES", env.HISTORY_MAX_RESPONSES ?? 200),
    modelMap: parseModelMap(env.MODEL_MAP ?? "")
  };
}

export function resolveChatCompletionsUrl(cfg) {
  if (cfg.upstreamChatCompletionsUrl) {
    return cfg.upstreamChatCompletionsUrl;
  }

  if (cfg.upstreamBaseUrl.endsWith("/chat/completions")) {
    return cfg.upstreamBaseUrl;
  }

  return `${cfg.upstreamBaseUrl}/v1/chat/completions`;
}

export function parseModelMap(value) {
  if (!value.trim()) return {};

  try {
    return JSON.parse(value);
  } catch {
    const result = {};
    for (const pair of value.split(",")) {
      const [from, to] = pair.split("=").map((part) => part?.trim());
      if (from && to) result[from] = to;
    }
    return result;
  }
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function parseBoolean(value) {
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT 必须是 1 到 65535 之间的整数");
  }
  return port;
}

function parsePositiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} 必须是正整数`);
  }
  return parsed;
}

function parseEnum(name, value, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw new Error(`${name} 必须是以下值之一: ${allowedValues.join(", ")}`);
  }
  return value;
}
