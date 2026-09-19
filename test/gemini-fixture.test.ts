import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  countResponses,
  findPromptComposer,
  isAuthenticated,
  submitPrompt,
  waitForAuthenticated,
  waitForGeneratedImage,
  waitForNewResponse,
} from "../src/gemini.js";

let browser: Awaited<ReturnType<typeof chromium.launch>>;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

describe("Gemini page automation", () => {
  it("selects the newly generated response and image instead of an old image", async () => {
    const page = await browser.newPage();
    const fixturePath = new URL("./fixtures/gemini.html", import.meta.url);
    await page.goto(pathToFileURL(fixturePath.pathname).href);

    const composer = await findPromptComposer(page, 5_000);
    expect(composer).not.toBeNull();

    const previousResponses = await countResponses(page);
    const previousImages = await page.locator("model-response img").count();
    expect(previousResponses).toBe(1);
    expect(previousImages).toBe(1);
    await submitPrompt(page, "test prompt");

    const response = await waitForNewResponse(
      page,
      previousResponses,
      previousImages,
      5_000,
    );
    expect(await response.getAttribute("id")).toBe("new-response");

    const image = await waitForGeneratedImage(page, response, 5_000);
    expect(await image.getAttribute("id")).toBe("new-image");

    await page.close();
  });

  it("keeps the fixture readable", async () => {
    const content = await readFile(new URL("./fixtures/gemini.html", import.meta.url), "utf8");
    expect(content).toContain("model-response");
  });

  it("does not treat a logged-out composer as authenticated", async () => {
    const page = await browser.newPage();
    const fixturePath = new URL("./fixtures/gemini-logged-out.html", import.meta.url);
    await page.goto(pathToFileURL(fixturePath.pathname).href);
    expect(await isAuthenticated(page)).toBe(false);
    await page.close();
  });

  it("fails with SESSION_EXPIRED when login disappears during generation", async () => {
    const page = await browser.newPage();
    const fixturePath = new URL("./fixtures/gemini-expiring.html", import.meta.url);
    await page.goto(pathToFileURL(fixturePath.pathname).href);
    await page.locator("model-response").waitFor({ state: "attached" });

    const previousResponses = await countResponses(page);
    const previousImages = await page.locator("model-response img").count();
    expect(previousResponses).toBe(1);
    expect(previousImages).toBe(0);
    await submitPrompt(page, "test prompt");

    await expect(
      waitForNewResponse(page, previousResponses, previousImages, 5_000),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await page.close();
  });

  it("reports Google browser safety blocks instead of waiting for login", async () => {
    const page = await browser.newPage();
    await page.route("https://accounts.google.com/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: "<meta charset=\"utf-8\"><main>此浏览器或应用可能不安全。请尝试使用其他浏览器。</main>",
      });
    });
    await page.goto("https://accounts.google.com/signin");

    await expect(waitForAuthenticated(page, 5_000, "chrome")).rejects.toMatchObject({
      code: "BROWSER_FAILED",
      message: expect.stringContaining("当前渠道：chrome"),
    });
    await page.close();
  });
});
