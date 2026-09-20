import { describe, expect, it } from "vitest";

import { computeReferenceSetFingerprint } from "../src/reference-fingerprint.js";

function reference(name: string, bytes: number[], mimeType = "image/png") {
  const buffer = Buffer.from(bytes);
  return {
    name,
    mimeType,
    byteLength: buffer.length,
    bytesBase64: buffer.toString("base64"),
  };
}

const a = reference("a.png", [1, 2, 3, 4]);
const b = reference("b.jpg", [9, 8, 7], "image/jpeg");

describe("reference set fingerprint", () => {
  it("is stable across renames and paths of identical bytes", () => {
    const renamed = { ...a, name: "/some/other/path/renamed.png" };
    expect(computeReferenceSetFingerprint([renamed])).toBe(
      computeReferenceSetFingerprint([a]),
    );
  });

  it("is order sensitive", () => {
    expect(computeReferenceSetFingerprint([a, b])).not.toBe(
      computeReferenceSetFingerprint([b, a]),
    );
  });

  it("changes when bytes change", () => {
    const mutated = reference("a.png", [1, 2, 3, 5]);
    expect(computeReferenceSetFingerprint([mutated])).not.toBe(
      computeReferenceSetFingerprint([a]),
    );
  });

  it("changes when the mime type changes", () => {
    const retyped = { ...a, mimeType: "image/webp" };
    expect(computeReferenceSetFingerprint([retyped])).not.toBe(
      computeReferenceSetFingerprint([a]),
    );
  });

  it("changes when the number of references changes", () => {
    expect(computeReferenceSetFingerprint([a, b])).not.toBe(
      computeReferenceSetFingerprint([a]),
    );
  });

  it("does not collide for different sets that concatenate alike", () => {
    const left = reference("x", [1, 2]);
    const right = reference("y", [3, 4]);
    expect(computeReferenceSetFingerprint([left, right])).not.toBe(
      computeReferenceSetFingerprint([reference("z", [1, 2, 3, 4])]),
    );
  });

  it("is prefixed with the algorithm version", () => {
    expect(computeReferenceSetFingerprint([a])).toMatch(/^sha256:v1:[0-9a-f]{64}$/);
  });
});
