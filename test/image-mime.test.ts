import { describe, expect, it } from "vitest";

import { detectImageMime } from "../src/image.js";

describe("detectImageMime", () => {
  it("detects png", () => {
    expect(
      detectImageMime(
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("image/png");
  });

  it("detects jpeg", () => {
    expect(detectImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      "image/jpeg",
    );
  });

  it("rejects arbitrary bytes", () => {
    expect(detectImageMime(Uint8Array.from([1, 2, 3, 4]))).toBeNull();
  });
});
