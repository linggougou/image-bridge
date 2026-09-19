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
  "#prompt-textarea[contenteditable='true']",
  "textarea#prompt-textarea",
  "div#prompt-textarea[contenteditable='true']",
  "div.ProseMirror[contenteditable='true']",
  "[contenteditable='true'][role='textbox']",
] as const;

const SEND_SELECTORS = [
  "button#composer-submit-button",
  "button[data-testid='send-button']",
  "button[aria-label*='Send']",
  "button[aria-label*='发送']",
] as const;

const SIGNED_OUT_SELECTORS = [
  "button:has-text('Log in')",
  "a:has-text('Log in')",
  "button:has-text('登录')",
  "a:has-text('登录')",
  "button:has-text('Sign up')",
  "a:has-text('Sign up')",
  "button:has-text('免费注册')",
] as const;

const TURN_SELECTOR = "[data-testid^='conversation-turn-']";
const ASSISTANT_TURN_SELECTOR = `${TURN_SELECTOR}:has([data-message-author-role='assistant'])`;
const DOWNLOAD_SELECTORS = [
  "button[data-testid*='download']",
  "button[aria-label*='Download']",
  "button[aria-label*='下载']",
  "[role='button'][aria-label*='Download']",
  "[role='button'][aria-label*='下载']",
] as const;

const MIN_IMAGE_EDGE = 128;
const LOGIN_DIAGNOSTIC_PATH = join(tmpdir(), "image-bridge-chatgpt-login.png");

export type OpenedChatGPTPage = {
  context: BrowserContext;
  page: Page;
};

export type ChatGPTStatus = {
  authenticated: boolean;
  url: string;
  profileDir: string;
};

function isChatGPTUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com");
  } catch {
    return false;
  }
}

function isChatGPTLoginUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "auth.openai.com" ||
      parsed.hostname === "auth0.openai.com" ||
      /\/auth\/(login|signin)/i.test(parsed.pathname)
    );
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

async function saveLoginDiagnostic(page: Page): Promise<void> {
  await page
    .screenshot({ path: LOGIN_DIAGNOSTIC_PATH, fullPage: true })
    .catch(() => undefined);
}

export async function openChatGPTPage(
  config: BridgeConfig,
  headless: boolean,
): Promise<OpenedChatGPTPage> {
  await mkdir(config.chatgptProfileDir, { recursive: true });

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(config.chatgptProfileDir, {
      ...(config.browserChannel === "bundled"
        ? {}
        : { channel: config.browserChannel }),
      headless,
      viewport: headless ? { width: 1440, height: 1000 } : null,
      acceptDownloads: true,
      args: ["--no-first-run", "--no-default-browser-check"],
    });
  } catch (error) {
    throw new ImageBridgeError("BROWSER_FAILED", "无法启动 ChatGPT 浏览器会话。", error);
  }

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(config.timeoutMs);
    page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
    await page.goto(config.chatgptUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs,
    });
    return { context, page };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw new ImageBridgeError("BROWSER_FAILED", "无法打开 ChatGPT 页面。", error);
  }
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

export async function isSignedOut(page: Page): Promise<boolean> {
  if (isChatGPTLoginUrl(page.url())) return true;
  return (await findVisible(page.locator(":root"), SIGNED_OUT_SELECTORS)) !== null;
}

export async function isAuthenticated(page: Page): Promise<boolean> {
  if (!isChatGPTUrl(page.url())) return false;
  if (!(await findPromptComposer(page, 1_000))) return false;
  return !(await isSignedOut(page));
}

export async function waitForAuthenticated(
  page: Page,
  timeoutMs: number,
  returnIfSignedOut = false,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isAuthenticated(page)) return true;
    if (returnIfSignedOut && (await isSignedOut(page))) return false;
    await delay(500);
  }
  return false;
}

export async function loginToChatGPT(config: BridgeConfig): Promise<{
  profileDir: string;
  url: string;
}> {
  const opened = await openChatGPTPage(config, false);
  try {
    process.stderr.write(
      "请在打开的浏览器中完成 ChatGPT 登录。登录成功并看到聊天输入框后，命令会自动结束。\n",
    );
    const authenticated = await waitForAuthenticated(opened.page, config.loginTimeoutMs);
    if (!authenticated) {
      await saveLoginDiagnostic(opened.page);
      throw new ImageBridgeError(
        "TIMEOUT",
        `等待 ChatGPT 登录超时。诊断截图：${LOGIN_DIAGNOSTIC_PATH}`,
      );
    }
    return { profileDir: config.chatgptProfileDir, url: opened.page.url() };
  } catch (error) {
    await saveLoginDiagnostic(opened.page);
    throw error;
  } finally {
    await opened.context.close().catch(() => undefined);
  }
}

export async function getChatGPTStatus(config: BridgeConfig): Promise<ChatGPTStatus> {
  const opened = await openChatGPTPage(config, config.headless);
  try {
    const authenticated = await waitForAuthenticated(
      opened.page,
      Math.min(config.navigationTimeoutMs, 20_000),
      true,
    );
    return {
      authenticated,
      url: opened.page.url(),
      profileDir: config.chatgptProfileDir,
    };
  } finally {
    await opened.context.close().catch(() => undefined);
  }
}

export async function submitPrompt(page: Page, prompt: string): Promise<void> {
  const composer = await findPromptComposer(page, 30_000);
  if (!composer) {
    throw new ImageBridgeError(
      "NOT_AUTHENTICATED",
      "ChatGPT 未显示已登录的提示词输入框，请先运行 image-bridge login --backend chatgpt。",
    );
  }

  try {
    await composer.fill(prompt);
  } catch {
    await composer.click();
    await composer.pressSequentially(prompt);
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const sendButton = await findVisible(page.locator(":root"), SEND_SELECTORS);
    if (sendButton && (await sendButton.isEnabled().catch(() => false))) {
      await sendButton.click();
      return;
    }
    await delay(100);
  }

  await composer.press("Enter");
}

export async function countAssistantResponses(page: Page): Promise<number> {
  return page.locator(ASSISTANT_TURN_SELECTOR).count();
}

export async function waitForNewResponse(
  page: Page,
  previousResponseCount: number,
  timeoutMs: number,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isSignedOut(page)) {
      throw new ImageBridgeError("SESSION_EXPIRED", "ChatGPT 登录态在生成过程中失效。");
    }

    const responseCount = await countAssistantResponses(page);
    if (responseCount > previousResponseCount) {
      return page.locator(ASSISTANT_TURN_SELECTOR).last();
    }
    await delay(500);
  }

  const composerVisible = (await findPromptComposer(page, 1_000)) !== null;
  if (!composerVisible) {
    throw new ImageBridgeError("UI_CHANGED", "ChatGPT 页面结构已变化，未找到回复。");
  }
  throw new ImageBridgeError("TIMEOUT", "等待 ChatGPT 生成响应超时。");
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
      throw new ImageBridgeError("SESSION_EXPIRED", "ChatGPT 登录态在生成过程中失效。");
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

  throw new ImageBridgeError("IMAGE_NOT_FOUND", "没有找到 ChatGPT 新生成的图片。");
}

async function readDownloadedImage(
  page: Page,
  response: Locator,
): Promise<Buffer | null> {
  await response.hover({ timeout: 3_000 }).catch(() => undefined);
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
    throw new ImageBridgeError("IMAGE_RETRIEVAL_FAILED", "ChatGPT 返回了空图片。");
  }
  return { bytes: imageBytes, retrieval: "data-url" };
}

export async function generateImage(input: {
  config: BridgeConfig;
  prompt: string;
  outputPath: string;
  headless: boolean;
}): Promise<GeneratedImageResult> {
  const { config, prompt, headless, outputPath } = input;
  const opened = await openChatGPTPage(config, headless);
  try {
    if (!(await waitForAuthenticated(opened.page, 20_000, true))) {
      throw new ImageBridgeError(
        "NOT_AUTHENTICATED",
        "ChatGPT 登录态不可用，请先运行 image-bridge login --backend chatgpt。",
      );
    }

    const previousResponses = await countAssistantResponses(opened.page);
    await submitPrompt(opened.page, prompt);
    const response = await waitForNewResponse(
      opened.page,
      previousResponses,
      config.timeoutMs,
    );
    const image = await waitForGeneratedImage(opened.page, response, config.timeoutMs);
    const retrieved = await retrieveGeneratedImage(opened.page, response, image);
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
