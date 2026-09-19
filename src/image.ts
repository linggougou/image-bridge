import type { Locator } from "playwright";

import { ImageBridgeError } from "./errors.js";

export function decodeDataUrl(dataUrl: string): Buffer {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match?.[1] || !match[2]) {
    throw new ImageBridgeError("IMAGE_RETRIEVAL_FAILED", "页面返回了无效的图片数据。");
  }
  return Buffer.from(match[2], "base64");
}

export async function readImageFromPage(image: Locator): Promise<Buffer> {
  const dataUrl = await image.evaluate(async (element) => {
    const candidate = element as HTMLImageElement;
    const source = candidate.currentSrc || candidate.src;
    if (!source) return null;

    const response = await fetch(source);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  });

  if (!dataUrl) {
    throw new ImageBridgeError("IMAGE_RETRIEVAL_FAILED", "无法从页面读取图片。");
  }
  return decodeDataUrl(dataUrl);
}

export function detectImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)).startsWith("GIF8")) {
    return "image/gif";
  }
  return null;
}
