import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGE_BYTES,
} from "../src/extension-protocol.js";
import { loadReferenceImages } from "../src/reference-images.js";

const directories: string[] = [];
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempFile(name: string, bytes: Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "image-bridge-reference-"));
  directories.push(directory);
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
}

describe("reference image loading", () => {
  it("loads valid images and preserves detected MIME", async () => {
    const path = await tempFile("reference.png", png);
    const images = await loadReferenceImages([path]);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      name: "reference.png",
      mimeType: "image/png",
      byteLength: png.length,
      bytesBase64: png.toString("base64"),
    });
  });

  it("rejects unsupported files and missing paths", async () => {
    const invalid = await tempFile("reference.txt", Buffer.from("not an image"));
    await expect(loadReferenceImages([invalid])).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(loadReferenceImages([join(invalid, "missing.png")])).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("rejects too many images and oversized files", async () => {
    const valid = await tempFile("reference.png", png);
    await expect(
      loadReferenceImages(Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, () => valid)),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const oversized = await tempFile(
      "large.png",
      Buffer.concat([png, Buffer.alloc(MAX_REFERENCE_IMAGE_BYTES)]),
    );
    await expect(loadReferenceImages([oversized])).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});
