# Responses to Chat Completions Proxy

这是一个本地兼容代理：对客户端暴露 OpenAI Responses API 风格的 `/v1/responses`，再把请求转换成上游 OpenAI-compatible `/v1/chat/completions`。

目标场景是：客户端只会调用 Responses API，但实际模型服务只提供 Chat Completions API。

## 功能范围

- 支持 `POST /v1/responses`
- 支持 `GET /v1/models`
- 支持非流式文本响应
- 支持 Chat Completions SSE 到 Responses SSE 的基础转换
- 支持 `instructions` + `input` 到 `messages` 的转换
- 支持普通 function tool 的 schema 转换
- 支持 `previous_response_id` 的内存历史串联
- 默认忽略无法转换的 Responses 内置工具，例如 `web_search`、`file_search`、`computer_use`、`code_interpreter`、`image_generation`、`mcp`

## 要求

- Node.js 20 或更高版本
- 一个兼容 `/v1/chat/completions` 的上游模型服务

当前项目没有外部 npm 依赖。

## 配置

复制 `.env.example` 为 `.env`，或直接设置环境变量。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8688` | 本地代理端口 |
| `HOST` | `127.0.0.1` | 本地代理监听地址；VS Code 插件连不上时可临时设为 `0.0.0.0` 排查 |
| `UPSTREAM_BASE_URL` | `http://127.0.0.1:8000` | 上游服务 base URL，不含 `/v1/chat/completions` |
| `UPSTREAM_CHAT_COMPLETIONS_URL` | 空 | 上游完整 Chat Completions URL；设置后优先于 `UPSTREAM_BASE_URL` |
| `UPSTREAM_PROXY_URL` | 空 | 访问上游时使用的 HTTP 代理，例如 `http://127.0.0.1:7890` |
| `UPSTREAM_API_KEY` | 空 | 上游 Bearer token |
| `DEFAULT_MODEL` | 空 | 请求未传 model 时使用的模型 |
| `MODEL_MAP` | 空 | 模型名映射，支持 JSON 或 `from=to,from2=to2` |
| `UNSUPPORTED_TOOL_POLICY` | `ignore` | 内置工具处理策略；`ignore` 为过滤，`error` 为直接报错 |
| `UPSTREAM_TIMEOUT_MS` | `30000` | 连接上游和等待响应的超时时间，单位毫秒 |
| `UPSTREAM_STREAMING` | `true` | 是否对上游使用流式请求；设为 `false` 时下游仍返回 SSE，但上游走非流式 |

`MODEL_MAP` 示例：

```powershell
$env:MODEL_MAP='{"gpt-5.3-codex":"qwen3-coder"}'
```

或：

```powershell
$env:MODEL_MAP='gpt-5.3-codex=qwen3-coder,gpt-5=deepseek-chat'
```

## 启动

如果上游是标准 OpenAI-compatible base URL：

```powershell
$env:UPSTREAM_BASE_URL='http://127.0.0.1:8000'
$env:UPSTREAM_API_KEY='your-upstream-key'
$env:DEFAULT_MODEL='qwen3-coder'
npm.cmd start
```

如果上游给的是完整 Chat Completions URL，例如 DeepSeek：

```powershell
$env:UPSTREAM_CHAT_COMPLETIONS_URL='https://api.deepseek.com/chat/completions'
$env:UPSTREAM_PROXY_URL='http://proxysh.zte.com.cn:80'
$env:UPSTREAM_API_KEY=$env:DEEPSEEK_API_KEY
$env:DEFAULT_MODEL='deepseek-v4-pro'
$env:UPSTREAM_TIMEOUT_MS='60000'
$env:UPSTREAM_STREAMING='false'
$env:DEBUG_UPSTREAM_BODY='true'
npm.cmd start
```

也可以直接把 `UPSTREAM_BASE_URL` 写成以 `/chat/completions` 结尾的完整地址，代理会自动识别：

```powershell
$env:UPSTREAM_BASE_URL='https://api.deepseek.com/chat/completions'
```

启动后本地地址：

```text
http://127.0.0.1:8688/v1/responses
```

## Codex 使用方式

把 Codex 的 OpenAI base URL 指向本代理：

```text
http://127.0.0.1:8688/v1
```

API key 可以填任意非空值；代理不会校验客户端传入的 key，只会用 `UPSTREAM_API_KEY` 调上游。

## 测试

PowerShell 下建议使用 `npm.cmd`，避免执行策略拦截 `npm.ps1`：

```powershell
npm.cmd test
```

## 上游连接排查

如果代理返回：

```json
{"error":{"type":"upstream_fetch_failed"}}
```

说明代理没有连上上游 Chat Completions 服务。常见原因：

- `UPSTREAM_CHAT_COMPLETIONS_URL` 或 `UPSTREAM_BASE_URL` 配错。
- 当前网络无法直连上游域名，例如 `https://api.deepseek.com/chat/completions`。
- 系统需要 HTTP/HTTPS 代理，但当前 Node.js 进程没有配置代理；可以设置 `UPSTREAM_PROXY_URL`。
- 防火墙、公司网络或 DNS 解析导致连接超时。

可以先在同一个 PowerShell 窗口里验证上游是否能连通：

```powershell
Invoke-RestMethod `
  -Uri 'https://api.deepseek.com/chat/completions' `
  -Method Post `
  -Headers @{ Authorization = "Bearer $env:UPSTREAM_API_KEY"; "Content-Type" = "application/json" } `
  -Body '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

公司网络需要代理时，优先显式设置：

```powershell
$env:UPSTREAM_PROXY_URL='http://你的代理地址:端口'
```

也可以使用常见环境变量，代理会读取 `HTTPS_PROXY`、`https_proxy`、`HTTP_PROXY`、`http_proxy`。本地地址 `localhost`、`127.0.0.1`、`::1` 会自动绕过代理。

如果 `curl` 能通但代理服务仍失败，请用同一个代理地址验证：

```powershell
curl.exe -v `
  -x http://你的代理地址:端口 `
  https://api.deepseek.com/chat/completions `
  -H "Authorization: Bearer $env:UPSTREAM_API_KEY" `
  -H "Content-Type: application/json" `
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

确认 curl 输出里有 `CONNECT api.deepseek.com:443` 且返回 `200`，说明 HTTP CONNECT 代理链路可用。

## 已知限制

- 没有实现完整 Responses API，只实现 Codex/agent 适配所需的核心兼容层。
- `previous_response_id` 使用进程内内存保存，服务重启后历史会丢失。
- 流式 tool call delta 目前只保留文本 delta；复杂工具调用流式拼接需要后续增强。
- 内置工具不会被模拟执行，默认会被过滤掉；如果设置 `UNSUPPORTED_TOOL_POLICY=error`，收到后会返回 `unsupported_tool` 错误。
