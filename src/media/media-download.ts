import type { WeixinInboundMediaOpts } from "../messaging/inbound.js";
import { logger } from "../util/logger.js";
import { getMimeFromFilename } from "./mime.js";
import {
  CdnDownloadError,
  downloadAndDecryptBuffer,
  downloadPlainCdnBuffer,
  throwIfCdnDownloadAborted,
  type CdnDownloadOptions,
} from "../cdn/pic-decrypt.js";
import { silkToWav } from "./silk-transcode.js";
import type { WeixinMessage } from "../api/types.js";
import { MessageItemType } from "../api/types.js";

const WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024;

/** Persist a buffer via the framework's unified media store. */
type SaveMediaFn = (
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string,
) => Promise<{ path: string }>;

/**
 * Download and decrypt media from a single MessageItem.
 * Returns usable saved media. Legacy callers receive an empty object on failure;
 * background callers opt into typed failures with throwOnError.
 */
export async function downloadMediaFromItem(
  item: WeixinMessage["item_list"] extends (infer T)[] | undefined ? T : never,
  deps: {
    cdnBaseUrl: string;
    saveMedia: SaveMediaFn;
    /** OpenClaw media-store subdirectory; defaults to the transient inbound bucket. */
    mediaSubdir?: string;
    log: (msg: string) => void;
    errLog: (msg: string) => void;
    label: string;
    downloadOptions?: CdnDownloadOptions;
    /** Background tasks must observe failure instead of treating empty media as success. */
    throwOnError?: boolean;
  },
): Promise<WeixinInboundMediaOpts> {
  const { cdnBaseUrl, errLog, label } = deps;
  const downloadOptions = deps.downloadOptions;
  const unavailable = (): WeixinInboundMediaOpts => {
    if (deps.throwOnError) throw new CdnDownloadError("unavailable", false);
    return {};
  };
  const failed = (kind: string, error: unknown): void => {
    const safeError =
      error instanceof CdnDownloadError ? error : new CdnDownloadError("unavailable", false);
    const diagnostic = `${safeError.message}${safeError.causeCode ? ` causeCode=${safeError.causeCode}` : ""}`;
    logger.error(`${label} ${kind} processing failed: ${diagnostic}`);
    errLog(`weixin ${label} ${kind} processing failed: ${diagnostic}`);
    if (deps.throwOnError) throw safeError;
  };
  const saveMedia: SaveMediaFn = async (...args) => {
    throwIfCdnDownloadAborted(downloadOptions?.abortSignal);
    const saved = await deps.saveMedia(...args);
    throwIfCdnDownloadAborted(downloadOptions?.abortSignal);
    return saved;
  };
  const mediaSubdir = deps.mediaSubdir ?? "inbound";
  const result: WeixinInboundMediaOpts = {};

  if (item.type === MessageItemType.IMAGE) {
    const img = item.image_item;
    if (!img?.media?.encrypt_query_param && !img?.media?.full_url) return unavailable();
    const aesKeyBase64 = img.aeskey
      ? Buffer.from(img.aeskey, "hex").toString("base64")
      : img.media.aes_key;
    logger.debug(
      `${label} image: hasAesKey=${Boolean(aesKeyBase64)} aeskeySource=${img.aeskey ? "image_item.aeskey" : "media.aes_key"} full_url=${Boolean(img.media.full_url)}`,
    );
    try {
      const buf = aesKeyBase64
        ? await downloadAndDecryptBuffer(
            img.media.encrypt_query_param ?? "",
            aesKeyBase64,
            cdnBaseUrl,
            `${label} image`,
            img.media.full_url,
            downloadOptions,
          )
        : await downloadPlainCdnBuffer(
            img.media.encrypt_query_param ?? "",
            cdnBaseUrl,
            `${label} image-plain`,
            img.media.full_url,
            downloadOptions,
          );
      const saved = await saveMedia(buf, undefined, mediaSubdir, WEIXIN_MEDIA_MAX_BYTES);
      result.decryptedPicPath = saved.path;
      logger.debug(`${label} image saved: ${saved.path}`);
    } catch (err) {
      failed("image", err);
    }
  } else if (item.type === MessageItemType.VOICE) {
    const voice = item.voice_item;
    if ((!voice?.media?.encrypt_query_param && !voice?.media?.full_url) || !voice?.media?.aes_key)
      return unavailable();
    try {
      const silkBuf = await downloadAndDecryptBuffer(
        voice.media.encrypt_query_param ?? "",
        voice.media.aes_key,
        cdnBaseUrl,
        `${label} voice`,
        voice.media.full_url,
        downloadOptions,
      );
      logger.debug(`${label} voice: decrypted ${silkBuf.length} bytes, attempting silk transcode`);
      throwIfCdnDownloadAborted(downloadOptions?.abortSignal);
      const wavBuf = await silkToWav(silkBuf);
      if (wavBuf) {
        const saved = await saveMedia(wavBuf, "audio/wav", mediaSubdir, WEIXIN_MEDIA_MAX_BYTES);
        result.decryptedVoicePath = saved.path;
        result.voiceMediaType = "audio/wav";
        logger.debug(`${label} voice: saved WAV to ${saved.path}`);
      } else {
        const saved = await saveMedia(silkBuf, "audio/silk", mediaSubdir, WEIXIN_MEDIA_MAX_BYTES);
        result.decryptedVoicePath = saved.path;
        result.voiceMediaType = "audio/silk";
        logger.debug(`${label} voice: silk transcode unavailable, saved raw SILK to ${saved.path}`);
      }
    } catch (err) {
      failed("voice", err);
    }
  } else if (item.type === MessageItemType.FILE) {
    const fileItem = item.file_item;
    if (
      (!fileItem?.media?.encrypt_query_param && !fileItem?.media?.full_url) ||
      !fileItem?.media?.aes_key
    )
      return unavailable();
    try {
      const buf = await downloadAndDecryptBuffer(
        fileItem.media.encrypt_query_param ?? "",
        fileItem.media.aes_key,
        cdnBaseUrl,
        `${label} file`,
        fileItem.media.full_url,
        downloadOptions,
      );
      const mime = getMimeFromFilename(fileItem.file_name ?? "file.bin");
      const saved = await saveMedia(
        buf,
        mime,
        mediaSubdir,
        WEIXIN_MEDIA_MAX_BYTES,
        fileItem.file_name ?? undefined,
      );
      result.decryptedFilePath = saved.path;
      result.fileMediaType = mime;
      logger.debug(`${label} file: saved to ${saved.path} mime=${mime}`);
    } catch (err) {
      failed("file", err);
    }
  } else if (item.type === MessageItemType.VIDEO) {
    const videoItem = item.video_item;
    if (
      (!videoItem?.media?.encrypt_query_param && !videoItem?.media?.full_url) ||
      !videoItem?.media?.aes_key
    )
      return unavailable();
    try {
      const buf = await downloadAndDecryptBuffer(
        videoItem.media.encrypt_query_param ?? "",
        videoItem.media.aes_key,
        cdnBaseUrl,
        `${label} video`,
        videoItem.media.full_url,
        downloadOptions,
      );
      const saved = await saveMedia(buf, "video/mp4", mediaSubdir, WEIXIN_MEDIA_MAX_BYTES);
      result.decryptedVideoPath = saved.path;
      logger.debug(`${label} video: saved to ${saved.path}`);
    } catch (err) {
      failed("video", err);
    }
  }

  return result;
}
