import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

import type { BackendName } from "./config.js";
import { ImageBridgeError } from "./errors.js";
import { detectImageMime } from "./image.js";

export async function appendUniqueSuffixIfNeeded(path: string): Promise<string> {
  try {
    await stat(path);
  } catch {
    return path;
  }

  const extension = extname(path);
  const base = path.slice(0, path.length - extension.length);
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${base}-${index}${extension}`;
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }

  throw new ImageBridgeError("OUTPUT_EXISTS", "无法为输出文件生成唯一名称。");
}

export function defaultOutputPath(
  outputDir: string,
  backend: BackendName,
  now = new Date(),
): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  return join(outputDir, `${backend}-${stamp}.png`);
}

export async function resolveOutputPath(
  requestedPath: string,
  force: boolean,
): Promise<string> {
  if (force) return requestedPath;

  const outputPath = await appendUniqueSuffixIfNeeded(requestedPath);
  try {
    await stat(outputPath);
    throw new ImageBridgeError("OUTPUT_EXISTS", `输出文件已存在：${outputPath}`);
  } catch (error) {
    if (error instanceof ImageBridgeError) throw error;
  }
  return outputPath;
}

export async function saveValidatedImage(
  outputPath: string,
  bytes: Uint8Array,
): Promise<string> {
  if (bytes.length === 0) {
    throw new ImageBridgeError("IMAGE_RETRIEVAL_FAILED", "返回了空图片。");
  }

  const mimeType = detectImageMime(bytes);
  if (!mimeType) {
    await rm(outputPath, { force: true });
    throw new ImageBridgeError(
      "IMAGE_RETRIEVAL_FAILED",
      "保存的内容不是可识别的 PNG/JPEG/WebP/GIF 图片。",
    );
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);
  return mimeType;
}
