import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("installed Core admission contract", () => {
  it("adopts the first turn and accepts a followup before the first model response completes", async () => {
    const fixture = fileURLToPath(
      new URL("../../test/fixtures/core-adoption.mjs", import.meta.url),
    );
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [fixture], {
      timeout: 40_000,
      maxBuffer: 1024 * 1024,
    });
    const line = stdout
      .split("\n")
      .find((value) => value.startsWith("WEIXIN_CORE_ADOPTION_RESULT:"));
    expect(line, stderr || stdout).toBeDefined();
    const result = JSON.parse(line!.slice("WEIXIN_CORE_ADOPTION_RESULT:".length));
    expect(result.events).toEqual([
      "first-adopted",
      "model-request-1",
      "second-deferred",
      "release-first-response",
      "second-adopted",
      "model-request-2",
      "second-settled",
    ]);
    expect(result.requests).toEqual([
      {
        path: "/v1/chat/completions",
        containsPendingAttachment: true,
        containsLaterQuestion: false,
      },
      {
        path: "/v1/chat/completions",
        containsPendingAttachment: true,
        containsLaterQuestion: true,
      },
    ]);
  }, 45_000);
});
