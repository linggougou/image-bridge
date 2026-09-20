#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { getBackend } from "./backend.js";
import { ExtensionBridgeServer } from "./bridge-server.js";
import { isBackendName, loadConfig } from "./config.js";
import { ImageBridgeError } from "./errors.js";
import { readOrCreateExtensionBridgeToken } from "./extension-token.js";
import { loadReferenceImages } from "./reference-images.js";
import { failureResult, successResult, writeJsonResult } from "./result.js";

type ParsedCli = {
  command?: string;
  subcommand?: string;
  prompt?: string;
  output?: string;
  inputPaths?: string[];
  backend?: string;
  conversation?: string;
  force: boolean;
  headed: boolean;
  help: boolean;
};

function parseCli(argv: string[]): ParsedCli {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      prompt: { type: "string" },
      output: { type: "string" },
      input: { type: "string", multiple: true },
      backend: { type: "string" },
      conversation: { type: "string" },
      force: { type: "boolean", default: false },
      headed: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  return {
    command: positionals[0],
    subcommand: positionals[1],
    prompt: values.prompt,
    output: values.output,
    inputPaths: values.input,
    backend: values.backend,
    conversation: values.conversation,
    force: values.force ?? false,
    headed: values.headed ?? false,
    help: values.help ?? false,
  };
}

function printHelp(): void {
  process.stdout.write(`image-bridge

Usage:
  image-bridge login
  image-bridge login --backend chatgpt
  image-bridge status
  image-bridge status --backend chatgpt
  image-bridge generate --prompt "..." [--input ref.png ...] [--output path] [--conversation auto|new|reuse] [--force] [--headed]
  image-bridge bridge
  image-bridge bridge token

Environment:
  IMAGE_BRIDGE_HOME
  IMAGE_BRIDGE_BACKEND=gemini|chatgpt
  IMAGE_BRIDGE_BACKEND=chrome-extension
  IMAGE_BRIDGE_PROFILE_DIR
  IMAGE_BRIDGE_GEMINI_PROFILE_DIR
  IMAGE_BRIDGE_CHATGPT_PROFILE_DIR
  IMAGE_BRIDGE_OUTPUT_DIR
  IMAGE_BRIDGE_TIMEOUT_MS
  IMAGE_BRIDGE_LOGIN_TIMEOUT_MS
  IMAGE_BRIDGE_HEADLESS=true|false
  IMAGE_BRIDGE_BROWSER_CHANNEL=chrome|msedge|bundled
  GEMINI_WEB_URL
  CHATGPT_WEB_URL
  IMAGE_BRIDGE_EXTENSION_PORT=47831
  IMAGE_BRIDGE_EXTENSION_TOKEN_PATH
`);
}

export async function run(argv = process.argv.slice(2)): Promise<number> {
  const fallbackCommand =
    argv.find((value) => !value.startsWith("-") && value.length > 0) ?? "unknown";

  let args: ParsedCli;
  try {
    args = parseCli(argv);
  } catch (error) {
    writeJsonResult(
      failureResult(
        fallbackCommand,
        new ImageBridgeError(
          "INVALID_ARGUMENT",
          error instanceof Error ? error.message : "命令行参数无效。",
          error,
        ),
      ),
    );
    return 1;
  }

  try {
    if (args.help || !args.command) {
      printHelp();
      return 0;
    }

    if (args.backend && !isBackendName(args.backend)) {
      throw new ImageBridgeError(
        "INVALID_ARGUMENT",
        `不支持的 backend：${args.backend}。支持 gemini、chatgpt、chrome-extension。`,
      );
    }

    const config = loadConfig(
      args.backend
        ? { ...process.env, IMAGE_BRIDGE_BACKEND: args.backend }
        : process.env,
    );
    const backend = getBackend(config.backend);

    if (args.command === "bridge") {
      if (args.subcommand === "token") {
        const token = await readOrCreateExtensionBridgeToken(
          config.extensionBridgeTokenPath,
        );
        writeJsonResult(successResult("bridge token", { token }));
        return 0;
      }

      const token = await readOrCreateExtensionBridgeToken(config.extensionBridgeTokenPath);
      const bridge = new ExtensionBridgeServer({
        host: config.extensionBridgeHost,
        port: config.extensionBridgePort,
        token,
        defaultJobTimeoutMs: config.extensionJobTimeoutMs,
      });
      await bridge.start();
      writeJsonResult(
        successResult("bridge", {
          host: config.extensionBridgeHost,
          port: bridge.port,
        }),
      );
      await bridge.waitUntilClosed();
      return 0;
    }

    if (args.command === "login") {
      const result = await backend.login(config);
      writeJsonResult(
        successResult("login", {
          backend: result.backend,
          profileDir: result.profileDir,
          url: result.url,
        }),
      );
      return 0;
    }

    if (args.command === "status") {
      const result = await backend.status(config);
      writeJsonResult(successResult("status", result));
      return result.authenticated ? 0 : 2;
    }

    if (args.command === "generate") {
      const prompt = args.prompt?.trim();
      if (!prompt) {
        throw new ImageBridgeError("INVALID_ARGUMENT", "generate 需要非空的 --prompt。");
      }

      const requestedOutput = args.output
        ? resolve(process.cwd(), args.output)
        : backend.defaultOutputPath(config);
      const referenceImages = await loadReferenceImages(args.inputPaths ?? []);
      if (
        args.conversation &&
        !["auto", "new", "reuse"].includes(args.conversation)
      ) {
        throw new ImageBridgeError(
          "INVALID_ARGUMENT",
          `不支持的 --conversation：${args.conversation}。支持 auto、new、reuse。`,
        );
      }

      const result = await backend.generate({
        config,
        prompt,
        referenceImages,
        outputPath: requestedOutput,
        force: args.force,
        headless: args.headed ? false : config.headless,
        ...(args.conversation
          ? { conversationMode: args.conversation as "auto" | "new" | "reuse" }
          : {}),
      });
      writeJsonResult(successResult("generate", result));
      return 0;
    }

    throw new ImageBridgeError(
      "INVALID_ARGUMENT",
      `未知命令：${args.command}。支持 login、status、generate。`,
    );
  } catch (error) {
    writeJsonResult(failureResult(fallbackCommand, error));
    return 1;
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  const exitCode = await run();
  process.exitCode = exitCode;
}
