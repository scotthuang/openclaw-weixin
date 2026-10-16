# OpenClaw 微信渠道

[![CI](https://github.com/Tencent/openclaw-weixin/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Tencent/openclaw-weixin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tencent-weixin/openclaw-weixin)](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
[![Node.js](https://img.shields.io/node/v/@tencent-weixin/openclaw-weixin)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

[English](./README.md)

OpenClaw 的微信渠道插件。通过扫码登录将 OpenClaw Gateway 连接到微信，并通过微信后端收发消息。

## 主要能力

- 扫码登录并自动保存登录凭证。
- 一个 OpenClaw Gateway 同时运行多个微信账号。
- 支持文本、图片、语音、文件和视频消息。
- 长轮询收取消息，并支持输入状态提示。
- 集成 OpenClaw 渠道路由、配对和会话隔离能力。

## 环境要求

| 组件 | 要求 |
| --- | --- |
| Node.js | `>=22.13.0` |
| OpenClaw 运行时检查 | `>=2026.8.1` |
| npm peer dependency | `>=2026.8.1` |

要求 `OpenClaw >=2026.8.1`，以使用消息接管回调、限定会话范围的附件查询工具，以及附件完成通知的命令抑制能力。

必须先安装 OpenClaw，并确保 `openclaw` 命令可用。请参阅 [OpenClaw 安装指南](https://docs.openclaw.ai/install)。

```bash
openclaw --version
```

## 快速开始

### 1. 安装插件

```bash
npx -y @tencent-weixin/openclaw-weixin-cli install
```

如果当前环境不适合使用安装器，也可以直接安装插件：

```bash
openclaw plugins install "@tencent-weixin/openclaw-weixin"
```

### 2. 启用插件

```bash
openclaw config set plugins.entries.openclaw-weixin.enabled true
```

### 3. 使用微信扫码登录

```bash
openclaw channels login --channel openclaw-weixin
```

使用微信扫描二维码并确认授权。登录成功后，凭证会自动保存到本地。

### 4. 重启并检查 Gateway

```bash
openclaw gateway restart
openclaw channels status
```

## 后台附件（scotthuang 维护分支）

附件在后台下载。模型先收到文件名称和待下载状态，后续文字无需等待附件或上一轮模型回复完成即可进入 Core。会话调度仍由 Core 负责，因此不承诺模型随时立即中断当前工作。

只读工具 `weixin_attachment_status` 可查询当前微信账号、发送者、agent 和会话中的附件任务。如果配置了工具白名单，需要允许此工具。进度表示本次尝试已收到、尚未 AES 解密的数据字节；只有响应提供可靠总大小时才能给出百分比。完成通知关联原消息，并携带下载、解密和保存都成功的文件；该通知不能执行斜杠命令。

下载等待响应头最多 120 秒，连续无数据最多 30 秒，临时错误最多尝试三次。持续有数据的慢下载不受固定整文件时限限制。每个账号最多同时下载两个附件、保留 32 个未完成任务；超出容量的附件明确失败，文字仍能继续处理。明文附件上限为 100 MiB。

任务状态仅保存在内存中，最多保留 256 条记录，完成任务保留一小时。Gateway 停止或重启会取消未完成任务，需要重新发送附件。经过授权的 `/stop`、`/new`、`/reset` 会取消当前会话的附件并抑制其延迟完成通知。本次没有增加持久化入站重放或崩溃恢复能力。

## 配置

### 多账号

每个账号再次执行登录命令：

```bash
openclaw channels login --channel openclaw-weixin
```

同时登录多个账号时，建议按账号、渠道和对端隔离私聊会话：

```bash
openclaw config set session.dmScope per-account-channel-peer
```

### 自定义 BotAgent

可以设置一个用于后台日志归因和监控的标识：

```json
{
  "channels": {
    "openclaw-weixin": {
      "botAgent": "MyBot/1.2.0"
    }
  }
}
```

`botAgent` 仅用于观测，不是鉴权凭证，也不控制消息路由。

**格式规范**（UA 风格）：

- 一个或多个 `Name/Version` token，空格分隔
- 每个 token 可选地跟一个 ` (comment)`
- 仅允许 ASCII 字符；总长 ≤ 256 字节
- 不合规的 token 在清洗时静默丢弃；如果最终为空，回退到 `OpenClaw`

可直接使用的示例：

- `MyBot/1.2.0`
- `MyBot/1.2.0 (region=cn;env=prod)`
- `MyBot/1.2.0 LangChain/0.3.5`
- `MyBot/1.2.0-rc.1+build.5`

**注意**：`bot_agent` 仅用于观测，**不参与鉴权或路由**。当前本插件实例下所有
已注册的 agent 共享同一个 `botAgent` 声明；如有需要按 agent 单独标识的场景，
可在后续版本扩展配置。

## 引用消息本地缓存

新版微信客户端可能只在引用消息中提供服务端消息 ID。插件会在本地保存必要的文本和媒体元数据，
以便后续引用消息还原上下文。缓存默认开启，缓存故障不会中断正常消息收发。

引用文字会以 Markdown 引用块显示在 OpenClaw 聊天记录的当前问题下方，同一份文字提供给模型，
不再重复隐藏注入。引用最多保留 2,000 个 UTF-16 单元，超长时保留开头和结尾，并显示
`…[omitted]…` 省略标记；缓存未命中或引用附件过期时会明确提示。当前问题排在前面，
长消息折叠时也能先看到本次请求。已有聊天记录不会回填。

如需调整保留时间或空间限制，可配置 `channels.openclaw-weixin.quoteCache`。默认文本缓存保留 30 天、
每个账号最多 10,000 条；媒体缓存保留 7 天、每个账号最多 256 MiB、单个文件最多 25 MiB。
完整配置、存储行为和验证说明见[引用消息本地缓存开发说明](./docs/quote-cache_zh_CN.md)。

## 卸载

```bash
openclaw plugins uninstall @tencent-weixin/openclaw-weixin
```

## 故障排查

### 插件报告 OpenClaw 版本不受支持

检查宿主版本：

```bash
openclaw --version
```

将 OpenClaw 升级到受支持的版本，然后重启 Gateway。

### Channel 显示 `OK` 但没有连接

确认插件已启用，然后重启 Gateway：

```bash
openclaw config set plugins.entries.openclaw-weixin.enabled true
openclaw gateway restart
```

如果问题仍然存在，请检查 Gateway 日志，并确认账号已经完成扫码登录。

## 文档

| 需求 | 文档 |
| --- | --- |
| 后端对接 | [微信后端 API 协议](./docs/protocol_zh_CN.md) |
| CI 和本地质量检查 | [CI 指南](./docs/ci_zh_CN.md) |
| 开发与本地验证 | [开发者指南](./docs/development_zh_CN.md) |
| OpenClaw 渠道配置 | [OpenClaw Channels](https://docs.openclaw.ai/channels) |
| 发布历史 | [CHANGELOG.zh_CN.md](./CHANGELOG.zh_CN.md) |

后端协议文档面向实现或对接兼容后端的开发者，普通用户安装插件时不需要阅读。

## 开发

本项目使用 npm，并要求 Node.js `>=22.13.0`。

```bash
npm ci --ignore-scripts
npm run ci
```

修改功能或测试时，可以单独运行覆盖率检查：

```bash
npm run test:coverage
```

Pull Request 会在 GitHub Actions 中执行质量检查、单元测试、覆盖率、构建和 npm 包冒烟测试。详细说明见 [CI 指南](./docs/ci_zh_CN.md)。

从 worktree 创建、依赖安装到本地打包和插件安装的完整流程见[开发者指南](./docs/development_zh_CN.md)。

## 参与贡献

欢迎提交问题、改进文档、补充测试和贡献代码。请保持 Pull Request 聚焦，并附上验证结果。修改后端集成时，请同步更新[协议文档](./docs/protocol_zh_CN.md)。

## 维护者

如果你遇到问题或有任何疑问，欢迎通过 [GitHub 主页](https://github.com/zengyi1001) 联系我。主页上提供了邮箱、微信等联系方式。

## License

[MIT](./LICENSE)
