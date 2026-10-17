# Codex 本地 OpenAI 兼容测试服务

把本机已经通过 ChatGPT 登录的 Codex CLI 接到 Orbis 的 **OpenAI Chat Completions** 配置。Node 服务运行在本机，推理仍使用 Codex 云端和当前账户的 Codex 用量限制。无需付费 OpenAI API Key；不提供离线模型，也不增加或绕过账户额度。

## Orbis 连接

服务首次启动会生成本地访问密钥。打开同目录的 `CONNECTION.txt`，将其中的四项填入截图中的配置页：

| 设置 | 值 |
| --- | --- |
| API 协议 | OpenAI Chat Completions |
| Base URL | `http://127.0.0.1:8787/v1` |
| 模型 ID | `codex-local` |
| API Key | `CONNECTION.txt` 中的 `local-…` 密钥 |

`codex-local` 是本地别名，默认映射到启动时 Codex 模型目录的默认模型。也可填写 `/v1/models` 返回的实际模型 ID。当前实际模型记录在 `CONNECTION.txt`。目录中出现模型不代表账户额度始终足够，最终以 Codex 上游响应为准。

先关闭 Computer Use，确认普通对话和业务工具调用。图片内容与客户端函数工具均有协议转换；尚未在 Orbis 内验证 Computer Use 整套操作流程。服务不会自行操作浏览器或 macOS 应用。

这里的 API Key 只验证本地服务请求，不是 OpenAI 付费 API Key 或 ChatGPT 登录凭据。

## 运行

需要 Node.js 22+ 和支持这些 app-server 方法的 Codex CLI。本机已验证桌面应用附带的 `codex-cli 0.159.2`，会优先选择此二进制，不改动全局旧版本。零 npm 依赖，无需执行 `npm install`。

在本项目目录执行：

```sh
npm run service:start   # 在后台启动，关闭聊天或终端后继续运行
npm run service:status  # 查看状态
npm run service:stop    # 停止本项目的服务
npm start              # 前台运行，Ctrl+C 停止
```

关闭电脑或重启后需重新启动。此项目没有安装开机启动项。

如果登录过期，使用服务选择的 CLI 重新登录：

```sh
"/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex" login
```

登录方式必须是 ChatGPT。启动和每次请求均会检查，API Key 模式会被拒绝。服务从子进程环境移除 API Key / access-token 覆盖变量，由 CLI 自己读取并维护已保存的登录；不会提取登录令牌或调用未公开的推理接口。

## 支持范围

| 功能 | 实现 |
| --- | --- |
| `GET /v1/models` | Codex 模型目录与本地别名 |
| `POST /v1/chat/completions` | 普通 JSON 回复与 SSE 流 |
| 消息历史 | system/developer 指令与原生 user/assistant/tool 历史 |
| 函数工具 | tools → Codex dynamicTools；返回 tool_calls，由客户端执行 |
| 工具结果 | 客户端回传 assistant 的工具调用和对应 tool 消息，继续回答 |
| 工具选择 | auto、none、required、指定函数；required/指定函数使用指令约束与结果校验，无法满足时返回错误 |
| 图片输入 | user.content 中的 text/image_url；HTTP(S) URL 和 data URL 原样传给 Codex |
| 结构化回复 | json_schema 使用 outputSchema；json_object 使用指令与 JSON 结果校验 |
| 用量 | 有上游用量通知时转换为 usage，缺失时省略，不编造 token 数 |
| 错误与取消 | OpenAI 风格 error；超时或断开连接时结束对应 Codex 进程 |

这是 **Chat Completions 子集适配器**。没有实现 Responses、embeddings、语音或图片生成接口。只支持 `n=1`，每次至多返回一个函数调用，不实现并行工具调用。`strict` 工具标志没有额外的本地 JSON Schema 校验，客户端仍需验证参数。

Codex app-server 不提供 Chat Completions 的所有生成控制。`temperature`、`top_p`、`max_tokens`、`max_completion_tokens`、`stop`、`seed`、惩罚参数与 `logprobs` 被接收但不应用，响应头 `X-Codex-Ignored-Parameters` 会列出这些字段；不要依赖它们限制输出。支持模型目录中公布的 `reasoning_effort`，默认 `low`，不启用自动委派的 `ultra`。

每个请求创建独立的短生命周期 app-server 进程和临时 thread；客户端应每次发送完整 messages 历史。此设计便于测试和隔离会话，但每次有初始化延迟，历史很长时成本与延迟会增加。默认最多两路并发，满额返回 HTTP 429，推理超时为 180 秒。

## 工程结构

```text
src/
  config/settings.mjs      配置、CLI 路径、本地密钥
  codex/rpc-client.mjs     stdio JSON-RPC 与进程生命周期
  codex/backend.mjs        临时会话、流事件、工具边界
  openai/request.mjs       输入校验与历史转换
  openai/response.mjs      Chat Completions JSON/SSE 输出
  http/errors.mjs          HTTP 错误约定
  http/server.mjs          路由、访问验证、并发、取消
  main.mjs                启动与退出
scripts/
  service.mjs             后台服务管理
  smoke.mjs               使用真实 Codex 的冒烟测试
tests/                    HTTP 与协议回归测试
.runtime/                 密钥、日志、独立工作目录（不提交）
```

服务固定绑定 `127.0.0.1`。访问模型接口需要本地 Bearer 密钥，允许无 Origin 的本地请求、Electron 的 `null` / `dsh-app://app` 和 localhost 浏览器来源。日志只记录请求 ID、状态和耗时，不记录对话正文或密钥。

内置工具、插件、应用、shell、委派、记忆、hooks 和 web search 通过子进程参数关闭，并设置空 environments、只读 sandbox。客户端传入的函数工具始终交回客户端执行。已有 CLI 登录和全局配置文件不会被本项目改写；CLI 自身仍会更新正常的认证缓存与运行日志。

## 配置与测试

可选环境变量：

| 变量 | 默认 |
| --- | --- |
| `BRIDGE_CODEX_BIN` | 优先使用桌面应用附带 CLI，其次 PATH |
| `BRIDGE_PORT` | 8787 |
| `BRIDGE_MODEL` | Codex 目录的默认模型 |
| `BRIDGE_API_KEY` | 首次启动生成并保存，后续复用 |
| `BRIDGE_TIMEOUT_MS` | 180000 |
| `BRIDGE_MAX_CONCURRENT` | 2 |

修改环境变量后停止并重新启动。停止服务时需使用与启动时相同的端口和密钥。`.runtime/service.log` 是启动诊断与请求日志。

```sh
npm test       # 无需联网，不消耗 Codex 用量
npm run smoke  # 服务运行时执行，会消耗少量 Codex 用量
```

已通过 14 项本地回归测试和 8 项真实 HTTP 冒烟检查。`smoke-results.json` 记录模型目录、真实文本、SSE、函数调用、工具结果续接、流式工具调用、合成图片输入和 JSON Schema 回复的结果。这些检查通过本地 HTTP 服务完成；Orbis 软件内部的端到端连接仍需按连接参数验证。

官方资料：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Codex Authentication](https://learn.chatgpt.com/docs/auth)。本项目使用公开的 app-server 集成接口，HTTP 协议转换由本地项目实现。
