import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

import { getUpdates, classifyFetchError } from "../api/api.js";
import { WeixinConfigManager } from "../api/config-cache.js";
import { STALE_TOKEN_ERRCODE, pauseSession, getRemainingPauseMs } from "../api/session-guard.js";
import { processOneMessage } from "../messaging/process-message.js";
import type { WeixinMessage } from "../api/types.js";
import { AttachmentTaskManager } from "../media/attachment-tasks.js";
import type { AttachmentTaskOptions, AttachmentTaskResult } from "../media/attachment-tasks.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
import { logger } from "../util/logger.js";
import type { Logger } from "../util/logger.js";
import { redactBody } from "../util/redact.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export type MonitorWeixinOpts = {
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  accountId: string;
  /** When non-empty, only messages whose from_user_id is in this list are processed. */
  allowFrom?: string[];
  config: import("openclaw/plugin-sdk/core").OpenClawConfig;
  runtime?: { log?: (msg: string) => void; error?: (msg: string) => void };
  /**
   * Gateway-injected channel runtime surface (reply/routing/session/media/commands/...).
   * Required for inbound message processing; provided by `ChannelGatewayContext.channelRuntime`.
   */
  channelRuntime: PluginRuntime["channel"];
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  /** Gateway status callback — called on each successful poll and inbound message. */
  setStatus?: (next: ChannelAccountSnapshot) => void;
  /** Internal tuning seam for bounded attachment workers. */
  attachmentOptions?: AttachmentTaskOptions;
};

/**
 * Long-poll loop: getUpdates -> normalize -> recordInboundSession -> dispatchReplyFromConfig.
 * Runs until abort.
 */
export async function monitorWeixinProvider(opts: MonitorWeixinOpts): Promise<void> {
  const {
    baseUrl,
    cdnBaseUrl,
    token,
    accountId,
    config,
    channelRuntime,
    abortSignal,
    longPollTimeoutMs,
    setStatus,
  } = opts;
  const log = opts.runtime?.log ?? (() => {});
  const errLog = opts.runtime?.error ?? ((m: string) => log(m));
  const aLog: Logger = logger.withAccount(accountId);

  if (!channelRuntime) {
    const msg =
      "channelRuntime missing on monitor opts; gateway must inject ChannelGatewayContext.channelRuntime";
    aLog.error(msg);
    throw new Error(msg);
  }

  log(`weixin monitor started (${baseUrl}, account=${accountId})`);
  aLog.info(
    `Monitor started: baseUrl=${baseUrl} timeoutMs=${longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS}`,
  );

  const syncFilePath = getSyncBufFilePath(accountId);
  aLog.debug(`syncFilePath: ${syncFilePath}`);

  const previousGetUpdatesBuf = loadGetUpdatesBuf(syncFilePath);
  let getUpdatesBuf = previousGetUpdatesBuf ?? "";

  if (previousGetUpdatesBuf) {
    log(`[weixin] resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
    aLog.debug(`Using previous get_updates_buf (${getUpdatesBuf.length} bytes)`);
  } else {
    log(`[weixin] no previous sync buf, starting fresh`);
    aLog.info(`No previous get_updates_buf found, starting fresh`);
  }

  const configManager = new WeixinConfigManager({ baseUrl, token }, log);
  const attachments = new AttachmentTaskManager(accountId, opts.attachmentOptions);
  const lanes = new Map<string, Promise<void>>();
  const active = new Set<Promise<void>>();
  const typingTickets = new Map<string, string>();
  const configRefresh = new Map<string, Promise<void>>();
  let stopped = false;
  let pendingPreparations = 0;
  const enqueue = (full: WeixinMessage, attachmentEvent?: AttachmentTaskResult): void => {
    if (stopped || abortSignal?.aborted) return;
    const senderId = full.from_user_id ?? "";
    pendingPreparations++;
    const previous = lanes.get(senderId) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (stopped || abortSignal?.aborted) {
        pendingPreparations--;
        return;
      }
      let release!: () => void;
      let released = false;
      const admitted = new Promise<void>((resolve) => {
        release = resolve;
      });
      const onAdmitted = () => {
        if (released) return;
        released = true;
        pendingPreparations--;
        release();
      };
      // Typing is optional: an uncached config request must not block admission.
      if (!attachmentEvent && !configRefresh.has(senderId)) {
        const refresh = configManager
          .getForUser(senderId, full.context_token)
          .then((cached) => {
            if (!stopped) typingTickets.set(senderId, cached.typingTicket);
          })
          .catch(() => {})
          .finally(() => {
            configRefresh.delete(senderId);
          });
        configRefresh.set(senderId, refresh);
      }
      const run = processOneMessage(full, {
        accountId,
        config,
        channelRuntime,
        baseUrl,
        cdnBaseUrl,
        token,
        typingTicket: typingTickets.get(senderId),
        log,
        errLog,
        abortSignal,
        attachments,
        attachmentEvent,
        onAdmitted,
        enqueueAttachmentEvent: (message, result) => enqueue(message, result),
      })
        .catch((error) => {
          if (!stopped && !abortSignal?.aborted)
            errLog(`weixin inbound processing failed: ${String(error)}`);
        })
        .finally(() => {
          onAdmitted();
          active.delete(run);
        });
      active.add(run);
      await admitted;
    });
    lanes.set(senderId, next);
    void next.finally(() => {
      if (lanes.get(senderId) === next) lanes.delete(senderId);
    });
  };

  let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  try {
    while (!abortSignal?.aborted) {
      try {
        aLog.debug(
          `getUpdates: get_updates_buf=${getUpdatesBuf.substring(0, 50)}..., timeoutMs=${nextTimeoutMs}`,
        );
        const resp = await getUpdates({
          baseUrl,
          token,
          get_updates_buf: getUpdatesBuf,
          timeoutMs: nextTimeoutMs,
          // Stop/hot-reload should cancel the in-flight long-poll immediately
          // instead of waiting for the server-side long-poll timeout.
          abortSignal,
        });
        aLog.debug(
          `getUpdates response: ret=${resp.ret}, msgs=${resp.msgs?.length ?? 0}, get_updates_buf_length=${resp.get_updates_buf?.length ?? 0}`,
        );

        if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
          nextTimeoutMs = resp.longpolling_timeout_ms;
          aLog.debug(`Updated next poll timeout: ${nextTimeoutMs}ms`);
        }
        const isApiError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);
        if (isApiError) {
          const isStaleToken =
            resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE;

          if (isStaleToken) {
            pauseSession(accountId);
            const pauseMs = getRemainingPauseMs(accountId);
            aLog.error(
              `getUpdates: token for ${accountId} is stale, pausing all requests for ${Math.ceil(pauseMs / 60_000)} min`,
            );
            consecutiveFailures = 0;
            await sleep(pauseMs, abortSignal);
            continue;
          }

          consecutiveFailures += 1;
          errLog(
            `weixin getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
          );
          aLog.error(
            `getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg} response=${redactBody(JSON.stringify(resp))}`,
          );
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            errLog(
              `weixin getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
            );
            aLog.error(
              `getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
            );
            consecutiveFailures = 0;
            await sleep(BACKOFF_DELAY_MS, abortSignal);
          } else {
            await sleep(RETRY_DELAY_MS, abortSignal);
          }
          continue;
        }
        consecutiveFailures = 0;
        setStatus?.({ accountId, lastEventAt: Date.now() });
        if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
          saveGetUpdatesBuf(syncFilePath, resp.get_updates_buf);
          getUpdatesBuf = resp.get_updates_buf;
          aLog.debug(`Saved new get_updates_buf (${getUpdatesBuf.length} bytes)`);
        }
        const list = resp.msgs ?? [];
        for (const full of list) {
          aLog.info(
            `inbound message: from=${full.from_user_id} types=${full.item_list?.map((i) => i.type).join(",") ?? "none"}`,
          );

          const now = Date.now();
          setStatus?.({ accountId, lastEventAt: now, lastInboundAt: now });

          // allowFrom filtering is delegated to processOneMessage via the framework
          // authorization pipeline (resolveSenderCommandAuthorizationWithRuntime).

          // Only overload backpressure can pause polling; attachments and active
          // model turns never occupy the preparation lane after Core admission.
          while (pendingPreparations >= 256 && !abortSignal?.aborted) await sleep(25, abortSignal);
          enqueue(full);
        }
      } catch (err) {
        if (abortSignal?.aborted) {
          aLog.info(`Monitor stopped (aborted)`);
          return;
        }
        consecutiveFailures += 1;
        const classified = classifyFetchError(err);
        errLog(
          `weixin getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)} type=${classified.type} description=${classified.description}${classified.code ? ` code=${classified.code}` : ""}`,
        );
        aLog.error(
          `getUpdates error: ${String(err)}, type=${classified.type} code=${classified.code ?? "none"}, stack=${(err as Error).stack}`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          errLog(
            `weixin getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
          );
          aLog.error(
            `getUpdates: ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`,
          );
          consecutiveFailures = 0;
          await sleep(30_000, abortSignal);
        } else {
          await sleep(2000, abortSignal);
        }
      }
    }
  } finally {
    stopped = true;
    await attachments.close();
    // Core receives the same cancellation signal; do not leave account work
    // running after its monitor and quote-store lifecycle have ended.
    await Promise.allSettled(active);
  }
  aLog.info(`Monitor ended`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
