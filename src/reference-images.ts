import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";

import type { ReferenceImageInput } from "./contracts.js";
import { ImageBridgeError } from "./errors.js";
import { detectImageMime } from "./image.js";
import {
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_TOTAL_BYTES,
} from "./extension-protocol.js";

export async function loadReferenceImages(paths: string[]): Promise<ReferenceImageInput[]> {
  if (paths.length === 0) return [];
  if (paths.length > MAX_REFERENCE_IMAGES) {
    throw new ImageBridgeError(
      "INVALID_ARGUMENT",
      `参考图最多支持 ${MAX_REFERENCE_IMAGES} 张。`,
    );
  }

  let totalBytes = 0;
  const images: ReferenceImageInput[] = [];
  for (const path of paths) {
    let fileStat;
    try {
      fileStat = await stat(path);
    } catch (error) {
      throw new ImageBridgeError("INVALID_ARGUMENT", `参考图不存在或不可读：${path}`, error);
    }
    if (!fileStat.isFile()) {
      throw new ImageBridgeError("INVALID_ARGUMENT", `参考图不是文件：${path}`);
    }
    if (fileStat.size <= 0 || fileStat.size > MAX_REFERENCE_IMAGE_BYTES) {
      throw new ImageBridgeError(
        "INVALID_ARGUMENT",
        `参考图大小必须在 1 字节到 ${MAX_REFERENCE_IMAGE_BYTES} 字节之间：${path}`,
      );
    }

    const bytes = await readFile(path);
    const mimeType = detectImageMime(bytes);
    if (!mimeType) {
      throw new ImageBridgeError(
        "INVALID_ARGUMENT",
        `不支持的参考图格式，仅支持 PNG、JPEG、WebP、GIF：${path}`,
      );
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_REFERENCE_TOTAL_BYTES) {
      throw new ImageBridgeError(
        "INVALID_ARGUMENT",
        `参考图总大小不能超过 ${MAX_REFERENCE_TOTAL_BYTES} 字节。`,
      );
    }

    images.push({
      name: basename(path).slice(0, 200) || "reference-image",
      mimeType,
      byteLength: bytes.length,
      bytesBase64: bytes.toString("base64"),
    });
  }
  return images;
}
