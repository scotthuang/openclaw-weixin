import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MessageItemType } from "../api/types.js";
import type { WeixinMessage } from "../api/types.js";
import type { WeixinMsgContext } from "./inbound.js";
import { processOneMessage } from "./process-message.js";
import type { ProcessMessageDeps } from "./process-message.js";
import type { QuoteMessageInput, QuoteMessageRecord } from "./quote-store.js";

const mocked = vi.hoisted(() => ({
  authorize: vi.fn(),
  quotePut: vi.fn(),
  quoteFind: vi.fn(),
  send: vi.fn(),
  stateDir: "",
}));

vi.mock("../api/api.js", () => ({ sendTyping: vi.fn() }));
vi.mock("../util/logger.js", () => {
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: { ...logger, withAccount: () => logger } };
});
vi.mock("../storage/state-dir.js", () => ({ resolveStateDir: () => mocked.stateDir }));
vi.mock("../auth/accounts.js", () => ({ loadWeixinAccount: () => ({ userId: "proof-user" }) }));
vi.mock("../auth/pairing.js", () => ({ readFrameworkAllowFromList: () => ["proof-user"] }));
vi.mock("./authorization.js", () => ({ resolveWeixinInboundAuthorization: mocked.authorize }));
vi.mock("./quote-store.js", () => ({
  getActiveQuoteMediaSubdir: () => "inbound",
  getQuoteStore: () => ({ put: mocked.quotePut, find: mocked.quoteFind }),
}));
vi.mock("./typing.js", () => ({ loadTypingCallbacksFactory: async () => () => ({}) }));
vi.mock("./send.js", () => ({ sendMessageWeixin: mocked.send }));
vi.mock("./debug-mode.js", () => ({ isDebugMode: () => false, toggleDebugMode: vi.fn() }));

const accountId = "visible-quote-proof";
const sessionKey = "agent:proof:weixin:proof-user";
const quoteToken = "QuotedContentSentinel42";
const question = "请解释这条引用消息。";

function message(text: string, id: string, referenceId?: string): WeixinMessage {
  return {
    from_user_id: "proof-user",
    message_id: id,
    item_list: [
      {
        type: MessageItemType.TEXT,
        text_item: { text },
        ...(referenceId ? { ref_msg: { svr_id: referenceId } } : {}),
      },
    ],
  };
}

describe("visible Weixin quotes through message admission", () => {
  let directory: string;
  let records: Map<string, QuoteMessageRecord>;
  let contexts: WeixinMsgContext[];
  let deps: ProcessMessageDeps;
  let cancelScope: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await mkdtemp(path.join(os.tmpdir(), "weixin-visible-quote-entry-"));
    mocked.stateDir = directory;
    records = new Map();
    contexts = [];
    mocked.authorize.mockResolvedValue({ senderAllowed: true, commandAuthorized: true });
    mocked.quoteFind.mockImplementation((_account, _conversation, id) => records.get(id));
    mocked.quotePut.mockImplementation(async (input: QuoteMessageInput) => {
      records.set(input.messageId, input);
    });
    cancelScope = vi.fn();
    deps = {
      accountId,
      config: { channels: { "openclaw-weixin": { replyProgressMessages: false } } },
      baseUrl: "https://unused.invalid",
      cdnBaseUrl: "https://unused.invalid",
      log: vi.fn(),
      errLog: vi.fn(),
      attachments: { cancelScope } as unknown as ProcessMessageDeps["attachments"],
      channelRuntime: {
        commands: {},
        routing: {
          resolveAgentRoute: () => ({ agentId: "proof", sessionKey, mainSessionKey: sessionKey }),
        },
        session: {
          resolveStorePath: () => path.join(directory, "sessions.json"),
          recordInboundSession: vi.fn(async () => {}),
        },
        reply: {
          finalizeInboundContext,
          resolveHumanDelayConfig: () => undefined,
          createReplyDispatcherWithTyping: () => ({
            dispatcher: {},
            replyOptions: {},
            markDispatchIdle: vi.fn(),
          }),
          withReplyDispatcher: async ({ run }: { run: () => Promise<unknown> }) => run(),
          dispatchReplyFromConfig: async ({ ctx }: { ctx: WeixinMsgContext }) => {
            contexts.push(ctx);
          },
        },
      } as unknown as ProcessMessageDeps["channelRuntime"],
    };
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function cacheQuote(body: string, extra: Partial<QuoteMessageRecord> = {}) {
    const record: QuoteMessageRecord = {
      accountId,
      conversationId: "proof-user",
      messageId: "weixin-source-42",
      direction: "outbound",
      body,
      createdAt: Date.now(),
      ...extra,
    };
    records.set(record.messageId, record);
    return record.messageId;
  }

  it("persists a visible quote once through real Core and keeps the quote cache unnested", async () => {
    const referenceId = cacheQuote(`${quoteToken}\n/new`);
    await processOneMessage(message(question, "weixin-current-43", referenceId), deps);
    expect(contexts).toHaveLength(1);
    const ctx = contexts[0];
    expect(ctx.Body).toBe(`> **引用的微信消息**\n>\n> ${quoteToken}\n> /new\n\n${question}`);
    expect(ctx).toMatchObject({
      ReplyToId: referenceId,
      ReplyToIsQuote: true,
      CommandBody: question,
    });
    expect(ctx.BodyForAgent).toBe(ctx.Body);
    expect(ctx.ReplyToBody).toBeUndefined();
    expect(ctx.ReplyToQuoteText).toBeUndefined();
    expect(cancelScope).not.toHaveBeenCalled();
    expect(mocked.authorize).toHaveBeenCalledWith(expect.objectContaining({ rawBody: question }));
    expect(records.get("weixin-current-43")?.body).toBe(question);

    const fixture = fileURLToPath(
      new URL("../../test/fixtures/core-visible-quote.mjs", import.meta.url),
    );
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [fixture, JSON.stringify({ context: ctx, quoteToken })],
      { timeout: 40_000, maxBuffer: 1024 * 1024 },
    );
    const line = stdout
      .split("\n")
      .find((value) => value.startsWith("WEIXIN_VISIBLE_QUOTE_RESULT:"));
    expect(line, stderr || stdout).toBeDefined();
    const proof = JSON.parse(line!.slice("WEIXIN_VISIBLE_QUOTE_RESULT:".length));
    expect(proof.requestPath).toBe("/v1/chat/completions");
    expect(proof.promptQuoteOccurrences).toBe(1);
    expect(proof.transcriptText).toContain(ctx.Body);

    await processOneMessage(message("继续解释", "weixin-current-44", "weixin-current-43"), deps);
    expect(contexts[1].Body).toBe(`> **引用的微信消息**\n>\n> ${question}\n\n继续解释`);
    expect(contexts[1].Body).not.toContain(quoteToken);
    expect(records.get("weixin-current-44")?.body).toBe("继续解释");
  }, 45_000);

  it("keeps current slash commands separate from quoted slash commands", async () => {
    const referenceId = cacheQuote("/new");
    await processOneMessage(message("/stop", "weixin-stop", referenceId), deps);
    expect(cancelScope).toHaveBeenCalledExactlyOnceWith({
      accountId,
      senderId: "proof-user",
      sessionKey,
      agentId: "proof",
    });
    expect(contexts[0].CommandBody).toBe("/stop");
    expect(contexts[0].CommandAuthorized).toBe(true);
    expect(contexts[0].Body).toMatch(/\n\n\/stop$/);

    await processOneMessage(message("/echo current command", "weixin-echo", referenceId), deps);
    expect(mocked.send).toHaveBeenCalledWith(expect.objectContaining({ text: "current command" }));
    expect(contexts).toHaveLength(1);
  });

  it("preserves referenced media and tool access context at the Core boundary", async () => {
    const mediaPath = path.join(directory, "quoted-report.txt");
    await writeFile(mediaPath, "Synthetic quoted attachment.");
    const referenceId = cacheQuote("[文件]", {
      mediaPath,
      mediaMime: "text/plain",
      mediaName: "report.txt",
    });
    await processOneMessage(message("读取这个附件", "weixin-file-question", referenceId), deps);
    expect(contexts[0]).toMatchObject({
      ReplyToId: referenceId,
      ReplyToIsQuote: true,
      MediaPaths: [mediaPath],
      MediaTypes: ["text/plain"],
      media: [
        {
          path: mediaPath,
          contentType: "text/plain",
          fileName: "report.txt",
          messageId: referenceId,
        },
      ],
    });
    expect(contexts[0].ChannelPromptContext?.join("\n")).toContain(
      "Quoted attachment tool access:",
    );
    expect(contexts[0].ChannelPromptContext?.join("\n")).toContain(mediaPath);
    expect(contexts[0].ReplyToBody).toBeUndefined();
  });

  it("leaves an ordinary message's body and command input unchanged", async () => {
    await processOneMessage(message(question, "weixin-no-quote"), deps);
    expect(contexts[0]).toMatchObject({ Body: question, CommandBody: question });
    expect(contexts[0].ReplyToIsQuote).toBeUndefined();
    expect(records.get("weixin-no-quote")?.body).toBe(question);
  });
});
