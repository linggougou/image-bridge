import { readFile } from "node:fs/promises";

import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  countAssistantResponses,
  findPromptComposer,
  isAuthenticated,
  retrieveGeneratedImage,
  submitPrompt,
  waitForAuthenticated,
  waitForGeneratedImage,
  waitForNewResponse,
} from "../src/chatgpt.js";
import { detectImageMime } from "../src/image.js";

let browser: Awaited<ReturnType<typeof chromium.launch>>;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  await browser?.close();
});

describe("ChatGPT page automation", () => {
  it("selects the newly generated ChatGPT image instead of a stale image", async () => {
    const page = await browser.newPage();
    await page.route("https://chatgpt.com/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: await readFile(new URL("./fixtures/chatgpt.html", import.meta.url), "utf8"),
      });
    });
    await page.goto("https://chatgpt.com/");

    expect(await findPromptComposer(page, 5_000)).not.toBeNull();
    expect(await isAuthenticated(page)).toBe(true);

    const previousResponses = await countAssistantResponses(page);
    expect(previousResponses).toBe(1);
    await submitPrompt(page, "test prompt");

    const response = await waitForNewResponse(page, previousResponses, 5_000);
    expect(await response.getAttribute("data-testid")).toBe("conversation-turn-3");

    const image = await waitForGeneratedImage(page, response, 5_000);
    expect(await image.getAttribute("id")).toBe("new-image");

    const retrieved = await retrieveGeneratedImage(page, response, image);
    expect(retrieved.retrieval).toBe("data-url");
    expect(detectImageMime(retrieved.bytes)).toBe("image/png");
    await page.close();
  });

  it("does not treat a logged-out ChatGPT composer as authenticated", async () => {
    const page = await browser.newPage();
    await page.route("https://chatgpt.com/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: await readFile(
          new URL("./fixtures/chatgpt-logged-out.html", import.meta.url),
          "utf8",
        ),
      });
    });
    await page.goto("https://chatgpt.com/");
    expect(await isAuthenticated(page)).toBe(false);
    await page.close();
  });

  it("fails with SESSION_EXPIRED when ChatGPT login disappears", async () => {
    const page = await browser.newPage();
    await page.route("https://chatgpt.com/**", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: await readFile(
          new URL("./fixtures/chatgpt-expiring.html", import.meta.url),
          "utf8",
        ),
      });
    });
    await page.goto("https://chatgpt.com/");
    const previousResponses = await countAssistantResponses(page);
    await submitPrompt(page, "test prompt");

    await expect(
      waitForNewResponse(page, previousResponses, 5_000),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    await page.close();
  });

  it("reports a login page as unauthenticated", async () => {
    const page = await browser.newPage();
    await page.route("https://auth.openai.com/**", async (route) => {
      await route.fulfill({ contentType: "text/html", body: "<main>Log in</main>" });
    });
    await page.goto("https://auth.openai.com/log-in");
    await expect(waitForAuthenticated(page, 100)).resolves.toBe(false);
    await page.close();
  });
});
