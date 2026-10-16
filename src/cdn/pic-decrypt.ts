import { aesEcbPaddedSize, decryptAesEcb } from "./aes-ecb.js";
import { buildCdnDownloadUrl, ENABLE_CDN_URL_FALLBACK } from "./cdn-url.js";

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_HEADER_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

/** Network bytes, before AES decryption. A total is omitted when it is not trustworthy. */
export type CdnDownloadProgress = { receivedBytes: number; totalBytes?: number };

export type CdnDownloadOptions = {
  abortSignal?: AbortSignal;
  onProgress?: (progress: CdnDownloadProgress) => void;
  headerTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Maximum plaintext size. Encrypted downloads allow the required AES padding. */
  maxBytes?: number;
};

export type CdnDownloadErrorCode =
  | "aborted"
  | "header-timeout"
  | "idle-timeout"
  | "http"
  | "network"
  | "too-large"
  | "decrypt"
  | "unavailable";

/** Safe to report: never includes signed URLs, AES keys, response bodies, or raw causes. */
export class CdnDownloadError extends Error {
  constructor(
    public readonly code: CdnDownloadErrorCode,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly causeCode?: string,
  ) {
    super(`Attachment download failed: ${code}${status === undefined ? "" : ` (HTTP ${status})`}`);
    this.name = "CdnDownloadError";
  }
}

const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const PERMANENT_NETWORK_CODES = new Set([
  "ENOTFOUND",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_INVALID_URL",
]);

function networkError(error: unknown): CdnDownloadError {
  let current = error;
  for (let depth = 0; depth < 6 && current && typeof current === "object"; depth += 1) {
    const { code, cause } = current as { code?: unknown; cause?: unknown };
    if (typeof code === "string") {
      if (RETRYABLE_NETWORK_CODES.has(code)) {
        return new CdnDownloadError("network", true, undefined, code);
      }
      if (PERMANENT_NETWORK_CODES.has(code)) {
        return new CdnDownloadError("network", false, undefined, code);
      }
    }
    current = cause;
  }
  // Fetch also reports interrupted response bodies as TypeError("terminated") without a code.
  return new CdnDownloadError("network", true);
}

export function throwIfCdnDownloadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CdnDownloadError("aborted", false);
}

function contentLength(response: Response): number | undefined {
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") return undefined;
  const value = response.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return undefined;
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

/** One attempt, with separate header and no-progress deadlines; no healthy-transfer time cap. */
async function fetchCdnBytes(
  url: string,
  options: CdnDownloadOptions,
  maxNetworkBytes: number,
): Promise<Buffer> {
  throwIfCdnDownloadAborted(options.abortSignal);
  const controller = new AbortController();
  const abort = () => controller.abort(new CdnDownloadError("aborted", false));
  options.abortSignal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const deadline = (milliseconds: number, code: "header-timeout" | "idle-timeout") => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new CdnDownloadError(code, true)), milliseconds);
    timer.unref?.();
  };
  try {
    deadline(options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS, "header-timeout");
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      controller.abort();
      throw new CdnDownloadError(
        "http",
        response.status === 408 || response.status === 429 || response.status >= 500,
        response.status,
      );
    }
    const totalBytes = contentLength(response);
    if (totalBytes !== undefined && totalBytes > maxNetworkBytes) {
      controller.abort();
      throw new CdnDownloadError("too-large", false);
    }
    let receivedBytes = 0;
    const chunks: Buffer[] = [];
    options.onProgress?.({ receivedBytes, totalBytes });
    if (response.body) {
      reader = response.body.getReader();
      deadline(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, "idle-timeout");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength === 0) continue;
        receivedBytes += value.byteLength;
        if (receivedBytes > maxNetworkBytes) {
          controller.abort();
          throw new CdnDownloadError("too-large", false);
        }
        chunks.push(Buffer.from(value));
        options.onProgress?.({ receivedBytes, totalBytes });
        deadline(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, "idle-timeout");
      }
    }
    throwIfCdnDownloadAborted(options.abortSignal);
    return Buffer.concat(chunks, receivedBytes);
  } catch (error) {
    if (error instanceof CdnDownloadError) throw error;
    if (controller.signal.reason instanceof CdnDownloadError) throw controller.signal.reason;
    throw networkError(error);
  } finally {
    clearTimeout(timer);
    options.abortSignal?.removeEventListener("abort", abort);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

/** Accept both base64(raw 16 bytes) and base64(32-character hexadecimal key). */
function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new CdnDownloadError("decrypt", false);
}

function downloadUrl(encryptedQueryParam: string, cdnBaseUrl: string, fullUrl?: string): string {
  if (fullUrl) return fullUrl;
  if (ENABLE_CDN_URL_FALLBACK) return buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
  throw new CdnDownloadError("unavailable", false);
}

/** Download, decrypt and enforce the plaintext limit before returning usable media. */
export async function downloadAndDecryptBuffer(
  encryptedQueryParam: string,
  aesKeyBase64: string,
  cdnBaseUrl: string,
  _label: string,
  fullUrl?: string,
  options: CdnDownloadOptions = {},
): Promise<Buffer> {
  throwIfCdnDownloadAborted(options.abortSignal);
  const key = parseAesKey(aesKeyBase64);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const encrypted = await fetchCdnBytes(
    downloadUrl(encryptedQueryParam, cdnBaseUrl, fullUrl),
    options,
    aesEcbPaddedSize(maxBytes),
  );
  throwIfCdnDownloadAborted(options.abortSignal);
  let decrypted: Buffer;
  try {
    decrypted = decryptAesEcb(encrypted, key);
  } catch {
    throw new CdnDownloadError("decrypt", false);
  }
  if (decrypted.byteLength > maxBytes) throw new CdnDownloadError("too-large", false);
  return decrypted;
}

/** Download unencrypted bytes with the same limits and cancellation as encrypted media. */
export async function downloadPlainCdnBuffer(
  encryptedQueryParam: string,
  cdnBaseUrl: string,
  _label: string,
  fullUrl?: string,
  options: CdnDownloadOptions = {},
): Promise<Buffer> {
  return fetchCdnBytes(
    downloadUrl(encryptedQueryParam, cdnBaseUrl, fullUrl),
    options,
    options.maxBytes ?? DEFAULT_MAX_BYTES,
  );
}
