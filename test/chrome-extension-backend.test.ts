import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { generateWithChromeExtension } from "../src/chrome-extension-backend.js";
import { loadConfig } from "../src/config.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Chrome extension backend", () => {
  it("submits through loopback and writes a validated image", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let submittedBody: Record<string, unknown> | null = null;
    const server = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/v1/status") {
        response.end(
          JSON.stringify({
            extensionConnected: true,
            tabReady: true,
            chatgptAuthenticated: true,
            tabUrl: "https://chatgpt.com/",
          }),
        );
        return;
      }
      if (request.url === "/v1/jobs") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        submittedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >;
        response.statusCode = 201;
        response.end(JSON.stringify({ id: "job-1", state: "queued" }));
        return;
      }
      if (request.url === "/v1/jobs/job-1") {
        response.end(JSON.stringify({ id: "job-1", state: "completed" }));
        return;
      }
      if (request.url === "/v1/jobs/job-1/result") {
        response.end(
          JSON.stringify({
            bytesBase64: png.toString("base64"),
            mimeType: "image/png",
            retrieval: "data-url",
            modelUrl: "https://chatgpt.com/",
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not_found" }));
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");

    const directory = await mkdtemp(join(tmpdir(), "image-bridge-extension-test-"));
    const tokenPath = join(directory, "token");
    const outputPath = join(directory, "output.png");
    await writeFile(tokenPath, "test-token\n", { mode: 0o600 });
    const config = loadConfig(
      {
        IMAGE_BRIDGE_BACKEND: "chrome-extension",
        IMAGE_BRIDGE_EXTENSION_PORT: String(address.port),
        IMAGE_BRIDGE_EXTENSION_TOKEN_PATH: tokenPath,
        IMAGE_BRIDGE_OUTPUT_DIR: directory,
      },
      directory,
      directory,
    );

    cleanups.push(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });

    const result = await generateWithChromeExtension({
      config,
      prompt: "test prompt",
      referenceImages: [
        {
          name: "reference.png",
          mimeType: "image/png",
          byteLength: png.length,
          bytesBase64: png.toString("base64"),
        },
      ],
      outputPath,
      headless: true,
    });
    expect(result).toMatchObject({
      outputPath,
      mimeType: "image/png",
      bytes: png.length,
      retrieval: "data-url",
    });
    expect(submittedBody).toMatchObject({
      prompt: "test prompt",
      inputs: [
        {
          name: "reference.png",
          mimeType: "image/png",
          byteLength: png.length,
          bytesBase64: png.toString("base64"),
        },
      ],
    });
    expect(await readFile(outputPath)).toEqual(png);
  });
});
