import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptAesEcb } from "./aes-ecb.js";
import {
  CdnDownloadError,
  downloadAndDecryptBuffer,
  downloadPlainCdnBuffer,
  type CdnDownloadOptions,
  type CdnDownloadProgress,
} from "./pic-decrypt.js";

let server: Server | undefined;
const timers: ReturnType<typeof setInterval>[] = [];
async function serve(listener: RequestListener): Promise<string> {
  server = createServer(listener);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/signed?secret=DO_NOT_LOG`;
}
function plain(url: string, options: CdnDownloadOptions = {}) {
  return downloadPlainCdnBuffer("secret-query", "", "test", url, {
    headerTimeoutMs: 200,
    idleTimeoutMs: 120,
    ...options,
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  timers.splice(0).forEach(clearInterval);
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe("CDN download transport against a real HTTP server", () => {
  it("bounds a request that never returns headers", async () => {
    const url = await serve(() => {});
    await expect(plain(url, { headerTimeoutMs: 80 })).rejects.toMatchObject({
      code: "header-timeout",
      retryable: true,
    });
  });

  it("bounds a body that stops producing data after headers", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200);
      res.write("first");
    });
    await expect(plain(url, { idleTimeoutMs: 80 })).rejects.toMatchObject({
      code: "idle-timeout",
      retryable: true,
    });
  });

  it("keeps a progressing transfer alive beyond the header and idle deadlines", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-length": 8 });
      res.write("x");
      let count = 1;
      const timer = setInterval(() => {
        res.write("x");
        count += 1;
        if (count === 8) {
          clearInterval(timer);
          res.end();
        }
      }, 40);
      timers.push(timer);
    });
    const progress: CdnDownloadProgress[] = [];
    const start = Date.now();
    await expect(plain(url, { onProgress: (event) => progress.push(event) })).resolves.toEqual(
      Buffer.from("xxxxxxxx"),
    );
    expect(Date.now() - start).toBeGreaterThan(200);
    expect(progress.at(-1)).toEqual({ receivedBytes: 8, totalBytes: 8 });
    expect(progress.length).toBeGreaterThan(2);
  });

  it("classifies an interrupted response body as retryable without exposing its URL", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-length": 100 });
      res.write("partial");
      setImmediate(() => res.destroy());
    });
    const error = await plain(url).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(CdnDownloadError);
    expect(error).toMatchObject({ code: "network", retryable: true });
    expect(String(error)).not.toContain("secret");
  });

  it("propagates caller cancellation while waiting for headers", async () => {
    let requestReceived!: () => void;
    const received = new Promise<void>((resolve) => (requestReceived = resolve));
    const url = await serve(() => requestReceived());
    const controller = new AbortController();
    const result = plain(url, { abortSignal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ code: "aborted", retryable: false });
    await received;
    controller.abort(new Error("secret caller reason"));
    await assertion;
  });

  it("cancels an active body read and rejects already-aborted calls", async () => {
    const url = await serve((_req, res) => res.write("partial"));
    const controller = new AbortController();
    await expect(
      plain(url, {
        abortSignal: controller.signal,
        onProgress: ({ receivedBytes }) => {
          if (receivedBytes) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: "aborted", retryable: false });
    await expect(plain(url, { abortSignal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    });
  });

  it.each([false, true])("enforces the byte limit with content-length=%s", async (withLength) => {
    const url = await serve((_req, res) => {
      res.writeHead(200, withLength ? { "content-length": 9 } : {});
      res.end("123456789");
    });
    await expect(plain(url, { maxBytes: 8 })).rejects.toMatchObject({
      code: "too-large",
      retryable: false,
    });
  });

  it("allows AES padding at the size boundary but rejects excess plaintext", async () => {
    const key = Buffer.alloc(16, 7);
    let plaintext = Buffer.alloc(16, 3);
    const url = await serve((_req, res) => res.end(encryptAesEcb(plaintext, key)));
    const download = (encodedKey: string) =>
      downloadAndDecryptBuffer("", encodedKey, "", "test", url, { maxBytes: 16 });
    await expect(download(key.toString("base64"))).resolves.toEqual(plaintext);
    await expect(download(Buffer.from(key.toString("hex")).toString("base64"))).resolves.toEqual(
      plaintext,
    );
    plaintext = Buffer.alloc(17, 3);
    await expect(download(key.toString("base64"))).rejects.toMatchObject({
      code: "too-large",
      retryable: false,
    });
  });

  it("omits compressed content-length from progress and limits decoded network bytes", async () => {
    const payload = Buffer.from("a".repeat(200));
    const compressed = gzipSync(payload);
    const url = await serve((_req, res) => {
      res.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": compressed.byteLength,
      });
      res.end(compressed);
    });
    const progress: CdnDownloadProgress[] = [];
    await expect(plain(url, { onProgress: (event) => progress.push(event) })).resolves.toEqual(
      payload,
    );
    expect(progress.at(-1)).toEqual({ receivedBytes: 200, totalBytes: undefined });
    await expect(plain(url, { maxBytes: 100 })).rejects.toMatchObject({ code: "too-large" });
  });

  it.each([
    [404, false],
    [408, true],
    [429, true],
    [503, true],
  ])(
    "classifies HTTP %s without waiting for or exposing the error body",
    async (status, retryable) => {
      const url = await serve((_req, res) => {
        res.writeHead(status);
        res.write("secret-error-body");
      });
      const error = await plain(url).catch((err: unknown) => err);
      expect(error).toMatchObject({ code: "http", status, retryable });
      expect(String(error)).not.toMatch(/secret|DO_NOT_LOG/);
    },
  );

  it("reports invalid encryption without leaking the key", async () => {
    const key = Buffer.alloc(16, 7).toString("base64");
    const url = await serve((_req, res) => res.end("invalid ciphertext"));
    await expect(downloadAndDecryptBuffer("", key, "", "test", url)).rejects.toMatchObject({
      code: "decrypt",
      retryable: false,
    });
    const error = await downloadAndDecryptBuffer("", "secret-invalid-key", "", "test", url).catch(
      (err: unknown) => err,
    );
    expect(error).toMatchObject({ code: "decrypt", retryable: false });
    expect(String(error)).not.toContain("secret-invalid-key");
  });
});

describe("fetch cause classification", () => {
  it.each([
    ["UND_ERR_SOCKET", true],
    ["UND_ERR_CONNECT_TIMEOUT", true],
    ["CERT_HAS_EXPIRED", false],
  ])("preserves the safe nested code %s", async (code, retryable) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(
          new TypeError("secret URL", { cause: new Error("secret body", { cause: { code } }) }),
        ),
    );
    const error = await plain("https://example.invalid/secret").catch((err: unknown) => err);
    expect(error).toMatchObject({ code: "network", causeCode: code, retryable });
    expect(String(error)).not.toContain("secret");
    expect(error).not.toHaveProperty("cause");
  });
});
