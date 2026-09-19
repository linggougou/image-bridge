import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  chromium,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";

import type { BridgeConfig } from "./config.js";
import type { GeneratedImageResult } from "./contracts.js";
import { ImageBridgeError } from "./errors.js";
import { readImageFromPage } from "./image.js";
import { saveValidatedImage } from "./output.js";

const COMPOSER_SELECTORS = [
  "rich-textarea [contenteditable='true'][role='textbox']",
  "[contenteditable='true'][role='textbox']",
  "div.ql-editor[contenteditable='true']",
  "textarea[placeholder]",
] as const;

const SEND_SELECTORS = [
  "button[data-test-id='send-button']",
  "button[aria-label*='Send']",
  "button[aria-label*='发送']",
] as const;

const SIGNED_OUT_SELECTORS = [
  "button:has-text('Sign in')",
  "a:has-text('Sign in')",
  "button:has-text('登录')",
  "a:has-text('登录')",
] as const;

const UNSUPPORTED_BROWSER_MESSAGES = [
  "此浏览器或应用可能不安全",
  "请尝试使用其他浏览器",
  "This browser or app may not be secure",
] as const;

const RESPONSE_SELECTOR =
  "model-response, [data-test-id='model-response'], [data-response-index]";

const RESPONSE_IMAGE_SELECTOR =
  "model-response img, [data-test-id='model-response'] img, [data-response-index] img";

const DOWNLOAD_SELECTORS = [
  "button[data-test-id='download-button']",
  "button[aria-label*='Download']",
  "button[aria-label*='下载']",
  "[role='button'][aria-label*='Download']",
  "[role='button'][aria-label*='下载']",
] as const;

const MIN_IMAGE_EDGE = 128;
const LOGIN_DIAGNOSTIC_PATH = join(tmpdir(), "image-bridge-login.png");

export type OpenedGeminiPage = {
  context: BrowserContext;
  page: Page;
};

export type GeminiStatus = {
  authenticated: boolean;
  url: string;
  profileDir: string;
};

async function unsupportedBrowserMessage(page: Page): Promise<string | null> {
  if (!page.url().includes("accounts.google.com")) return null;
  const bodyText = await page
    .locator("body")
    .innerText({ timeout: 3_000 })
    .catch(() => "");
  return (
    UNSUPPORTED_BROWSER_MESSAGES.find((message) => bodyText.includes(message)) ?? null
  );
}

async function saveLoginDiagnostic(page: Page): Promise<void> {
  await page
    .screenshot({ path: LOGIN_DIAGNOSTIC_PATH, fullPage: true })
    .catch(() => undefined);
}

function isGeminiUrl(url: string): boolean {
  try {
    return new URL(url).hostname === "gemini.google.com";
  } catch {
    return false;
  }
}

async function findVisible(
  root: Locator,
  selectors: readonly string[],
): Promise<Locator | null> {
  for (const selector of selectors) {
    const matches = root.locator(selector);
    const count = await matches.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = matches.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }
  }
  return null;
}

async function waitForVisible(
  root: Locator,
  selectors: readonly string[],
  timeoutMs: number,
  failureCode: "NOT_AUTHENTICATED" | "UI_CHANGED",
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const candidate = await findVisible(root, selectors);
    if (candidate) return candidate;
    await delay(250);
  }

  throw new ImageBridgeError(
    failureCode,
    failureCode === "NOT_AUTHENTICATED"
      ? "Gemini 未显示已登录的提示词输入框。"
      : "Gemini 页面结构已变化，未找到提示词输入框。",
  );
}

export async function openGeminiPage(
  config: BridgeConfig,
  headless: boolean,
): Promise<OpenedGeminiPage> {
  await mkdir(config.profileDir, { recursive: true });

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(config.profileDir, {
      ...(config.browserChannel === "bundled"
        ? {}
        : { channel: config.browserChannel }),
      headless,
      viewport: headless ? { width: 1440, height: 1000 } : null,
      acceptDownloads: true,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
  } catch (error) {
    throw new ImageBridgeError("BROWSER_FAILED", "无法启动 Gemini 浏览器会话。", error);
  }

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(config.timeoutMs);
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    await page.goto(config.geminiUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs,
    });
    return { context, page };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw new ImageBridgeError("BROWSER_FAILED", "无法打开 Gemini 页面。", error);
  }
}

export async function isAuthenticated(page: Page): Promise<boolean> {
  if (!isGeminiUrl(page.url())) return false;
  const root = page.locator(":root");
  const composer = await findVisible(root, COMPOSER_SELECTORS);
  if (!composer) return false;
  return (await findVisible(root, SIGNED_OUT_SELECTORS)) === null;
}

export async function isSignedOut(page: Page): Promise<boolean> {
  if (page.url().includes("accounts.google.com")) return true;
  return (await findVisible(page.locator(":root"), SIGNED_OUT_SELECTORS)) !== null;
}

export async function findPromptComposer(
  page: Page,
  timeoutMs = 30_000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const composer = await findVisible(page.locator(":root"), COMPOSER_SELECTORS);
    if (composer) return composer;
    await delay(250);
  }
  return null;
}

export async function waitForAuthenticated(
  page: Page,
  timeoutMs: number,
  browserChannel = "unknown",
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const unsupportedMessage = await unsupportedBrowserMessage(page);
    if (unsupportedMessage) {
      throw new ImageBridgeError(
        "BROWSER_FAILED",
        `Google 拒绝当前浏览器登录：${unsupportedMessage}。当前渠道：${browserChannel}。诊断截图：${LOGIN_DIAGNOSTIC_PATH}`,
      );
    }
    if (await isAuthenticated(page)) return true;
    await delay(500);
  }
  return false;
}

export async function loginToGemini(config: BridgeConfig): Promise<{
  profileDir: string;
  url: string;
}> {
  const opened = await openGeminiPage(config, false);
  try {
    process.stderr.write(
      "请在打开的浏览器中完成 Google 登录。登录成功并看到 Gemini 输入框后，命令会自动结束。\n",
    );
    const authenticated = await waitForAuthenticated(
      opened.page,
      config.loginTimeoutMs,
      config.browserChannel,
    );
    if (!authenticated) {
      await saveLoginDiagnostic(opened.page);
      throw new ImageBridgeError("TIMEOUT", "等待 Gemini 登录超时。");
    }
    return { profileDir: config.profileDir, url: opened.page.url() };
  } catch (error) {
    await saveLoginDiagnostic(opened.page);
    throw error;
  } finally {
    await opened.context.close().catch(() => undefined);
  }
}

export async function getGeminiStatus(config: BridgeConfig): Promise<GeminiStatus> {
  const opened = await openGeminiPage(config, config.headless);
  try {
    const authenticated = await waitForAuthenticated(
      opened.page,
      Math.min(config.navigationTimeoutMs, 20_000),
      config.browserChannel,
    );
    return {
      authenticated,
      url: opened.page.url(),
      profileDir: config.profileDir,
    };
  } finally {
    await opened.context.close().catch(() => undefined);
  }
}

export async function submitPrompt(page: Page, prompt: string): Promise<void> {
  const composer =
    (await findPromptComposer(page, 30_000)) ??
    (await waitForVisible(
      page.locator(":root"),
      COMPOSER_SELECTORS,
      1,
      "NOT_AUTHENTICATED",
    ));
  await composer.fill(prompt);

  const sendButton = await findVisible(page.locator(":root"), SEND_SELECTORS);
  if (sendButton && (await sendButton.isEnabled().catch(() => false))) {
    await sendButton.click();
    return;
  }

  await composer.press("Enter");
}

async function countImages(page: Page): Promise<number> {
  return page.locator(RESPONSE_IMAGE_SELECTOR).count();
}

export async function waitForNewResponse(
  page: Page,
  previousResponseCount: number,
  previousImageCount: number,
  timeoutMs: number,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isSignedOut(page)) {
      throw new ImageBridgeError("SESSION_EXPIRED", "Gemini 登录态在生成过程中失效。");
    }

    const responseCount = await countResponses(page);
    const imageCount = await countImages(page);
    if (responseCount > previousResponseCount || imageCount > previousImageCount) {
      const responses = page.locator(RESPONSE_SELECTOR);
      return responseCount > previousResponseCount
        ? responses.last()
        : page.locator("main").last();
    }

    await delay(500);
  }

  throw new ImageBridgeError("TIMEOUT", "等待 Gemini 生成完成超时。");
}

export async function countResponses(page: Page): Promise<number> {
  return page.locator(RESPONSE_SELECTOR).count();
}

async function imageDimensions(
  image: Locator,
): Promise<{ width: number; height: number }> {
  return image.evaluate((element) => {
    const candidate = element as HTMLImageElement;
    return {
      width: candidate.naturalWidth || candidate.width,
      height: candidate.naturalHeight || candidate.height,
    };
  });
}

export async function waitForGeneratedImage(
  page: Page,
  response: Locator,
  timeoutMs: number,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isSignedOut(page)) {
      throw new ImageBridgeError("SESSION_EXPIRED", "Gemini 登录态在生成过程中失效。");
    }

    const images = response.locator("img");
    const count = await images.count();
    for (let index = count - 1; index >= 0; index -= 1) {
      const image = images.nth(index);
      if (!(await image.isVisible().catch(() => false))) continue;
      const dimensions = await imageDimensions(image).catch(() => ({ width: 0, height: 0 }));
      if (dimensions.width >= MIN_IMAGE_EDGE && dimensions.height >= MIN_IMAGE_EDGE) {
        return image;
      }
    }
    await delay(500);
  }

  throw new ImageBridgeError("IMAGE_NOT_FOUND", "没有找到新生成的图片。");
}

async function readDownloadedImage(
  page: Page,
  response: Locator,
): Promise<Buffer | null> {
  const button = await findVisible(response, DOWNLOAD_SELECTORS);
  if (!button) return null;

  try {
    const downloadPromise = page.waitForEvent("download", { timeout: 10_000 });
    await button.click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    return downloadPath ? await readFile(downloadPath) : null;
  } catch {
    return null;
  }
}

export async function retrieveGeneratedImage(
  page: Page,
  response: Locator,
  image: Locator,
): Promise<{ bytes: Buffer; retrieval: "download" | "data-url" }> {
  const downloadBytes = await readDownloadedImage(page, response);
  if (downloadBytes && downloadBytes.length > 0) {
    return { bytes: downloadBytes, retrieval: "download" };
  }

  const imageBytes = await readImageFromPage(image);
  if (imageBytes.length === 0) {
    throw new ImageBridgeError("IMAGE_RETRIEVAL_FAILED", "Gemini 返回了空图片。");
  }

  return { bytes: imageBytes, retrieval: "data-url" };
}

export async function generateImage(input: {
  config: BridgeConfig;
  prompt: string;
  outputPath: string;
  headless: boolean;
}): Promise<GeneratedImageResult> {
  const { config, prompt, headless } = input;
  const outputPath = input.outputPath;

  const opened = await openGeminiPage(config, headless);
  try {
    if (!(await waitForAuthenticated(opened.page, 20_000, config.browserChannel))) {
      throw new ImageBridgeError(
        "NOT_AUTHENTICATED",
        "Gemini 登录态不可用，请先运行 image-bridge login。",
      );
    }

    const previousResponses = await countResponses(opened.page);
    const previousImages = await countImages(opened.page);
    await submitPrompt(opened.page, prompt);

    const response = await waitForNewResponse(
      opened.page,
      previousResponses,
      previousImages,
      config.timeoutMs,
    );
    const image = await waitForGeneratedImage(opened.page, response, config.timeoutMs);
    const retrieved = await retrieveGeneratedImage(
      opened.page,
      response,
      image,
    );
    const mimeType = await saveValidatedImage(outputPath, retrieved.bytes);

    return {
      outputPath,
      mimeType,
      bytes: retrieved.bytes.length,
      retrieval: retrieved.retrieval,
      prompt,
      modelUrl: opened.page.url(),
    };
  } finally {
    await opened.context.close().catch(() => undefined);
  }
}
