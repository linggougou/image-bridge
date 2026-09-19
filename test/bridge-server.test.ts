import { afterEach, describe, expect, it } from "vitest";

import { ExtensionBridgeServer } from "../src/bridge-server.js";

const servers: ExtensionBridgeServer[] = [];

async function startServer(): Promise<ExtensionBridgeServer> {
  const server = new ExtensionBridgeServer({
    host: "127.0.0.1",
    port: 0,
    token: "test-token",
    defaultJobTimeoutMs: 5_000,
  });
  await server.start();
  servers.push(server);
  return server;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: "Bearer test-token",
    "Content-Type": "application/json",
    ...extra,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("extension bridge server", () => {
  it("rejects invalid credentials and unexpected origins", async () => {
    const server = await startServer();
    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/v1/status`);
    expect(unauthorized.status).toBe(401);

    const originRejected = await fetch(`http://127.0.0.1:${server.port}/v1/status`, {
      headers: headers({ Origin: "https://example.com" }),
    });
    expect(originRejected.status).toBe(403);
  });

  it("queues, claims, completes, and returns one image job", async () => {
    const server = await startServer();
    const submittedResponse = await fetch(`http://127.0.0.1:${server.port}/v1/jobs`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ prompt: "green leaf", timeoutMs: 5_000 }),
    });
    expect(submittedResponse.status).toBe(201);
    const submitted = (await submittedResponse.json()) as { id: string };

    const extensionHeaders = headers({ Origin: "chrome-extension://test" });
    const statusResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/extension/status`,
      {
        method: "POST",
        headers: extensionHeaders,
        body: JSON.stringify({
          authenticated: true,
          tabReady: true,
          url: "https://chatgpt.com/?image-bridge=1",
        }),
      },
    );
    expect(statusResponse.status).toBe(200);

    const claimedResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/jobs/claim`,
      { method: "POST", headers: extensionHeaders },
    );
    expect(claimedResponse.status).toBe(200);
    expect((await claimedResponse.json()) as { id: string }).toMatchObject({
      id: submitted.id,
      state: "claimed",
    });

    const duplicateClaim = await fetch(
      `http://127.0.0.1:${server.port}/v1/jobs/claim`,
      { method: "POST", headers: extensionHeaders },
    );
    expect(duplicateClaim.status).toBe(409);

    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]).toString("base64");
    const completeResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/jobs/${submitted.id}/result`,
      {
        method: "POST",
        headers: extensionHeaders,
        body: JSON.stringify({
          ok: true,
          bytesBase64: png,
          mimeType: "image/png",
          retrieval: "data-url",
          modelUrl: "https://chatgpt.com/",
        }),
      },
    );
    expect(completeResponse.status).toBe(200);

    const resultResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/jobs/${submitted.id}/result`,
      { headers: headers() },
    );
    expect(resultResponse.status).toBe(200);
    expect(await resultResponse.json()).toMatchObject({
      bytesBase64: png,
      mimeType: "image/png",
      retrieval: "data-url",
    });
  });

  it("records extension failures in the job result", async () => {
    const server = await startServer();
    const job = server.submitJob("test prompt", 5_000);
    const extensionHeaders = headers({ Origin: "chrome-extension://test" });
    await fetch(`http://127.0.0.1:${server.port}/v1/jobs/claim`, {
      method: "POST",
      headers: extensionHeaders,
    });

    await fetch(`http://127.0.0.1:${server.port}/v1/jobs/${job.id}/result`, {
      method: "POST",
      headers: extensionHeaders,
      body: JSON.stringify({
        ok: false,
        error: { code: "NOT_AUTHENTICATED", message: "login required" },
      }),
    });

    expect(server.getJob(job.id)).toMatchObject({
      state: "failed",
      error: { code: "NOT_AUTHENTICATED", message: "login required" },
    });
  });

  it("carries validated reference images to the claiming extension and redacts public jobs", async () => {
    const server = await startServer();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const submittedResponse = await fetch(`http://127.0.0.1:${server.port}/v1/jobs`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        prompt: "reference prompt",
        inputs: [
          {
            name: "reference.png",
            mimeType: "image/png",
            bytesBase64: png.toString("base64"),
          },
        ],
      }),
    });
    expect(submittedResponse.status).toBe(201);
    const submitted = (await submittedResponse.json()) as {
      id: string;
      inputs: Array<Record<string, unknown>>;
    };
    expect(submitted.inputs).toEqual([
      { name: "reference.png", mimeType: "image/png", byteLength: png.length },
    ]);
    expect(submitted.inputs[0]).not.toHaveProperty("bytesBase64");

    const extensionHeaders = headers({ Origin: "chrome-extension://test" });
    const claimedResponse = await fetch(
      `http://127.0.0.1:${server.port}/v1/jobs/claim`,
      { method: "POST", headers: extensionHeaders },
    );
    expect(claimedResponse.status).toBe(200);
    const claimed = (await claimedResponse.json()) as {
      inputs: Array<{ bytesBase64: string; byteLength: number }>;
    };
    expect(claimed.inputs).toEqual([
      { name: "reference.png", mimeType: "image/png", byteLength: png.length, bytesBase64: png.toString("base64") },
    ]);

    const publicJob = await fetch(
      `http://127.0.0.1:${server.port}/v1/jobs/${submitted.id}`,
      { headers: headers() },
    );
    expect(await publicJob.json()).toMatchObject({
      inputs: [{ name: "reference.png", mimeType: "image/png", byteLength: png.length }],
    });
  });

  it("rejects malformed reference images without queueing a job", async () => {
    const server = await startServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/jobs`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        prompt: "reference prompt",
        inputs: [
          {
            name: "bad.png",
            mimeType: "image/jpeg",
            bytesBase64: Buffer.from("not-image").toString("base64"),
          },
        ],
      }),
    });
    expect(response.status).toBe(400);
    expect(server.getJob("missing")).toBeNull();
  });
});
