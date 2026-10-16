import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WeixinMessage } from "../api/types.js";
import { MessageItemType } from "../api/types.js";
import { encryptAesEcb } from "../cdn/aes-ecb.js";
import { readAttachmentTasks } from "../media/attachment-tasks.js";
import type { AttachmentScope } from "../media/attachment-tasks.js";
import { createWeixinAttachmentTool } from "../media/attachment-tool.js";
import { clearContextTokensForAccount, getContextToken } from "../messaging/inbound.js";
import { monitorWeixinProvider } from "./monitor.js";
import type { MonitorWeixinOpts } from "./monitor.js";

const mocked = vi.hoisted(() => ({
  getUpdates: vi.fn(),
  getConfig: vi.fn(),
  authorize: vi.fn(),
  quotePut: vi.fn(),
  stateDir: "",
}));

vi.mock("../api/api.js", () => ({
  getUpdates: mocked.getUpdates,
  getConfig: mocked.getConfig,
  sendTyping: vi.fn(),
  classifyFetchError: () => ({ type: "network", description: "test poll aborted" }),
}));
vi.mock("../util/logger.js", () => {
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { logger: { ...logger, withAccount: () => logger } };
});
vi.mock("../storage/sync-buf.js", () => ({
  getSyncBufFilePath: () => "/unused-test-sync-buf",
  loadGetUpdatesBuf: () => undefined,
  saveGetUpdatesBuf: vi.fn(),
}));
vi.mock("../storage/state-dir.js", () => ({ resolveStateDir: () => mocked.stateDir }));
vi.mock("../auth/accounts.js", () => ({ loadWeixinAccount: () => ({ userId: "alice" }) }));
vi.mock("../auth/pairing.js", () => ({ readFrameworkAllowFromList: () => ["alice"] }));
vi.mock("../messaging/authorization.js", () => ({
  resolveWeixinInboundAuthorization: mocked.authorize,
}));
vi.mock("../messaging/quote-store.js", () => ({
  getActiveQuoteMediaSubdir: () => "inbound",
  getQuoteStore: () => ({ put: mocked.quotePut, get: () => undefined }),
}));
vi.mock("../messaging/typing.js", () => ({
  loadTypingCallbacksFactory: async () => () => ({}),
}));
vi.mock("../messaging/outbound-hooks.js", () => ({
  applyWeixinMessageSendingHook: async (value: { text: string }) => value,
  emitWeixinMessageSent: vi.fn(),
}));
vi.mock("../messaging/slash-commands.js", () => ({
  handleSlashCommand: async () => ({ handled: false }),
}));
vi.mock("../messaging/debug-mode.js", () => ({ isDebugMode: () => false }));

type CapturedContext = {
  Body: string;
  CommandBody?: string;
  CommandInterpretationSuppressed?: boolean;
  MessageSid: string;
  MessageSidFull?: string;
  MediaPath?: string;
  SenderId?: string;
  ChannelPromptContext?: string[];
  context_token?: string;
};

const key = Buffer.from("0123456789abcdef");
const plaintext = Buffer.from(
  "A real encrypted attachment received over a controlled local CDN.\n",
);
const ciphertext = encryptAesEcb(plaintext, key);
let serial = 0;

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitFor(assertion: () => void) {
  return vi.waitFor(assertion, { timeout: 3_000, interval: 10 });
}

function fileMessage(url: string, id = "file-original", senderId = "alice"): WeixinMessage {
  return {
    from_user_id: senderId,
    message_id: id,
    item_list: [
      { type: MessageItemType.TEXT, text_item: { text: "Summarize this file when it is ready." } },
      {
        type: MessageItemType.FILE,
        file_item: {
          file_name: `${id}.txt`,
          len: String(plaintext.length),
          media: { full_url: url, aes_key: key.toString("base64") },
        },
      },
    ],
  };
}

function textMessage(text: string, id = "question"): WeixinMessage {
  return {
    from_user_id: "alice",
    message_id: id,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
  };
}

describe("background attachments through the monitor entry point", () => {
  let directory: string;
  let server: Server;
  let baseUrl: string;
  let requestHandler: (response: ServerResponse) => void;
  let requestCount: number;
  let controller: AbortController;
  let monitor: Promise<void> | undefined;
  let scope: AttachmentScope;
  let contexts: CapturedContext[];
  let dispatchHolds: Array<ReturnType<typeof deferred>>;
  let holdPendingTurn: boolean;
  let holdTurnBody: string | undefined;
  let holdAdmissionBody: string | undefined;
  let pendingAdmission: ReturnType<typeof deferred> | undefined;
  let admissionHold: ReturnType<typeof deferred> | undefined;
  let admissionMode: "adopted" | "deferred";
  let saveMedia: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await mkdtemp(path.join(os.tmpdir(), "weixin-attachment-acceptance-"));
    mocked.stateDir = directory;
    controller = new AbortController();
    contexts = [];
    dispatchHolds = [];
    holdPendingTurn = false;
    holdTurnBody = undefined;
    holdAdmissionBody = undefined;
    pendingAdmission = undefined;
    admissionHold = undefined;
    admissionMode = "adopted";
    requestCount = 0;
    scope = {
      accountId: `acceptance-${++serial}`,
      senderId: "alice",
      sessionKey: "agent:test:weixin:alice",
      agentId: "test",
    };
    mocked.getConfig.mockResolvedValue({ ret: 0, typing_ticket: "" });
    mocked.authorize.mockImplementation(async ({ senderId }: { senderId: string }) => ({
      senderAllowed: senderId === "alice",
      commandAuthorized: undefined,
    }));
    mocked.quotePut.mockResolvedValue(undefined);
    saveMedia = vi.fn(async (buffer: Buffer) => {
      const destination = path.join(directory, `download-${saveMedia.mock.calls.length}.txt`);
      await writeFile(destination, buffer);
      return { path: destination };
    });
    requestHandler = (response) => response.end(ciphertext);
    server = createServer((_request, response) => {
      requestCount++;
      requestHandler(response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local CDN address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    controller.abort();
    pendingAdmission?.resolve();
    admissionHold?.resolve();
    for (const hold of dispatchHolds) hold.resolve();
    server.closeAllConnections();
    await monitor;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    clearContextTokensForAccount(scope.accountId);
    await rm(directory, { recursive: true, force: true });
  });

  function start(
    batches: Array<WeixinMessage[] | (() => Promise<WeixinMessage[]>)>,
    attachmentOptions: MonitorWeixinOpts["attachmentOptions"] = {},
  ) {
    mocked.getUpdates.mockImplementation(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      const next = batches.shift();
      if (next) {
        const msgs =
          typeof next === "function"
            ? await Promise.race([
                next(),
                new Promise<WeixinMessage[]>((resolve) => {
                  if (abortSignal.aborted) resolve([]);
                  else abortSignal.addEventListener("abort", () => resolve([]), { once: true });
                }),
              ])
            : next;
        return { ret: 0, msgs };
      }
      await new Promise<void>((resolve) => {
        if (abortSignal.aborted) resolve();
        else abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new Error("Test long poll aborted");
    });
    const channelRuntime = {
      commands: { shouldComputeCommandAuthorized: () => false },
      routing: {
        resolveAgentRoute: () => ({
          agentId: scope.agentId,
          sessionKey: scope.sessionKey,
          mainSessionKey: scope.sessionKey,
        }),
      },
      media: { saveMediaBuffer: saveMedia },
      session: {
        resolveStorePath: () => path.join(directory, "session.json"),
        recordInboundSession: vi.fn(async () => {}),
      },
      reply: {
        finalizeInboundContext: (ctx: CapturedContext) => ctx,
        resolveHumanDelayConfig: () => undefined,
        createReplyDispatcherWithTyping: () => ({
          dispatcher: {},
          replyOptions: {},
          markDispatchIdle: vi.fn(),
        }),
        withReplyDispatcher: async ({ run }: { run: () => Promise<void> }) => run(),
        dispatchReplyFromConfig: async ({
          ctx,
          replyOptions,
        }: {
          ctx: CapturedContext;
          replyOptions: {
            turnAdoptionLifecycle?: { onAdopted?: () => void; onDeferred?: () => void };
            onAgentRunStart?: () => void;
          };
        }) => {
          contexts.push(structuredClone(ctx));
          if (pendingAdmission && ctx.Body.startsWith("[Weixin attachment pending]")) {
            await pendingAdmission.promise;
          }
          if (ctx.Body === holdAdmissionBody) await admissionHold?.promise;
          if (admissionMode === "deferred") replyOptions.turnAdoptionLifecycle?.onDeferred?.();
          else replyOptions.turnAdoptionLifecycle?.onAdopted?.();
          if (
            (holdPendingTurn && ctx.Body.startsWith("[Weixin attachment pending]")) ||
            ctx.Body === holdTurnBody
          ) {
            const hold = deferred();
            dispatchHolds.push(hold);
            await hold.promise;
          }
        },
      },
    };
    monitor = monitorWeixinProvider({
      accountId: scope.accountId,
      baseUrl,
      cdnBaseUrl: baseUrl,
      abortSignal: controller.signal,
      config: { channels: { "openclaw-weixin": { replyProgressMessages: false } } },
      channelRuntime: channelRuntime as never,
      attachmentOptions: { retryDelayMs: 5, ...attachmentOptions },
    });
  }

  it("lets a same-chat progress question reach Core while a real encrypted download and its first model turn remain open", async () => {
    const firstChunk = deferred();
    let response!: ServerResponse;
    requestHandler = (res) => {
      response = res;
      res.writeHead(200, { "content-length": ciphertext.length });
      res.write(ciphertext.subarray(0, 16));
      firstChunk.resolve();
    };
    holdPendingTurn = true;
    start([
      [fileMessage(baseUrl)],
      async () => {
        await firstChunk.promise;
        return [textMessage("How is the download going?")];
      },
    ]);

    await waitFor(() =>
      expect(contexts.some((ctx) => ctx.Body === "How is the download going?")).toBe(true),
    );
    await waitFor(() => expect(readAttachmentTasks(scope)[0]?.receivedBytes).toBe(16));
    const task = readAttachmentTasks(scope)[0];
    expect(task).toMatchObject({
      messageId: "file-original",
      status: "downloading",
      totalBytes: ciphertext.length,
      attempt: 1,
    });
    expect(contexts[0].Body).toContain("[Weixin attachment pending]");
    expect(contexts[0].Body).toContain("Summarize this file when it is ready.");
    expect(contexts[0].SenderId).toBe("alice");
    expect(contexts[0].MediaPath).toBeUndefined();
    expect(JSON.stringify(contexts[0].ChannelPromptContext)).toContain(task.id);
    const tool = createWeixinAttachmentTool({
      messageChannel: "openclaw-weixin",
      agentAccountId: scope.accountId,
      requesterSenderId: scope.senderId,
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
    } as never)!;
    const progress = await tool.execute("download-progress-query", { taskId: task.id });
    expect(progress.details).toMatchObject({
      tasks: [
        {
          id: task.id,
          status: "downloading",
          receivedBytes: 16,
          totalBytes: ciphertext.length,
        },
      ],
    });
    expect(readAttachmentTasks({ ...scope, senderId: "mallory" }, task.id)).toEqual([]);
    expect(readAttachmentTasks({ ...scope, accountId: "other-account" }, task.id)).toEqual([]);
    expect(saveMedia).not.toHaveBeenCalled();
    expect(dispatchHolds).toHaveLength(1);

    response.end(ciphertext.subarray(16));
    await waitFor(() =>
      expect(
        contexts.filter((ctx) => ctx.Body.startsWith("[Weixin attachment ready]")),
      ).toHaveLength(1),
    );
    const ready = contexts.find((ctx) => ctx.Body.startsWith("[Weixin attachment ready]"))!;
    expect(ready.Body).toContain(task.id);
    expect(ready.Body).toContain("file-original");
    expect(ready.Body).not.toContain("Summarize this file when it is ready.");
    expect(ready.MessageSid).not.toBe(contexts[0].MessageSid);
    expect(ready.MessageSidFull).not.toBe(contexts[0].MessageSidFull);
    expect(ready.CommandBody).toBe("");
    expect(ready.CommandInterpretationSuppressed).toBe(true);
    expect(await readFile(ready.MediaPath!)).toEqual(plaintext);
    expect(readAttachmentTasks(scope, task.id)[0].status).toBe("ready");
    expect(requestCount).toBe(1);
  });

  it("finishes a permanently failing attachment after bounded retries while later text is dispatched", async () => {
    requestHandler = (response) => {
      response.writeHead(503);
      response.end("temporary unavailable");
    };
    start([[fileMessage(baseUrl)], [textMessage("Keep talking while that file downloads.")]], {
      maxAttempts: 3,
    });

    await waitFor(() =>
      expect(contexts.some((ctx) => ctx.Body === "Keep talking while that file downloads.")).toBe(
        true,
      ),
    );
    await waitFor(() =>
      expect(
        contexts.filter((ctx) => ctx.Body.startsWith("[Weixin attachment failed]")),
      ).toHaveLength(1),
    );
    const task = readAttachmentTasks(scope)[0];
    expect(task).toMatchObject({
      status: "failed",
      attempt: 3,
      maxAttempts: 3,
      messageId: "file-original",
    });
    expect(requestCount).toBe(3);
    expect(saveMedia).not.toHaveBeenCalled();
    const failed = contexts.find((ctx) => ctx.Body.startsWith("[Weixin attachment failed]"))!;
    expect(failed.Body).toContain(task.id);
    expect(failed.Body).toContain("file-original");
    expect(failed.Body).not.toContain("Summarize this file when it is ready.");
    expect(failed.MediaPath).toBeUndefined();
    expect(contexts.some((ctx) => ctx.Body.startsWith("[Weixin attachment ready]"))).toBe(false);
  });

  it("keeps a quoted progress question attached to the existing download without fetching the file again", async () => {
    const firstChunk = deferred();
    let response!: ServerResponse;
    requestHandler = (res) => {
      response = res;
      res.writeHead(200, { "content-length": ciphertext.length });
      res.write(ciphertext.subarray(0, 16));
      firstChunk.resolve();
    };
    const original = fileMessage(baseUrl);
    const quotedQuestion = textMessage(
      "How is this quoted file download going?",
      "quoted-question",
    );
    quotedQuestion.item_list![0].ref_msg = {
      svr_id: "file-original",
      message_item: structuredClone(original.item_list![1]),
    };
    start([
      [original],
      async () => {
        await firstChunk.promise;
        return [quotedQuestion];
      },
    ]);

    await waitFor(() =>
      expect(
        contexts.some((ctx) => ctx.Body.includes("How is this quoted file download going?")),
      ).toBe(true),
    );
    await waitFor(() => expect(readAttachmentTasks(scope)[0]?.receivedBytes).toBe(16));
    const task = readAttachmentTasks(scope)[0];
    const question = contexts.find((ctx) =>
      ctx.Body.includes("How is this quoted file download going?"),
    )!;
    expect(question.MessageSidFull).toBe("quoted-question");
    expect(question.Body).toContain(task.id);
    expect(question.MediaPath).toBeUndefined();
    expect(readAttachmentTasks(scope)).toHaveLength(1);
    expect(requestCount).toBe(1);
    const result = await createWeixinAttachmentTool({
      messageChannel: "openclaw-weixin",
      agentAccountId: scope.accountId,
      requesterSenderId: scope.senderId,
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
    } as never)!.execute("quoted-progress-query", {});
    expect(result.details).toEqual({
      tasks: [
        expect.objectContaining({
          id: task.id,
          status: "downloading",
          receivedBytes: 16,
        }),
      ],
    });

    response.end(ciphertext.subarray(16));
    await waitFor(() =>
      expect(
        contexts.filter((ctx) => ctx.Body.startsWith("[Weixin attachment ready]")),
      ).toHaveLength(1),
    );
    const ready = contexts.find((ctx) => ctx.Body.startsWith("[Weixin attachment ready]"))!;
    expect(ready.Body).toContain('"originalMessageId":"file-original"');
    expect(ready.Body).not.toContain("quoted-question");
    expect(requestCount).toBe(1);
  });

  it("bounds concurrent downloads, keeps excess tasks queued, and aborts sockets without late completion events on stop", async () => {
    const responses: ServerResponse[] = [];
    let closed = 0;
    requestHandler = (response) => {
      responses.push(response);
      response.once("close", () => {
        closed++;
      });
      response.writeHead(200, { "content-length": ciphertext.length });
      response.write(ciphertext.subarray(0, 16));
    };
    start(
      [
        [fileMessage(baseUrl, "one"), fileMessage(baseUrl, "two"), fileMessage(baseUrl, "three")],
        [textMessage("These files must not block this question.")],
      ],
      { concurrency: 2, maxPending: 3 },
    );

    await waitFor(() =>
      expect(contexts.some((ctx) => ctx.Body === "These files must not block this question.")).toBe(
        true,
      ),
    );
    await waitFor(() => expect(responses).toHaveLength(2));
    expect(readAttachmentTasks(scope).filter((task) => task.status === "downloading")).toHaveLength(
      2,
    );
    expect(readAttachmentTasks(scope).filter((task) => task.status === "queued")).toHaveLength(1);
    controller.abort();
    await monitor;
    await waitFor(() => expect(closed).toBe(2));
    expect(requestCount).toBe(2);
    expect(readAttachmentTasks(scope)).toEqual([]);
    expect(saveMedia).not.toHaveBeenCalled();
    expect(contexts.filter((ctx) => /\[Weixin attachment (ready|failed)\]/.test(ctx.Body))).toEqual(
      [],
    );
  });

  it("rejects an unauthorized attachment before registering a task or contacting its CDN", async () => {
    start([
      [fileMessage(baseUrl, "forbidden", "mallory")],
      [textMessage("Only this authorized message reaches Core.")],
    ]);
    await waitFor(() =>
      expect(
        contexts.some((ctx) => ctx.Body === "Only this authorized message reaches Core."),
      ).toBe(true),
    );
    expect(requestCount).toBe(0);
    expect(saveMedia).not.toHaveBeenCalled();
    expect(readAttachmentTasks(scope)).toEqual([]);
    expect(readAttachmentTasks({ ...scope, senderId: "mallory" })).toEqual([]);
    expect(contexts).toHaveLength(1);
  });

  it("keeps a fast completion behind pending admission, deduplicates replay, and uses the latest reply token", async () => {
    pendingAdmission = deferred();
    const original = { ...fileMessage(baseUrl), context_token: "original-token" };
    const later = { ...textMessage("Use my latest reply route."), context_token: "latest-token" };
    start([[original, structuredClone(original), later]]);

    await waitFor(() => expect(readAttachmentTasks(scope)[0]?.status).toBe("ready"));
    await waitFor(() => expect(contexts).toHaveLength(1));
    expect(contexts[0].Body).toContain("[Weixin attachment pending]");
    expect(contexts[0].context_token).toBe("original-token");
    pendingAdmission.resolve();

    await waitFor(() => expect(contexts).toHaveLength(3));
    expect(contexts[1].Body).toBe("Use my latest reply route.");
    expect(contexts[2].Body).toContain("[Weixin attachment ready]");
    expect(contexts[2].context_token).toBe("latest-token");
    expect(getContextToken(scope.accountId, scope.senderId)).toBe("latest-token");
    expect(requestCount).toBe(1);
    expect(readAttachmentTasks(scope)).toHaveLength(1);
    const quoteUpdates = mocked.quotePut.mock.calls
      .map(([value]) => value)
      .filter((value) => value.messageId === "file-original");
    expect(quoteUpdates).toHaveLength(2);
    expect(quoteUpdates[0].sourceMediaPath).toBeUndefined();
    expect(quoteUpdates[1]).toMatchObject({
      messageId: "file-original",
      sourceMediaPath: contexts[2].MediaPath,
      body: "Summarize this file when it is ready.",
    });
  });

  it("continues receiving and admitting text when typing configuration hangs and Core defers the earlier turn", async () => {
    mocked.getConfig.mockReturnValue(new Promise(() => {}));
    admissionMode = "deferred";
    holdTurnBody = "The first turn stays pending in Core.";
    start([
      [textMessage(holdTurnBody, "first")],
      [textMessage("The second message must still reach Core.", "second")],
    ]);

    await waitFor(() => expect(contexts).toHaveLength(2));
    expect(contexts[1].Body).toBe("The second message must still reach Core.");
    expect(dispatchHolds).toHaveLength(1);
    expect(mocked.getConfig).toHaveBeenCalledOnce();
    expect(mocked.getUpdates.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("cancels active work and discards a ready completion queued behind an authorized conversation reset", async () => {
    const twoDownloads = deferred();
    const enqueueAfterReset = deferred();
    const responses: ServerResponse[] = [];
    let closed = 0;
    requestHandler = (response) => {
      responses.push(response);
      response.once("close", () => {
        closed++;
      });
      response.writeHead(200, { "content-length": ciphertext.length });
      response.write(ciphertext.subarray(0, 16));
      if (responses.length === 2) twoDownloads.resolve();
    };
    mocked.authorize.mockImplementation(
      async ({ senderId, rawBody }: { senderId: string; rawBody: string }) => ({
        senderAllowed: senderId === "alice",
        commandAuthorized: rawBody === "/new",
      }),
    );
    holdAdmissionBody = "Pause admission before resetting.";
    admissionHold = deferred();
    start([
      [fileMessage(baseUrl, "finishes-before-reset"), fileMessage(baseUrl, "still-downloading")],
      async () => {
        await twoDownloads.promise;
        return [textMessage(holdAdmissionBody!, "blocker"), textMessage("/new", "reset")];
      },
      async () => {
        await enqueueAfterReset.promise;
        return [textMessage("A fresh conversation after reset.", "after-reset")];
      },
    ]);
    await waitFor(() => expect(contexts.some((ctx) => ctx.Body === holdAdmissionBody)).toBe(true));
    responses[0].end(ciphertext.subarray(16));
    await waitFor(() =>
      expect(readAttachmentTasks(scope).some((task) => task.status === "ready")).toBe(true),
    );
    expect(contexts.some((ctx) => ctx.Body.startsWith("[Weixin attachment ready]"))).toBe(false);

    enqueueAfterReset.resolve();
    admissionHold.resolve();
    await waitFor(() =>
      expect(contexts.some((ctx) => ctx.Body === "A fresh conversation after reset.")).toBe(true),
    );
    await waitFor(() => expect(closed).toBe(2));
    expect(contexts.some((ctx) => ctx.Body === "/new")).toBe(true);
    expect(contexts.some((ctx) => ctx.Body.startsWith("[Weixin attachment ready]"))).toBe(false);
    expect(readAttachmentTasks(scope)).toEqual([]);
    expect(requestCount).toBe(2);
  });
});
