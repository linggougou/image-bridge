import type { BackendName, BridgeConfig } from "./config.js";
import type {
  BackendLoginResult,
  BackendStatus,
  GeneratedImageResult,
  ReferenceImageInput,
} from "./contracts.js";
import { ImageBridgeError } from "./errors.js";
import {
  generateImage as generateChatGPTImage,
  getChatGPTStatus,
  loginToChatGPT,
} from "./chatgpt.js";
import {
  generateImage as generateGeminiImage,
  getGeminiStatus,
  loginToGemini,
} from "./gemini.js";
import {
  generateWithChromeExtension,
  getChromeExtensionStatus,
  loginToChromeExtension,
} from "./chrome-extension-backend.js";
import { defaultOutputPath, resolveOutputPath } from "./output.js";

export type ConversationMode = "auto" | "new" | "reuse";

export type BackendGenerateInput = {
  config: BridgeConfig;
  prompt: string;
  referenceImages: ReferenceImageInput[];
  outputPath: string;
  force: boolean;
  headless: boolean;
  /** Reference jobs: reuse an eligible conversation, force a new one, or require reuse. */
  conversationMode?: ConversationMode;
};

export type ImageBackend = {
  name: BackendName;
  defaultOutputPath(config: BridgeConfig, now?: Date): string;
  login(config: BridgeConfig): Promise<BackendLoginResult>;
  status(config: BridgeConfig): Promise<BackendStatus>;
  generate(input: BackendGenerateInput): Promise<GeneratedImageResult>;
};

const geminiBackend: ImageBackend = {
  name: "gemini",
  defaultOutputPath(config, now) {
    return defaultOutputPath(config.outputDir, "gemini", now);
  },
  async login(config) {
    return { backend: "gemini", ...(await loginToGemini(config)) };
  },
  async status(config) {
    return { backend: "gemini", ...(await getGeminiStatus(config)) };
  },
  async generate(input) {
    if (input.referenceImages.length > 0) {
      throw new ImageBridgeError(
        "UNSUPPORTED_INPUT",
        "Gemini 后端暂不支持 --input 参考图，请使用 --backend chrome-extension。",
      );
    }
    const outputPath = await resolveOutputPath(input.outputPath, input.force);
    return generateGeminiImage({ ...input, outputPath });
  },
};

const chatGPTBackend: ImageBackend = {
  name: "chatgpt",
  defaultOutputPath(config, now) {
    return defaultOutputPath(config.outputDir, "chatgpt", now);
  },
  async login(config) {
    return { backend: "chatgpt", ...(await loginToChatGPT(config)) };
  },
  async status(config) {
    return { backend: "chatgpt", ...(await getChatGPTStatus(config)) };
  },
  async generate(input) {
    if (input.referenceImages.length > 0) {
      throw new ImageBridgeError(
        "UNSUPPORTED_INPUT",
        "Playwright ChatGPT 后端暂不支持 --input 参考图，请使用 --backend chrome-extension。",
      );
    }
    const outputPath = await resolveOutputPath(input.outputPath, input.force);
    return generateChatGPTImage({ ...input, outputPath });
  },
};

const chromeExtensionBackend: ImageBackend = {
  name: "chrome-extension",
  defaultOutputPath(config, now) {
    return defaultOutputPath(config.outputDir, "chrome-extension", now);
  },
  async login(config) {
    return loginToChromeExtension(config);
  },
  async status(config) {
    return getChromeExtensionStatus(config);
  },
  async generate(input) {
    const outputPath = await resolveOutputPath(input.outputPath, input.force);
    return generateWithChromeExtension({ ...input, outputPath });
  },
};

export function getBackend(name: BackendName): ImageBackend {
  if (name === "chatgpt") return chatGPTBackend;
  if (name === "chrome-extension") return chromeExtensionBackend;
  return geminiBackend;
}
