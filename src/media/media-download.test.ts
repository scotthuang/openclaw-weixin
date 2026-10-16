import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptAesEcb } from "../cdn/aes-ecb.js";
import { MessageItemType, type MessageItem } from "../api/types.js";
import { CdnDownloadError } from "../cdn/pic-decrypt.js";
import { downloadMediaFromItem } from "./media-download.js";

vi.mock("../util/logger.js", () => ({ logger: { debug: vi.fn(), error: vi.fn() } }));

let server: Server;
let url: string;
const key = Buffer.alloc(16, 1);
const payload = Buffer.from("downloaded file content");
const file = (): MessageItem => ({
  type: MessageItemType.FILE,
  file_item: {
    file_name: "example.txt",
    media: { full_url: url, aes_key: key.toString("base64") },
  },
});
const deps = () => ({
  cdnBaseUrl: "",
  saveMedia: vi.fn().mockResolvedValue({ path: "/media/example.txt" }),
  log: vi.fn(),
  errLog: vi.fn(),
  label: "test",
  throwOnError: true,
});

beforeEach(async () => {
  server = createServer((_req, res) => res.end(encryptAesEcb(payload, key)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/download`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("background media preparation", () => {
  it("returns ready media only after decryption and storage both complete", async () => {
    const dependencies = deps();
    let finishSave!: (saved: { path: string }) => void;
    const saving = new Promise<{ path: string }>((resolve) => (finishSave = resolve));
    dependencies.saveMedia.mockReturnValue(saving);
    let finished = false;
    const progress = vi.fn();
    const result = downloadMediaFromItem(file(), {
      ...dependencies,
      downloadOptions: { onProgress: progress },
    }).then((value) => {
      finished = true;
      return value;
    });
    await vi.waitFor(() => expect(dependencies.saveMedia).toHaveBeenCalled());
    expect(dependencies.saveMedia.mock.calls[0]?.[0]).toEqual(payload);
    expect(progress).toHaveBeenCalled();
    expect(finished).toBe(false);
    finishSave({ path: "/media/example.txt" });
    await expect(result).resolves.toEqual({
      decryptedFilePath: "/media/example.txt",
      fileMediaType: "text/plain",
    });
  });

  it("treats missing attachment metadata as failure in strict mode", async () => {
    await expect(
      downloadMediaFromItem({ type: MessageItemType.FILE, file_item: {} }, deps()),
    ).rejects.toMatchObject({ code: "unavailable", retryable: false });
  });

  it("keeps legacy empty-on-error behavior and makes strict failure observable", async () => {
    const item = file();
    item.file_item!.media!.aes_key = "invalid";
    await expect(downloadMediaFromItem(item, { ...deps(), throwOnError: false })).resolves.toEqual(
      {},
    );
    await expect(downloadMediaFromItem(item, deps())).rejects.toBeInstanceOf(CdnDownloadError);
  });

  it("does not report successful media after cancellation during storage", async () => {
    const controller = new AbortController();
    const dependencies = deps();
    dependencies.saveMedia.mockImplementation(async () => {
      controller.abort();
      return { path: "/media/example.txt" };
    });
    await expect(
      downloadMediaFromItem(file(), {
        ...dependencies,
        downloadOptions: { abortSignal: controller.signal },
      }),
    ).rejects.toMatchObject({ code: "aborted", retryable: false });
  });

  it("redacts storage failures and never reports a ready attachment", async () => {
    const dependencies = deps();
    dependencies.saveMedia.mockRejectedValue(new Error("secret internal path/token"));
    await expect(downloadMediaFromItem(file(), dependencies)).rejects.toMatchObject({
      code: "unavailable",
      retryable: false,
    });
    expect(dependencies.errLog.mock.calls.flat().join(" ")).not.toContain("secret");
  });
});
