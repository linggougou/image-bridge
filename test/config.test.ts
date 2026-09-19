import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses user-safe defaults outside the repository", () => {
    const config = loadConfig({}, "/workspace/image-bridge", "/Users/example");
    expect(config.homeDir).toBe("/Users/example/.image-bridge");
    expect(config.profileDir).toBe(
      "/Users/example/.image-bridge/chrome-profile/gemini",
    );
    expect(config.geminiProfileDir).toBe(
      "/Users/example/.image-bridge/chrome-profile/gemini",
    );
    expect(config.chatgptProfileDir).toBe(
      "/Users/example/.image-bridge/chrome-profile/chatgpt",
    );
    expect(config.chromeExtensionDir).toBe(
      "/Users/example/.image-bridge/chrome-extension",
    );
    expect(config.extensionBridgeHost).toBe("127.0.0.1");
    expect(config.extensionBridgePort).toBe(47_831);
    expect(config.backend).toBe("gemini");
    expect(config.outputDir).toBe("/workspace/image-bridge/outputs");
    expect(config.headless).toBe(true);
    expect(config.browserChannel).toBe("chrome");
  });

  it("honors environment overrides", () => {
    const config = loadConfig(
      {
        IMAGE_BRIDGE_HOME: "~/bridge-data",
        IMAGE_BRIDGE_OUTPUT_DIR: "./generated",
        IMAGE_BRIDGE_HEADLESS: "false",
        IMAGE_BRIDGE_TIMEOUT_MS: "9000",
      },
      "/workspace/image-bridge",
      "/Users/example",
    );
    expect(config.homeDir).toBe("/Users/example/bridge-data");
    expect(config.profileDir).toBe(
      "/Users/example/bridge-data/chrome-profile/gemini",
    );
    expect(config.geminiProfileDir).toBe(
      "/Users/example/bridge-data/chrome-profile/gemini",
    );
    expect(config.chatgptProfileDir).toBe(
      "/Users/example/bridge-data/chrome-profile/chatgpt",
    );
    expect(config.outputDir).toBe("/workspace/image-bridge/generated");
    expect(config.headless).toBe(false);
    expect(config.timeoutMs).toBe(9000);
  });

  it("accepts supported browser channels", () => {
    expect(
      loadConfig(
        { IMAGE_BRIDGE_BROWSER_CHANNEL: "msedge" },
        "/workspace/image-bridge",
        "/Users/example",
      ).browserChannel,
    ).toBe("msedge");
    expect(
      loadConfig(
        { IMAGE_BRIDGE_BROWSER_CHANNEL: "bundled" },
        "/workspace/image-bridge",
        "/Users/example",
      ).browserChannel,
    ).toBe("bundled");
  });

  it("falls back to system Chrome for an invalid browser channel", () => {
    const config = loadConfig(
      { IMAGE_BRIDGE_BROWSER_CHANNEL: "firefox" },
      "/workspace/image-bridge",
      "/Users/example",
    );
    expect(config.browserChannel).toBe("chrome");
  });

  it("selects the ChatGPT backend with a separate profile", () => {
    const config = loadConfig(
      { IMAGE_BRIDGE_BACKEND: "chatgpt" },
      "/workspace/image-bridge",
      "/Users/example",
    );
    expect(config.backend).toBe("chatgpt");
    expect(config.profileDir).toBe(
      "/Users/example/.image-bridge/chrome-profile/chatgpt",
    );
    expect(config.geminiProfileDir).toBe(
      "/Users/example/.image-bridge/chrome-profile/gemini",
    );
  });

  it("honors backend-specific profile overrides", () => {
    const config = loadConfig(
      {
        IMAGE_BRIDGE_BACKEND: "chatgpt",
        IMAGE_BRIDGE_GEMINI_PROFILE_DIR: "./profiles/gemini",
        IMAGE_BRIDGE_CHATGPT_PROFILE_DIR: "./profiles/chatgpt",
      },
      "/workspace/image-bridge",
      "/Users/example",
    );
    expect(config.geminiProfileDir).toBe("/workspace/image-bridge/profiles/gemini");
    expect(config.chatgptProfileDir).toBe("/workspace/image-bridge/profiles/chatgpt");
    expect(config.profileDir).toBe("/workspace/image-bridge/profiles/chatgpt");
  });

  it("keeps ChatGPT on its dedicated profile when the legacy Gemini override is set", () => {
    const config = loadConfig(
      {
        IMAGE_BRIDGE_BACKEND: "chatgpt",
        IMAGE_BRIDGE_PROFILE_DIR: "./profiles/legacy",
      },
      "/workspace/image-bridge",
      "/Users/example",
    );
    expect(config.geminiProfileDir).toBe("/workspace/image-bridge/profiles/legacy");
    expect(config.chatgptProfileDir).toBe(
      "/Users/example/.image-bridge/chrome-profile/chatgpt",
    );
    expect(config.profileDir).not.toBe(config.geminiProfileDir);
  });

  it("falls back to Gemini for an invalid backend", () => {
    const config = loadConfig(
      { IMAGE_BRIDGE_BACKEND: "unknown" },
      "/workspace/image-bridge",
      "/Users/example",
    );
    expect(config.backend).toBe("gemini");
  });

  it("selects the Chrome extension backend with an isolated bridge directory", () => {
    const config = loadConfig(
      {
        IMAGE_BRIDGE_BACKEND: "chrome-extension",
        IMAGE_BRIDGE_EXTENSION_PORT: "49000",
      },
      "/workspace/image-bridge",
      "/Users/example",
    );
    expect(config.backend).toBe("chrome-extension");
    expect(config.profileDir).toBe("/Users/example/.image-bridge/chrome-extension");
    expect(config.extensionBridgePort).toBe(49_000);
  });
});
