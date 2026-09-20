import { setTimeout as delay } from "node:timers/promises";

import type { BridgeConfig } from "./config.js";
import type {
  BackendLoginResult,
  BackendStatus,
  GeneratedImageResult,
  ReferenceImageInput,
} from "./contracts.js";
import { ImageBridgeError, type ImageBridgeErrorCode } from "./errors.js";
import type { ExtensionBridgeStatus } from "./extension-protocol.js";
import { readExtensionBridgeToken } from "./extension-token.js";
import { computeReferenceSetFingerprint } from "./reference-fingerprint.js";
import { saveValidatedImage } from "./output.js";

type BridgeJob = {
  id: string;
  state: "queued" | "claimed" | "completed" | "failed";
  error?: { code: string; message: string };
  result?: {
    bytes: number;
    mimeType: string;
    retrieval: "data-url";
    modelUrl: string;
  };
  inputs?: Array<Omit<ReferenceImageInput, "bytesBase64">>;
};

const BRIDGE_ERROR_CODES = new Set<ImageBridgeErrorCode>([
  "NOT_AUTHENTICATED",
  "SESSION_EXPIRED",
  "TIMEOUT",
  "UI_CHANGED",
  "IMAGE_NOT_FOUND",
  "IMAGE_RETRIEVAL_FAILED",
  "EXTENSION_UNAVAILABLE",
  "TAB_NOT_READY",
  "REFERENCE_IMAGE_UPLOAD_FAILED",
  "REFERENCE_IMAGE_NOT_SUBMITTED",
  "CONVERSATION_REUSE_UNAVAILABLE",
  "BROWSER_FAILED",
]);

function bridgeUrl(config: BridgeConfig, path: string): string {
  return `http://${config.extensionBridgeHost}:${config.extensionBridgePort}${path}`;
}

async function bridgeToken(config: BridgeConfig): Promise<string> {
  try {
    const token = await readExtensionBridgeToken(config.extensionBridgeTokenPath);
    if (!token) throw new Error("empty token");
    return token;
  } catch (error) {
    throw new ImageBridgeError(
      "BRIDGE_UNAVAILABLE",
      "扩展桥未初始化。请先运行 image-bridge bridge token，并将 token 配置到 Chrome 扩展。",
      error,
    );
  }
}

async function requestJson<T>(
  config: BridgeConfig,
  path: string,
  init: RequestInit = {},
  timeoutMs = 5_000,
): Promise<T> {
  const token = await bridgeToken(config);
  let response: Response;
  try {
    response = await fetch(bridgeUrl(config, path), {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ImageBridgeError(
      "BRIDGE_UNAVAILABLE",
      `无法连接扩展桥 ${config.extensionBridgeHost}:${config.extensionBridgePort}。请先运行 image-bridge bridge。`,
      error,
    );
  }

  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new ImageBridgeError(
      "PROTOCOL_ERROR",
      typeof body.error === "string" ? body.error : `扩展桥请求失败：HTTP ${response.status}`,
    );
  }
  return body;
}

export async function getChromeExtensionStatus(config: BridgeConfig): Promise<BackendStatus> {
  try {
    const status = await requestJson<ExtensionBridgeStatus>(config, "/v1/status");
    return {
      backend: "chrome-extension",
      authenticated: status.extensionConnected && status.tabReady && status.chatgptAuthenticated,
      url: status.tabUrl ?? `chrome-extension://image-bridge`,
      profileDir: config.chromeExtensionDir,
    };
  } catch {
    return {
      backend: "chrome-extension",
      authenticated: false,
      url: `http://${config.extensionBridgeHost}:${config.extensionBridgePort}`,
      profileDir: config.chromeExtensionDir,
    };
  }
}

export async function loginToChromeExtension(
  config: BridgeConfig,
): Promise<BackendLoginResult> {
  const status = await getChromeExtensionStatus(config);
  if (!status.authenticated) {
    throw new ImageBridgeError(
      "NOT_AUTHENTICATED",
      "扩展桥或专用 ChatGPT 标签页尚未就绪。请启动 image-bridge bridge，在正常 Chrome 登录 ChatGPT，并打开扩展的专用标签页。",
    );
  }
  return { backend: "chrome-extension", profileDir: status.profileDir, url: status.url };
}

function bridgeErrorCode(code: string): ImageBridgeErrorCode {
  return BRIDGE_ERROR_CODES.has(code as ImageBridgeErrorCode)
    ? (code as ImageBridgeErrorCode)
    : "PROTOCOL_ERROR";
}

export async function generateWithChromeExtension(input: {
  config: BridgeConfig;
  prompt: string;
  outputPath: string;
  referenceImages: ReferenceImageInput[];
  headless: boolean;
  conversationMode?: "auto" | "new" | "reuse";
}): Promise<GeneratedImageResult> {
  const { config, prompt, outputPath, referenceImages } = input;
  const status = await getChromeExtensionStatus(config);
  if (!status.authenticated) {
    const protocolStatus = await requestJson<ExtensionBridgeStatus>(config, "/v1/status").catch(
      () => null,
    );
    if (!protocolStatus?.extensionConnected) {
      throw new ImageBridgeError(
        "EXTENSION_UNAVAILABLE",
        "Chrome 扩展未连接。请确认扩展已加载并保持专用 ChatGPT 标签页打开。",
      );
    }
    if (!protocolStatus.tabReady) {
      throw new ImageBridgeError(
        "TAB_NOT_READY",
        "专用 ChatGPT 标签页未就绪。请在扩展中打开专用标签页并确认已登录。",
      );
    }
    throw new ImageBridgeError(
      "NOT_AUTHENTICATED",
      "ChatGPT 登录态不可用。请在正常 Chrome 中手动登录。",
    );
  }

  const referenceFingerprint =
    referenceImages.length > 0 ? computeReferenceSetFingerprint(referenceImages) : undefined;

  // auto (default): reuse an eligible conversation with an identical ordered
  // reference set. new/reuse give callers explicit control.
  const envMode = (process.env.IMAGE_BRIDGE_CONVERSATION || "").trim().toLowerCase();
  const conversationMode =
    input.conversationMode ??
    (envMode === "new" || envMode === "reuse" || envMode === "auto"
      ? (envMode as "auto" | "new" | "reuse")
      : undefined);

  const submitted = await requestJson<BridgeJob>(config, "/v1/jobs", {
    method: "POST",
    body: JSON.stringify({
      prompt,
      timeoutMs: config.extensionJobTimeoutMs,
      ...(referenceImages.length > 0 ? { inputs: referenceImages } : {}),
      ...(referenceFingerprint ? { referenceFingerprint } : {}),
      ...(conversationMode ? { conversationMode } : {}),
    }),
  });

  const deadline = Date.now() + config.extensionJobTimeoutMs;
  while (Date.now() < deadline) {
    const job = await requestJson<BridgeJob>(config, `/v1/jobs/${submitted.id}`);
    if (job.state === "failed") {
      throw new ImageBridgeError(
        bridgeErrorCode(job.error?.code ?? "PROTOCOL_ERROR"),
        job.error?.message ?? "扩展桥生成失败。",
      );
    }
    if (job.state === "completed") {
      const result = await requestJson<{
        bytesBase64: string;
        mimeType: string;
        retrieval: "data-url";
        modelUrl: string;
      }>(config, `/v1/jobs/${submitted.id}/result`);
      const bytes = Buffer.from(result.bytesBase64, "base64");
      const mimeType = await saveValidatedImage(outputPath, bytes);
      return {
        outputPath,
        mimeType,
        bytes: bytes.length,
        retrieval: result.retrieval,
        prompt,
        modelUrl: result.modelUrl || status.url,
      };
    }
    await delay(500);
  }

  throw new ImageBridgeError("TIMEOUT", "等待 Chrome 扩展生成图片超时。");
}
