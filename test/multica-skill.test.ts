import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Multica image-bridge skill", () => {
  it("documents the thin CLI contract without duplicating browser automation", async () => {
    const content = await readFile(
      new URL("../skills/image-bridge/SKILL.md", import.meta.url),
      "utf8",
    );
    expect(content).toContain("IMAGE_BRIDGE_CLI");
    expect(content).toContain("IMAGE_BRIDGE_NODE");
    expect(content).toContain("command -v image-bridge");
    expect(content).toContain('--backend "${IMAGE_BRIDGE_BACKEND:-chrome-extension}"');
    expect(content).toContain("image_bridge bridge");
    expect(content).toContain("--attachment <outputPath>");
    expect(content).toContain("--input \"<local-reference-1>\"");
    expect(content).toContain("Never reproduce browser selectors");
    expect(content).not.toContain("/Volumes/2T/");
  });
});
