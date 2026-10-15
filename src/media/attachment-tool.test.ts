import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";

const { readAttachmentTasks } = vi.hoisted(() => ({ readAttachmentTasks: vi.fn() }));
vi.mock("./attachment-tasks.js", () => ({ readAttachmentTasks }));

import {
  createWeixinAttachmentTool,
  registerWeixinAttachmentTool,
  WEIXIN_ATTACHMENT_STATUS_TOOL,
} from "./attachment-tool.js";

function context(overrides: Partial<OpenClawPluginToolContext> = {}): OpenClawPluginToolContext {
  return {
    messageChannel: "openclaw-weixin",
    agentAccountId: "account-a",
    requesterSenderId: "sender-a",
    sessionKey: "agent:main:main",
    agentId: "main",
    ...overrides,
  };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-a",
    accountId: "account-a",
    senderId: "sender-a",
    sessionKey: "agent:main:main",
    agentId: "main",
    messageId: "message-a",
    fileName: "report.pdf",
    status: "downloading",
    receivedBytes: 1024,
    attempt: 1,
    maxAttempts: 3,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe("Weixin attachment status tool", () => {
  beforeEach(() => {
    readAttachmentTasks.mockReset().mockReturnValue([]);
  });

  it.each([
    { messageChannel: "telegram" },
    { messageChannel: undefined },
    { agentAccountId: undefined },
    { requesterSenderId: undefined },
    { sessionKey: undefined },
    { agentId: undefined },
    { agentAccountId: " " },
    { requesterSenderId: " " },
    { sessionKey: " " },
    { agentId: " " },
  ])("is unavailable without a complete trusted Weixin scope: %j", (overrides) => {
    expect(createWeixinAttachmentTool(context(overrides))).toBeNull();
    expect(readAttachmentTasks).not.toHaveBeenCalled();
  });

  it("keeps each sender isolated even when the host shares a main session", async () => {
    const alice = createWeixinAttachmentTool(context())!;
    const bob = createWeixinAttachmentTool(context({ requesterSenderId: "sender-b" }))!;
    await alice.execute("call-a", {});
    await bob.execute("call-b", { taskId: "task-a" });
    expect(readAttachmentTasks.mock.calls).toEqual([
      [
        {
          accountId: "account-a",
          senderId: "sender-a",
          sessionKey: "agent:main:main",
          agentId: "main",
        },
        undefined,
      ],
      [
        {
          accountId: "account-a",
          senderId: "sender-b",
          sessionKey: "agent:main:main",
          agentId: "main",
        },
        "task-a",
      ],
    ]);
  });

  it("captures its route at creation instead of following a mutable context", async () => {
    const ctx = context();
    const tool = createWeixinAttachmentTool(ctx)!;
    ctx.agentAccountId = "other-account";
    ctx.requesterSenderId = "other-sender";
    ctx.sessionKey = "other-session";
    ctx.agentId = "other-agent";
    await tool.execute("call", {});
    expect(readAttachmentTasks).toHaveBeenCalledWith(
      {
        accountId: "account-a",
        senderId: "sender-a",
        sessionKey: "agent:main:main",
        agentId: "main",
      },
      undefined,
    );
  });

  it("returns only public progress fields and preserves unknown totals", async () => {
    readAttachmentTasks.mockReturnValue([
      snapshot({ path: "/private/file.pdf", url: "https://cdn.invalid/token", token: "secret" }),
    ]);
    const result = await createWeixinAttachmentTool(context())!.execute("call", {});
    const expected = {
      tasks: [
        {
          id: "task-a",
          fileName: "report.pdf",
          status: "downloading",
          receivedBytes: 1024,
          attempt: 1,
          maxAttempts: 3,
          createdAt: 1000,
          updatedAt: 2000,
        },
      ],
    };
    expect(result.details).toEqual(expected);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(expected, null, 2) }]);
  });

  it("reports known transfer totals and a public failure reason without inventing a percentage", async () => {
    readAttachmentTasks.mockReturnValue([
      snapshot({ status: "failed", totalBytes: 4096, error: "Download stopped receiving data." }),
    ]);
    const result = await createWeixinAttachmentTool(context())!.execute("call", {
      taskId: " task-a ",
    });
    expect(result.details).toMatchObject({
      tasks: [
        {
          id: "task-a",
          status: "failed",
          totalBytes: 4096,
          error: "Download stopped receiving data.",
        },
      ],
    });
    expect(readAttachmentTasks.mock.calls[0][1]).toBe("task-a");
    expect(JSON.stringify(result.details)).not.toContain("percent");
  });

  it("does not disclose whether an unknown or out-of-scope task exists", async () => {
    const result = await createWeixinAttachmentTool(context())!.execute("call", {
      taskId: "other-task",
    });
    expect(result.details).toEqual({ tasks: [] });
  });

  it.each([
    null,
    [],
    "task-a",
    { taskId: 7 },
    { taskId: "" },
    { taskId: " " },
    { taskId: "a".repeat(257) },
    { accountId: "other-account" },
    { taskId: "task-a", senderId: "other-sender" },
    { sessionKey: "other-session" },
  ])("rejects invalid arguments or model-supplied routing: %j", async (params) => {
    await expect(createWeixinAttachmentTool(context())!.execute("call", params)).rejects.toThrow();
    expect(readAttachmentTasks).not.toHaveBeenCalled();
  });

  it("registers a factory under the stable tool name", () => {
    const registerTool = vi.fn();
    registerWeixinAttachmentTool({ registerTool } as never);
    expect(registerTool).toHaveBeenCalledWith(createWeixinAttachmentTool, {
      name: WEIXIN_ATTACHMENT_STATUS_TOOL,
    });
  });
});
