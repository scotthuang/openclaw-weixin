import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";

import { readAttachmentTasks } from "./attachment-tasks.js";
import type { AttachmentScope } from "./attachment-tasks.js";

export const WEIXIN_ATTACHMENT_STATUS_TOOL = "weixin_attachment_status";

/** Bind visibility to the host's current inbound route, never to model-supplied ids. */
function resolveAttachmentScope(ctx: OpenClawPluginToolContext): AttachmentScope | undefined {
  if (ctx.messageChannel !== "openclaw-weixin") return undefined;
  const { agentAccountId, requesterSenderId, sessionKey, agentId } = ctx;
  if (
    !agentAccountId?.trim() ||
    !requesterSenderId?.trim() ||
    !sessionKey?.trim() ||
    !agentId?.trim()
  ) {
    return undefined;
  }
  return {
    accountId: agentAccountId,
    senderId: requesterSenderId,
    sessionKey,
    agentId,
  };
}

function readTaskId(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error("Expected an object with an optional taskId.");
  }
  if (Object.keys(params).some((key) => key !== "taskId")) {
    throw new Error(
      "Only taskId is accepted; attachment visibility is fixed to this conversation.",
    );
  }
  const taskId = (params as { taskId?: unknown }).taskId;
  if (taskId === undefined) return undefined;
  if (typeof taskId !== "string" || !taskId.trim() || taskId.length > 256) {
    throw new Error("taskId must be a non-empty string of at most 256 characters.");
  }
  return taskId.trim();
}

export function createWeixinAttachmentTool(ctx: OpenClawPluginToolContext): AnyAgentTool | null {
  const scope = resolveAttachmentScope(ctx);
  if (!scope) return null;

  return {
    name: WEIXIN_ATTACHMENT_STATUS_TOOL,
    label: "Weixin attachment status",
    description:
      "Read the current download status of Weixin attachments in this conversation. " +
      "Use this when the user asks whether a file has downloaded or why it failed. " +
      "Omit taskId to list retained tasks in this conversation. This tool does not start, retry, " +
      "cancel, or read files. receivedBytes counts transferred encrypted bytes for the current " +
      "attempt, not decrypted file size. Do not claim a percentage when totalBytes is absent. " +
      "A ready task has finished download, decryption, and saving; a separate completion event " +
      "provides the usable attachment. No matching task means unavailable status, not download success.",
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Optional attachment task id previously reported in this conversation.",
        },
      },
      additionalProperties: false,
    },
    resultContentSource: "network",
    async execute(_toolCallId, params) {
      const taskId = readTaskId(params);
      const tasks = readAttachmentTasks(scope, taskId).map((task) => ({
        id: task.id,
        fileName: task.fileName,
        status: task.status,
        receivedBytes: task.receivedBytes,
        ...(task.totalBytes !== undefined ? { totalBytes: task.totalBytes } : {}),
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        ...(task.error ? { error: task.error } : {}),
      }));
      const details = { tasks };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details,
      };
    },
  };
}

export function registerWeixinAttachmentTool(api: OpenClawPluginApi): void {
  api.registerTool(createWeixinAttachmentTool, { name: WEIXIN_ATTACHMENT_STATUS_TOOL });
}
