export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 8688),
    host: env.HOST ?? "127.0.0.1",
    upstreamBaseUrl: stripTrailingSlash(env.UPSTREAM_BASE_URL ?? "http://127.0.0.1:8000"),
    upstreamChatCompletionsUrl: env.UPSTREAM_CHAT_COMPLETIONS_URL ?? "",
    upstreamApiKey: env.UPSTREAM_API_KEY ?? "",
    upstreamProxyUrl: env.UPSTREAM_PROXY_URL ?? "",
    noProxy: env.NO_PROXY ?? env.no_proxy ?? "localhost,127.0.0.1,::1",
    defaultModel: env.DEFAULT_MODEL ?? "",
    unsupportedToolPolicy: env.UNSUPPORTED_TOOL_POLICY ?? "ignore",
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS ?? 30000),
    upstreamStreaming: parseBoolean(env.UPSTREAM_STREAMING ?? "true"),
    debugUpstreamBody: parseBoolean(env.DEBUG_UPSTREAM_BODY ?? "false"),
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
