# OpenClaw Weixin Channel

[![CI](https://github.com/Tencent/openclaw-weixin/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Tencent/openclaw-weixin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@tencent-weixin/openclaw-weixin)](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)
[![Node.js](https://img.shields.io/node/v/@tencent-weixin/openclaw-weixin)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

[简体中文](./README.zh_CN.md)

OpenClaw's Weixin channel plugin. Connect an OpenClaw Gateway to Weixin with QR-code login and receive and send messages through the Weixin backend.

## Highlights

- QR-code login with automatic credential storage.
- Multiple Weixin accounts on one OpenClaw Gateway.
- Text, image, voice, file, and video messages.
- Long-poll message delivery and typing indicators.
- OpenClaw channel routing, pairing, and session isolation.

## Requirements

| Component | Requirement |
| --- | --- |
| Node.js | `>=22.13.0` |
| OpenClaw runtime check | `>=2026.8.1` |
| npm peer dependency | `>=2026.8.1` |

OpenClaw `>=2026.8.1` is required for turn-adoption callbacks, scoped attachment tools, and command suppression on attachment completion events.

OpenClaw must be installed and the `openclaw` CLI must be available. See the [OpenClaw installation guide](https://docs.openclaw.ai/install).

```bash
openclaw --version
```

## Quick start

### 1. Install the plugin

```bash
npx -y @tencent-weixin/openclaw-weixin-cli install
```

If the installer is not suitable for your environment, install the plugin directly:

```bash
openclaw plugins install "@tencent-weixin/openclaw-weixin"
```

### 2. Enable the plugin

```bash
openclaw config set plugins.entries.openclaw-weixin.enabled true
```

### 3. Log in with Weixin

```bash
openclaw channels login --channel openclaw-weixin
```

Scan the QR code with Weixin and confirm the authorization. Credentials are stored locally after a successful login.

### 4. Restart and verify the Gateway

```bash
openclaw gateway restart
openclaw channels status
```

## Background attachments (scotthuang maintenance branch)

Incoming attachments download in the background. The initial message tells the agent which file is pending; later text can reach Core without waiting for that download or the previous model reply. Core remains responsible for conversation scheduling, so this does not promise an immediate model interruption.

The read-only `weixin_attachment_status` tool reports tasks belonging to the current Weixin account, sender, agent, and session. If you restrict tools with an allowlist, allow this tool to enable live progress queries. Byte counts describe the current network transfer attempt before AES decryption; a percentage is available only when the response supplies a usable total size. A ready notification includes the downloaded, decrypted, saved attachment and refers back to the original message. Completion events cannot execute slash commands.

Downloads have a 120-second response-header deadline, a 30-second no-data deadline, and at most three attempts for transient failures. Healthy transfers are not cut off by a fixed whole-file timeout. Each account allows two simultaneous downloads and 32 unfinished tasks; excess attachments fail explicitly while text continues. Attachments are limited to 100 MiB of plaintext.

Task state is held in memory, with at most 256 records and a one-hour retention for finished tasks. Gateway stop/restart cancels unfinished tasks; resend an attachment to start again. Authorized `/stop`, `/new`, and `/reset` cancel this conversation's pending attachments and suppress their delayed completion events. This change does not add durable inbound replay or recovery after a crash.

## Configuration

### Multiple accounts

Run the login command again for each account:

```bash
openclaw channels login --channel openclaw-weixin
```

When multiple accounts are logged in, isolate direct-message sessions by account, channel, and peer:

```bash
openclaw config set session.dmScope per-account-channel-peer
```

### Custom BotAgent

Set an optional identifier for backend log attribution and monitoring:

```json
{
  "channels": {
    "openclaw-weixin": {
      "botAgent": "MyBot/1.2.0"
    }
  }
}
```

`botAgent` is used for observability only. It is not an authentication credential and does not control message routing.

**Format** (UA-style):

- One or more `Name/Version` tokens, space-separated
- Each token may optionally be followed by ` (comment)`
- ASCII only; total length ≤ 256 bytes
- Invalid tokens are silently dropped during sanitization; falls back to
  `OpenClaw` if nothing valid remains

Examples that pass through unchanged:

- `MyBot/1.2.0`
- `MyBot/1.2.0 (region=cn;env=prod)`
- `MyBot/1.2.0 LangChain/0.3.5`
- `MyBot/1.2.0-rc.1+build.5`

**Note**: `bot_agent` is for observability only — it is not used for
authentication or routing. All registered agents on this plugin instance
currently share the same `botAgent` declaration; per-agent overrides may be
added in a future version if needed.

## Local quote cache

Newer WeChat clients may send only a server message ID for a quoted message. The plugin
stores the required text and media metadata locally so later quotes can restore their
context. The cache is enabled by default and failures do not interrupt normal message
delivery.

Quoted text appears as a Markdown blockquote below the current message in OpenClaw's
chat history. The same text supplies model context without a second hidden copy.
Quotes retain up to 2,000 UTF-16 units; longer text keeps the beginning and end with
an `…[omitted]…` marker. Cache misses and expired attachments are shown explicitly.
The current request stays first when the UI collapses a long message. Existing chat
history is not rewritten.

Configure it under `channels.openclaw-weixin.quoteCache` when you need different
retention or size limits. The default limits are 30 days and 10,000 text records per
account, plus 7 days, 256 MiB per account, and 25 MiB per media file. See the
[local quote cache guide](./docs/quote-cache_zh_CN.md) for the complete configuration,
storage behavior, and validation details.

## Uninstall

```bash
openclaw plugins uninstall @tencent-weixin/openclaw-weixin
```

## Troubleshooting

### The plugin reports an unsupported OpenClaw version

Check the host version:

```bash
openclaw --version
```

Upgrade OpenClaw to a supported version, then restart the Gateway.

### The channel shows `OK` but does not connect

Make sure the plugin is enabled and restart the Gateway:

```bash
openclaw config set plugins.entries.openclaw-weixin.enabled true
openclaw gateway restart
```

If the problem persists, inspect the Gateway log and verify that the account has completed QR-code login.

## Documentation

| Need | Start here |
| --- | --- |
| Backend integration | [Weixin backend API protocol](./docs/protocol.md) |
| CI and local quality checks | [CI guide](./docs/ci.md) |
| Development and local validation | [Development guide](./docs/development.md) |
| OpenClaw channel configuration | [OpenClaw channels](https://docs.openclaw.ai/channels) |
| Release history | [CHANGELOG.md](./CHANGELOG.md) |

The backend protocol document is intended for developers implementing or integrating a compatible backend. It is not required for normal plugin installation.

## Development

This repository uses npm and requires Node.js `>=22.13.0`.

```bash
npm ci --ignore-scripts --include=dev
npm run ci
```

Run coverage separately when changing behavior or tests:

```bash
npm run test:coverage
```

Pull requests run the same quality, unit-test, coverage, build, and package smoke checks in GitHub Actions. See the [CI guide](./docs/ci.md) for details.

See the [development guide](./docs/development.md) for the complete worktree, dependency, packaging, and local installation workflow.

## Contributing

Bug reports, documentation improvements, tests, and code contributions are welcome. Please keep pull requests focused and include validation details. For changes to the backend integration, update the [protocol documentation](./docs/protocol.md) together with the implementation.

## Maintainer

If you run into a problem or have a question, feel free to contact me through [GitHub](https://github.com/zengyi1001). My profile includes email and WeChat contact information.

## License

[MIT](./LICENSE)
