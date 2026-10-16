import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CdnDownloadError } from "../cdn/pic-decrypt.js";
import type { CdnDownloadProgress } from "../cdn/pic-decrypt.js";
import type { WeixinInboundMediaOpts } from "../messaging/inbound.js";

import { AttachmentTaskManager, readAttachmentTasks } from "./attachment-tasks.js";
import type { AttachmentScope, AttachmentTaskOptions } from "./attachment-tasks.js";

const scope: AttachmentScope = {
  accountId: "account-a",
  senderId: "sender-a",
  sessionKey: "agent:main:main",
  agentId: "main",
};

const managers: AttachmentTaskManager[] = [];
function manager(options?: AttachmentTaskOptions, accountId = scope.accountId) {
  const value = new AttachmentTaskManager(accountId, options);
  managers.push(value);
  return value;
}

function heldDownload() {
  let finish!: (media: WeixinInboundMediaOpts) => void;
  let progress!: (value: CdnDownloadProgress) => void;
  let signal!: AbortSignal;
  const run = vi.fn((abortSignal: AbortSignal, onProgress: typeof progress) => {
    signal = abortSignal;
    progress = onProgress;
    return new Promise<WeixinInboundMediaOpts>((resolve) => {
      const complete = (media: WeixinInboundMediaOpts) => {
        abortSignal.removeEventListener("abort", cancel);
        resolve(media);
      };
      const cancel = () => complete({});
      finish = complete;
      abortSignal.addEventListener("abort", cancel, { once: true });
      if (abortSignal.aborted) cancel();
    });
  });
  return {
    run,
    finish: (media: WeixinInboundMediaOpts = {}) => finish(media),
    progress: (value: CdnDownloadProgress) => progress(value),
    get signal() {
      return signal;
    },
  };
}

function request(overrides: Partial<Parameters<AttachmentTaskManager["create"]>[0]> = {}) {
  return {
    scope,
    fileName: "report.pdf",
    run: vi.fn(async () => ({ decryptedFilePath: "/tmp/report.pdf" })),
    onSettled: vi.fn(),
    ...overrides,
  };
}

describe("background attachment tasks", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((value) => value.close()));
    vi.useRealTimers();
  });

  it("publishes pending metadata before starting the network operation", async () => {
    const value = manager();
    const input = request();
    const pending = value.create(input);
    expect(pending.task).toMatchObject({ status: "queued", attempt: 0, receivedBytes: 0 });
    expect(readAttachmentTasks(scope)).toEqual([pending.task]);
    expect(input.run).not.toHaveBeenCalled();
    pending.start();
    pending.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(input.run).toHaveBeenCalledOnce();
    expect(input.onSettled).toHaveBeenCalledWith({
      task: expect.objectContaining({ id: pending.task.id, status: "ready" }),
      media: { decryptedFilePath: "/tmp/report.pdf" },
    });
  });

  it("bounds concurrent downloads and reports queue exhaustion without blocking admitted work", async () => {
    const value = manager({ concurrency: 2, maxPending: 3 });
    const downloads = [heldDownload(), heldDownload(), heldDownload(), heldDownload()];
    const pending = downloads.map((download) => value.create(request({ run: download.run })));
    pending.forEach((task) => task.start());
    expect(downloads.map((download) => download.run.mock.calls.length)).toEqual([1, 1, 0, 0]);
    expect(value.read(scope, pending[2].task.id)[0].status).toBe("queued");
    expect(pending[3].task).toMatchObject({
      status: "failed",
      error: expect.stringContaining("队列已满"),
    });
    downloads[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(downloads[2].run).toHaveBeenCalledOnce();
    expect(downloads[3].run).not.toHaveBeenCalled();
  });

  it("retries transient failures with a bounded backoff and resets each attempt's byte counts", async () => {
    const value = manager({ maxAttempts: 3, retryDelayMs: 10 });
    const run = vi.fn(
      async (_signal: AbortSignal, progress: (value: CdnDownloadProgress) => void) => {
        if (run.mock.calls.length === 1) {
          progress({ receivedBytes: 4, totalBytes: 16 });
          throw new CdnDownloadError("idle-timeout", true);
        }
        return { decryptedFilePath: "/tmp/report.pdf" };
      },
    );
    const input = request({ run });
    const task = value.create(input);
    task.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(value.read(scope)[0]).toMatchObject({
      status: "retrying",
      attempt: 1,
      receivedBytes: 4,
      totalBytes: 16,
    });
    await vi.advanceTimersByTimeAsync(9);
    expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    const finished = value.read(scope)[0];
    expect(finished).toMatchObject({ status: "ready", attempt: 2, receivedBytes: 0 });
    expect(finished.totalBytes).toBeUndefined();
    expect(finished.error).toBeUndefined();
    expect(input.onSettled).toHaveBeenCalledOnce();
  });

  it.each([
    { error: new CdnDownloadError("network", true), calls: 3, errorText: "network" },
    { error: new CdnDownloadError("http", false, 404), calls: 1, errorText: "404" },
    { error: new Error("secret signed URL"), calls: 1, errorText: "附件处理或保存失败" },
  ])(
    "ends failed downloads without infinite retries: $errorText",
    async ({ error, calls, errorText }) => {
      const value = manager({ maxAttempts: 3, retryDelayMs: 10 });
      const input = request({
        run: vi.fn(async () => {
          throw error;
        }),
      });
      value.create(input).start();
      await vi.advanceTimersByTimeAsync(100);
      expect(input.run).toHaveBeenCalledTimes(calls);
      expect(input.onSettled).toHaveBeenCalledOnce();
      expect(value.read(scope)[0]).toMatchObject({
        status: "failed",
        attempt: calls,
        error: expect.stringContaining(errorText),
      });
      expect(JSON.stringify(value.read(scope))).not.toContain("secret");
    },
  );

  it("limits cancellation to the requesting conversation, including queued tasks", async () => {
    const value = manager({ concurrency: 1 });
    const completed = value.create(request());
    completed.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(value.read(scope, completed.task.id)[0].status).toBe("ready");
    const current = heldDownload();
    const queued = heldDownload();
    const other = heldDownload();
    const settled = vi.fn();
    value.create(request({ run: current.run, onSettled: settled })).start();
    value.create(request({ run: queued.run, onSettled: settled })).start();
    const otherScope = { ...scope, senderId: "sender-b" };
    const otherTask = value.create(request({ scope: otherScope, run: other.run }));
    otherTask.start();
    value.cancelScope(scope);
    await vi.advanceTimersByTimeAsync(0);
    expect(current.signal.aborted).toBe(true);
    expect(queued.run).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(value.read(scope)).toEqual([]);
    expect(other.run).toHaveBeenCalledOnce();
    expect(other.signal.aborted).toBe(false);
  });

  it("cancels retry waits and suppresses completion callbacks when its monitor closes", async () => {
    const value = manager({ retryDelayMs: 60_000 });
    const input = request({
      run: vi.fn(async () => {
        throw new CdnDownloadError("network", true);
      }),
    });
    value.create(input).start();
    await vi.advanceTimersByTimeAsync(0);
    expect(value.read(scope)[0].status).toBe("retrying");
    await value.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(input.run).toHaveBeenCalledOnce();
    expect(input.onSettled).not.toHaveBeenCalled();
    expect(readAttachmentTasks(scope)).toEqual([]);
    expect(() => value.create(request())).toThrow("stopped");
  });

  it("fences replaced account monitors without deleting the replacement registry", async () => {
    const old = manager();
    const download = heldDownload();
    const settled = vi.fn();
    old.create(request({ run: download.run, onSettled: settled })).start();
    const replacement = manager();
    const current = replacement.create(request());
    await old.close();
    expect(download.signal.aborted).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    expect(readAttachmentTasks(scope)).toEqual([current.task]);
  });

  it("isolates every scope field and returns detached snapshots", () => {
    const value = manager();
    const own = value.create(request());
    for (const field of ["senderId", "sessionKey", "agentId"] as const) {
      const different = { ...scope, [field]: `other-${field}` };
      value.create(request({ scope: different }));
      expect(value.read(different)).toHaveLength(1);
      expect(value.read(different, own.task.id)).toEqual([]);
    }
    const otherScope = { ...scope, accountId: "account-b" };
    const other = manager({}, otherScope.accountId);
    other.create(request({ scope: otherScope }));
    expect(other.read(scope)).toEqual([]);
    expect(() => value.create(request({ scope: otherScope }))).toThrow("account mismatch");
    const read = readAttachmentTasks(scope);
    expect(read).toHaveLength(1);
    read[0].status = "ready";
    own.task.status = "failed";
    expect(readAttachmentTasks(scope)[0].status).toBe("queued");
  });

  it("deduplicates provider message ids within the complete scope only", async () => {
    const value = manager();
    const input = request({ messageId: "message-a" });
    const first = value.create(input);
    const repeated = value.create(request({ messageId: "message-a", fileName: "different.pdf" }));
    expect(repeated.created).toBe(false);
    expect(repeated.task.id).toBe(first.task.id);
    repeated.start();
    expect(input.run).not.toHaveBeenCalled();
    first.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(value.create(input).created).toBe(false);
    expect(
      value.create(request({ messageId: "message-a", scope: { ...scope, senderId: "sender-b" } }))
        .created,
    ).toBe(true);
    expect(value.create(request()).task.id).not.toBe(value.create(request()).task.id);
  });

  it("expires old terminal records while retaining ongoing downloads", async () => {
    const value = manager({ retentionMs: 50 });
    const active = heldDownload();
    const ongoing = value.create(request({ run: active.run }));
    ongoing.start();
    const complete = value.create(request());
    complete.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(value.read(scope).map((task) => task.id)).toEqual([ongoing.task.id]);
    expect(value.read(scope, complete.task.id)).toEqual([]);
  });

  it("bounds retained terminal records without evicting active downloads", async () => {
    const value = manager({ maxRecords: 2 });
    const active = heldDownload();
    const ongoing = value.create(request({ run: active.run }));
    ongoing.start();
    const oldest = value.create(request());
    oldest.start();
    await vi.advanceTimersByTimeAsync(0);
    const newest = value.create(request());
    newest.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(
      value
        .read(scope)
        .map((task) => task.id)
        .sort(),
    ).toEqual([ongoing.task.id, newest.task.id].sort());
    expect(value.read(scope, oldest.task.id)).toEqual([]);
  });

  it("keeps a completed download ready and frees its slot when completion notification throws", async () => {
    const value = manager({ concurrency: 1 });
    const first = request({
      onSettled: vi.fn(() => {
        throw new Error("notification could not be queued");
      }),
    });
    const second = request();
    const firstTask = value.create(first);
    const secondTask = value.create(second);
    firstTask.start();
    secondTask.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.run).toHaveBeenCalledOnce();
    expect(first.onSettled).toHaveBeenCalledOnce();
    expect(value.read(scope, firstTask.task.id)[0].status).toBe("ready");
    expect(second.run).toHaveBeenCalledOnce();
    expect(second.onSettled).toHaveBeenCalledOnce();
    expect(value.read(scope, secondTask.task.id)[0].status).toBe("ready");
  });
});
