export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 8688),
    upstreamBaseUrl: stripTrailingSlash(env.UPSTREAM_BASE_URL ?? "http://127.0.0.1:8000"),
    upstreamApiKey: env.UPSTREAM_API_KEY ?? "",
    defaultModel: env.DEFAULT_MODEL ?? "",
    modelMap: parseModelMap(env.MODEL_MAP ?? "")
  };
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
