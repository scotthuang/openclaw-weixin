import { randomUUID } from "node:crypto";

import { CdnDownloadError } from "../cdn/pic-decrypt.js";
import type { CdnDownloadProgress } from "../cdn/pic-decrypt.js";
import type { WeixinInboundMediaOpts } from "../messaging/inbound.js";
import { logger } from "../util/logger.js";

export type AttachmentScope = {
  accountId: string;
  senderId: string;
  sessionKey: string;
  agentId: string;
};

export type AttachmentTaskSnapshot = AttachmentScope & {
  id: string;
  messageId?: string;
  fileName: string;
  status: "queued" | "downloading" | "retrying" | "ready" | "failed" | "cancelled";
  receivedBytes: number;
  totalBytes?: number;
  attempt: number;
  maxAttempts: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
};

export type AttachmentTaskResult = {
  task: AttachmentTaskSnapshot;
  media?: WeixinInboundMediaOpts;
};

type TaskRequest = {
  scope: AttachmentScope;
  messageId?: string;
  fileName: string;
  run: (
    signal: AbortSignal,
    onProgress: (progress: CdnDownloadProgress) => void,
  ) => Promise<WeixinInboundMediaOpts>;
  onSettled: (result: AttachmentTaskResult) => void;
};

export type AttachmentTaskOptions = {
  concurrency?: number;
  maxPending?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  retentionMs?: number;
  maxRecords?: number;
};

type Task = {
  snapshot: AttachmentTaskSnapshot;
  controller: AbortController;
  request?: TaskRequest;
  started: boolean;
};

const managers = new Map<string, AttachmentTaskManager>();
const terminal = (task: AttachmentTaskSnapshot) =>
  task.status === "ready" || task.status === "failed" || task.status === "cancelled";
const sameScope = (a: AttachmentScope, b: AttachmentScope) =>
  a.accountId === b.accountId &&
  a.senderId === b.senderId &&
  a.sessionKey === b.sessionKey &&
  a.agentId === b.agentId;

/** In-memory, account-owned tasks. Restart recovery is deliberately not implied. */
export class AttachmentTaskManager {
  private tasks = new Map<string, Task>();
  private active = new Set<Promise<void>>();
  private closed = false;
  private options: Required<AttachmentTaskOptions>;

  constructor(
    readonly accountId: string,
    options: AttachmentTaskOptions = {},
  ) {
    this.options = {
      concurrency: 2,
      maxPending: 32,
      maxAttempts: 3,
      retryDelayMs: 1_000,
      retentionMs: 60 * 60_000,
      maxRecords: 256,
      ...options,
    };
    // A replacement account monitor fences its predecessor's downloads and callbacks.
    void managers.get(accountId)?.close();
    managers.set(accountId, this);
  }

  create(request: TaskRequest): {
    task: AttachmentTaskSnapshot;
    created: boolean;
    start: () => void;
  } {
    if (this.closed) throw new Error("Attachment monitor is stopped");
    if (request.scope.accountId !== this.accountId) throw new Error("Attachment account mismatch");
    this.prune();
    const duplicate =
      request.messageId &&
      [...this.tasks.values()].find(
        (task) =>
          task.snapshot.messageId === request.messageId && sameScope(task.snapshot, request.scope),
      );
    if (duplicate) return { task: { ...duplicate.snapshot }, created: false, start: () => {} };
    const now = Date.now();
    const snapshot: AttachmentTaskSnapshot = {
      ...request.scope,
      id: randomUUID(),
      messageId: request.messageId,
      fileName: request.fileName.slice(0, 256),
      status: "queued",
      receivedBytes: 0,
      attempt: 0,
      maxAttempts: this.options.maxAttempts,
      createdAt: now,
      updatedAt: now,
    };
    if (
      [...this.tasks.values()].filter((task) => !terminal(task.snapshot)).length >=
      this.options.maxPending
    ) {
      snapshot.status = "failed";
      snapshot.error = "附件下载队列已满，请稍后重新发送此附件。";
    }
    const task: Task = { snapshot, controller: new AbortController(), request, started: false };
    this.tasks.set(snapshot.id, task);
    this.prune();
    return {
      task: { ...snapshot },
      created: true,
      start: () => {
        if (task.started || this.closed) return;
        task.started = true;
        if (terminal(snapshot)) {
          task.request = undefined;
          return;
        }
        this.pump();
      },
    };
  }

  read(scope: AttachmentScope, taskId?: string): AttachmentTaskSnapshot[] {
    this.prune();
    return [...this.tasks.values()]
      .filter(({ snapshot }) => sameScope(snapshot, scope) && (!taskId || snapshot.id === taskId))
      .sort((a, b) => b.snapshot.createdAt - a.snapshot.createdAt)
      .map(({ snapshot }) => ({ ...snapshot }));
  }

  cancelScope(scope: AttachmentScope): void {
    for (const [id, task] of this.tasks) {
      if (sameScope(task.snapshot, scope)) {
        if (!terminal(task.snapshot)) this.cancel(task);
        this.tasks.delete(id);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const task of this.tasks.values()) if (!terminal(task.snapshot)) this.cancel(task);
    if (managers.get(this.accountId) === this) managers.delete(this.accountId);
    await Promise.allSettled(this.active);
    this.tasks.clear();
  }

  private cancel(task: Task): void {
    task.snapshot.status = "cancelled";
    task.snapshot.updatedAt = Date.now();
    task.controller.abort();
    task.request = undefined;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, task] of this.tasks) {
      if (terminal(task.snapshot) && now - task.snapshot.updatedAt >= this.options.retentionMs) {
        this.tasks.delete(id);
      }
    }
    for (const [id, task] of this.tasks) {
      if (this.tasks.size <= this.options.maxRecords) break;
      if (terminal(task.snapshot)) this.tasks.delete(id);
    }
  }

  private pump(): void {
    if (this.closed) return;
    for (const task of this.tasks.values()) {
      if (this.active.size >= this.options.concurrency) break;
      if (!task.started || task.snapshot.status !== "queued") continue;
      task.snapshot.status = "downloading";
      const operation = this.run(task).finally(() => {
        this.active.delete(operation);
        this.pump();
      });
      this.active.add(operation);
    }
  }

  private async run(task: Task): Promise<void> {
    const request = task.request;
    if (!request) return;
    const signal = task.controller.signal;
    let media: WeixinInboundMediaOpts | undefined;
    try {
      for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
        if (signal.aborted) return;
        Object.assign(task.snapshot, {
          status: "downloading",
          attempt,
          receivedBytes: 0,
          updatedAt: Date.now(),
        });
        delete task.snapshot.totalBytes;
        delete task.snapshot.error;
        try {
          media = await request.run(signal, (progress) => {
            if (signal.aborted) return;
            task.snapshot.receivedBytes = progress.receivedBytes;
            task.snapshot.totalBytes = progress.totalBytes;
            task.snapshot.updatedAt = Date.now();
          });
          if (signal.aborted) return;
          task.snapshot.status = "ready";
          break;
        } catch (error) {
          if (signal.aborted) return;
          task.snapshot.error =
            error instanceof CdnDownloadError
              ? error.message
              : "附件处理或保存失败，请重新发送附件。";
          if (
            !(error instanceof CdnDownloadError) ||
            !error.retryable ||
            attempt === this.options.maxAttempts
          ) {
            task.snapshot.status = "failed";
            break;
          }
          task.snapshot.status = "retrying";
          task.snapshot.updatedAt = Date.now();
          await waitForRetry(this.options.retryDelayMs * 2 ** (attempt - 1), signal);
        }
      }
      task.snapshot.updatedAt = Date.now();
      if (!this.closed && !signal.aborted) {
        try {
          request.onSettled({ task: { ...task.snapshot }, media });
        } catch {
          logger.error("Attachment completion could not be queued");
        }
      }
    } finally {
      task.request = undefined;
    }
  }
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function readAttachmentTasks(
  scope: AttachmentScope,
  taskId?: string,
): AttachmentTaskSnapshot[] {
  return managers.get(scope.accountId)?.read(scope, taskId) ?? [];
}
