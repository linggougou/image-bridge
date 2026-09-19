import { describe, expect, it } from "vitest";

import { getBackend } from "../src/backend.js";
import { loadConfig } from "../src/config.js";

describe("backend selection", () => {
  it("returns the selected backend and backend-specific output names", () => {
    const gemini = getBackend("gemini");
    const chatgpt = getBackend("chatgpt");
    const extension = getBackend("chrome-extension");
    const config = loadConfig({}, "/workspace/image-bridge", "/Users/example");

    expect(gemini.name).toBe("gemini");
    expect(chatgpt.name).toBe("chatgpt");
    expect(extension.name).toBe("chrome-extension");
    expect(gemini.defaultOutputPath(config, new Date("2026-01-02T03:04:05Z"))).toBe(
      "/workspace/image-bridge/outputs/gemini-20260102-030405.png",
    );
    expect(chatgpt.defaultOutputPath(config, new Date("2026-01-02T03:04:05Z"))).toBe(
      "/workspace/image-bridge/outputs/chatgpt-20260102-030405.png",
    );
    expect(extension.defaultOutputPath(config, new Date("2026-01-02T03:04:05Z"))).toBe(
      "/workspace/image-bridge/outputs/chrome-extension-20260102-030405.png",
    );
  });
});
