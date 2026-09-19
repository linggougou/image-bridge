import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Chrome extension bridge files", () => {
  it("declares narrowly scoped Manifest V3 permissions", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"),
    ) as {
      manifest_version: number;
      permissions: string[];
      host_permissions: string[];
      background: { service_worker: string };
      action: { default_title: string; default_popup?: string };
      content_scripts: Array<{ js: string[]; world?: string }>;
    };
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(expect.arrayContaining(["storage", "tabs"]));
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining(["http://127.0.0.1/*", "https://chatgpt.com/*"]),
    );
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.action.default_popup).toBeUndefined();
    expect(
      manifest.content_scripts.find((script) => script.world === "MAIN")?.js,
    ).toEqual(["chatgpt-main-world.js"]);
    expect(
      manifest.content_scripts.find((script) => script.world !== "MAIN")?.js,
    ).toEqual([
      "content-core.js",
      "chatgpt-content.js",
    ]);
  });

  it("uses an explicit dedicated tab and never contains workstation paths", async () => {
    const content = await readFile(
      new URL("../extension/chatgpt-content.js", import.meta.url),
      "utf8",
    );
    expect(content).toContain('searchParams.get("image-bridge") === "1"');
    expect(content).toContain("BRIDGE_TAB_KEY");
    expect(content).toContain("HUMAN_VERIFICATION_REQUIRED");
    expect(content).not.toContain("/Volumes/2T/");
    expect(content).not.toContain("clickLogin");
    expect(content).not.toContain(":has-text");
  });

  it("keeps the bridge token in extension storage rather than source", async () => {
    const background = await readFile(
      new URL("../extension/background.js", import.meta.url),
      "utf8",
    );
    expect(background).toContain('chrome.storage.local.get');
    expect(background).toContain("chrome.action?.onClicked");
    expect(background).toContain("Authorization: `Bearer ${config.token}`");
    expect(background).not.toMatch(/token\s*=\s*["'][a-f0-9]{16,}/i);
  });
});
