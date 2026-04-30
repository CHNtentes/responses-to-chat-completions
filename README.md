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
- 显式拒绝 Responses 内置工具，例如 `web_search_preview`、`file_search`、`computer_use`、`code_interpreter`、`image_generation`、`mcp`

## 要求

- Node.js 20 或更高版本
- 一个兼容 `/v1/chat/completions` 的上游模型服务

当前项目没有外部 npm 依赖。

## 配置

复制 `.env.example` 为 `.env`，或直接设置环境变量。

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8688` | 本地代理端口 |
| `UPSTREAM_BASE_URL` | `http://127.0.0.1:8000` | 上游服务 base URL，不含 `/v1/chat/completions` |
| `UPSTREAM_API_KEY` | 空 | 上游 Bearer token |
| `DEFAULT_MODEL` | 空 | 请求未传 model 时使用的模型 |
| `MODEL_MAP` | 空 | 模型名映射，支持 JSON 或 `from=to,from2=to2` |

`MODEL_MAP` 示例：

```powershell
$env:MODEL_MAP='{"gpt-5.3-codex":"qwen3-coder"}'
```

或：

```powershell
$env:MODEL_MAP='gpt-5.3-codex=qwen3-coder,gpt-5=deepseek-chat'
```

## 启动

```powershell
$env:UPSTREAM_BASE_URL='http://127.0.0.1:8000'
$env:UPSTREAM_API_KEY='your-upstream-key'
$env:DEFAULT_MODEL='qwen3-coder'
npm.cmd start
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

## 已知限制

- 没有实现完整 Responses API，只实现 Codex/agent 适配所需的核心兼容层。
- `previous_response_id` 使用进程内内存保存，服务重启后历史会丢失。
- 流式 tool call delta 目前只保留文本 delta；复杂工具调用流式拼接需要后续增强。
- 内置工具不会被模拟执行，收到后会返回 `unsupported_tool` 错误。
