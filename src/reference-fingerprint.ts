import { createHash } from "node:crypto";

import type { ReferenceImageInput } from "./contracts.js";

/**
 * Version of the fingerprint algorithm. Bump when the canonical
 * representation changes so stored eligibility records cannot be reused
 * across incompatible definitions.
 */
export const REFERENCE_FINGERPRINT_VERSION = 1;

function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeMimeType(mimeType: string): string {
  const normalized = (mimeType || "").trim().toLowerCase();
  return normalized || "application/octet-stream";
}

/**
 * Fingerprints an ordered reference-image set from its validated bytes.
 *
 * Deliberately independent of file names, paths, timestamps and any
 * caller-supplied digest: renaming or moving a file must not change the
 * fingerprint, while changing any image's bytes, its MIME type, the number of
 * images, or their order must. The canonical form is length-delimited so two
 * different sets cannot collide by concatenation.
 */
export function computeReferenceSetFingerprint(images: ReferenceImageInput[]): string {
  const parts: string[] = [`v${REFERENCE_FINGERPRINT_VERSION}`, `n${images.length}`];

  for (const image of images) {
    const mimeType = normalizeMimeType(image.mimeType);
    const bytes = Buffer.from(image.bytesBase64, "base64");
    const digest = sha256Hex(bytes);
    parts.push(`m${Buffer.byteLength(mimeType)}:${mimeType}`);
    parts.push(`l${bytes.length}`);
    parts.push(`s${digest.length}:${digest}`);
  }

  return `sha256:v${REFERENCE_FINGERPRINT_VERSION}:${sha256Hex(parts.join("|"))}`;
}
