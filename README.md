# Responses to Chat Completions Proxy

这是一个本地兼容代理：对客户端暴露 OpenAI Responses API 风格的 `/v1/responses`，再把请求转换成上游 OpenAI-compatible `/v1/chat/completions`。

目标场景是：客户端只会调用 Responses API，但实际模型服务只提供 Chat Completions API。

## 功能范围

- 支持 `POST /v1/responses`
- 支持 `GET /v1/models`
- 支持非流式文本响应
- 支持 Chat Completions SSE 到 Responses SSE 的基础转换
- 支持 Chat Completions 流式 function tool call delta 到 Responses function call 事件的基础拼接
- 支持 `instructions` + `input` 到 `messages` 的转换
- 支持普通 function tool 的 schema 转换
- 支持 `previous_response_id` 的内存历史串联
- 支持可选文件持久化历史，避免单实例服务重启后丢失 `previous_response_id`
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
| `CLIENT_API_KEY` | 空 | 客户端访问本代理时需要的 Bearer token；为空则不校验客户端 key |
| `DEFAULT_MODEL` | 空 | 请求未传 model 时使用的模型 |
| `MODEL_MAP` | 空 | 模型名映射，支持 JSON 或 `from=to,from2=to2` |
| `TITLE_MODEL` | `gpt-5.4-mini` | Codex 用于生成聊天标题的模型名；为空则不启用专用标题模型映射 |
| `UPSTREAM_TITLE_MODEL` | 空 | 上游实际支持的标题生成模型名；与 `TITLE_MODEL` 同时设置时生效 |
| `UNSUPPORTED_TOOL_POLICY` | `ignore` | 内置工具处理策略；`ignore` 为过滤，`error` 为直接报错 |
| `UPSTREAM_TIMEOUT_MS` | `30000` | 连接上游和等待响应的超时时间，单位毫秒 |
| `UPSTREAM_STREAMING` | `true` | 是否对上游使用流式请求；设为 `false` 时下游仍返回 SSE，但上游走非流式 |
| `DEBUG_UPSTREAM_BODY` | `false` | 是否打印上游原始响应体调试日志；生产环境建议保持 `false` |
| `HISTORY_STORE` | `memory` | 历史存储方式；`memory` 为进程内存，`file` 为 JSON 文件 |
| `HISTORY_FILE_PATH` | `.data/history.json` | `HISTORY_STORE=file` 时使用的历史文件路径 |
| `HISTORY_MAX_RESPONSES` | `200` | 文件历史最多保存的 response 数量，超过后删除最旧记录 |

`MODEL_MAP` 示例：

```powershell
$env:MODEL_MAP='{"gpt-5.3-codex":"qwen3-coder"}'
```

或：

```powershell
$env:MODEL_MAP='gpt-5.3-codex=qwen3-coder,gpt-5=deepseek-chat'
```

如果上游不支持 Codex 默认的标题生成模型名，可以单独配置标题模型映射：

```powershell
$env:TITLE_MODEL='gpt-5.4-mini'
$env:UPSTREAM_TITLE_MODEL='qwen3-coder'
```

这等价于在 `MODEL_MAP` 中额外加入 `gpt-5.4-mini=qwen3-coder`。

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
$env:CLIENT_API_KEY='your-client-key'
$env:DEFAULT_MODEL='deepseek-v4-pro'
$env:UPSTREAM_TIMEOUT_MS='60000'
$env:UPSTREAM_STREAMING='false'
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

如果没有设置 `CLIENT_API_KEY`，API key 可以填任意非空值；代理只会用 `UPSTREAM_API_KEY` 调上游。

如果设置了 `CLIENT_API_KEY`，Codex 传给本代理的 API key 必须等于 `CLIENT_API_KEY`。此时不要把上游真实 key 配给 Codex 客户端，上游真实 key 只放在代理进程的 `UPSTREAM_API_KEY`。

## Docker 部署

Ubuntu 服务器上建议使用 Docker Compose。先准备 `.env`：

```bash
cp .env.example .env
```

DeepSeek 示例：

```dotenv
PORT=8688
HOST=0.0.0.0
UPSTREAM_CHAT_COMPLETIONS_URL=https://api.deepseek.com/chat/completions
UPSTREAM_PROXY_URL=
UPSTREAM_API_KEY=your-deepseek-key
CLIENT_API_KEY=your-client-key
DEFAULT_MODEL=deepseek-v4-pro
TITLE_MODEL=gpt-5.4-mini
UPSTREAM_TITLE_MODEL=deepseek-chat
UPSTREAM_TIMEOUT_MS=60000
UPSTREAM_STREAMING=false
DEBUG_UPSTREAM_BODY=false
HISTORY_STORE=file
HISTORY_FILE_PATH=/app/.data/history.json
HISTORY_MAX_RESPONSES=200
```

启动：

```bash
docker compose up -d --build
```

Compose 默认挂载名为 `responses-history` 的 Docker volume 到 `/app/.data`。只有设置 `HISTORY_STORE=file` 时才会写入历史文件；默认 `memory` 模式不会持久化历史。

查看日志和健康状态：

```bash
docker logs -f responses-proxy
curl http://127.0.0.1:8688/health
docker compose ps
```

停止：

```bash
docker compose down
```

服务器防火墙只需要放通 Codex 客户端能访问到的端口，例如 `8688`。如果服务暴露到非本机网络，建议务必设置 `CLIENT_API_KEY`，并优先放在内网、VPN 或反向代理后面。

Codex 连接远端 Docker 服务时，base URL 改成：

```text
http://服务器IP:8688/v1
```

如果配置了 `CLIENT_API_KEY`，Codex 的 `env_key` 应指向客户端访问代理用的 key，而不是 `UPSTREAM_API_KEY`。

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
- `HISTORY_STORE=memory` 时，`previous_response_id` 使用进程内内存保存，服务重启后历史会丢失。
- `HISTORY_STORE=file` 适合单实例部署；不适合多个代理进程同时写同一个 JSON 历史文件。
- 流式 tool call delta 支持基础 function call 拼接；复杂多模态或非 function 工具流式内容仍未完整实现。
- 内置工具不会被模拟执行，默认会被过滤掉；如果设置 `UNSUPPORTED_TOOL_POLICY=error`，收到后会返回 `unsupported_tool` 错误。
