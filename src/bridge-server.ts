import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import {
  DEFAULT_JOB_TTL_MS,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_PROMPT_CHARS,
  EXTENSION_PROTOCOL_VERSION,
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_TOTAL_BYTES,
  type ExtensionBridgeJob,
  type ExtensionBridgeStatus,
  type PublicExtensionJob,
  type WireReferenceImage,
} from "./extension-protocol.js";
import { ImageBridgeError } from "./errors.js";
import { detectImageMime } from "./image.js";

export type ExtensionBridgeServerOptions = {
  host: "127.0.0.1";
  port: number;
  token: string;
  defaultJobTimeoutMs?: number;
  maxBodyBytes?: number;
  maxImageBytes?: number;
  maxPromptChars?: number;
};

type JsonObject = Record<string, unknown>;

function jsonResponse(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  origin?: string,
): void {
  if (origin?.startsWith("chrome-extension://")) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.statusCode = statusCode;
  response.end(JSON.stringify(body));
}

function safeTokenEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function publicJob(job: ExtensionBridgeJob): PublicExtensionJob {
  const inputs = job.inputs?.map(({ bytesBase64: _bytesBase64, ...metadata }) => metadata);
  if (!job.result) {
    const { result: _result, ...rest } = job;
    return { ...rest, ...(inputs ? { inputs } : {}) };
  }
  const { bytesBase64, ...result } = job.result;
  return {
    ...job,
    ...(inputs ? { inputs } : {}),
    result: {
      bytes: Buffer.from(bytesBase64, "base64").length,
      ...result,
    },
  };
}

function normalizeReferenceImages(value: unknown): WireReferenceImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new ImageBridgeError("INVALID_ARGUMENT", "inputs 必须是图片数组。");
  }
  if (value.length > MAX_REFERENCE_IMAGES) {
    throw new ImageBridgeError(
      "INVALID_ARGUMENT",
      `参考图最多支持 ${MAX_REFERENCE_IMAGES} 张。`,
    );
  }

  let totalBytes = 0;
  const images: WireReferenceImage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ImageBridgeError("INVALID_ARGUMENT", "参考图条目格式无效。");
    }
    const candidate = item as Record<string, unknown>;
    const rawName = typeof candidate.name === "string" ? candidate.name : "";
    const name = (rawName.split(/[\\/]/).pop() || "reference-image").slice(0, 200);
    const mimeType = typeof candidate.mimeType === "string" ? candidate.mimeType : "";
    const rawBase64 = typeof candidate.bytesBase64 === "string" ? candidate.bytesBase64 : "";
    const bytesBase64 = rawBase64.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/=]+$/.test(bytesBase64)) {
      throw new ImageBridgeError("INVALID_ARGUMENT", "参考图 base64 数据无效。");
    }
    const bytes = Buffer.from(bytesBase64, "base64");
    if (bytes.length <= 0 || bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
      throw new ImageBridgeError(
        "INVALID_ARGUMENT",
        `单张参考图大小必须在 1 字节到 ${MAX_REFERENCE_IMAGE_BYTES} 字节之间。`,
      );
    }
    totalBytes += bytes.length;
    if (totalBytes > MAX_REFERENCE_TOTAL_BYTES) {
      throw new ImageBridgeError(
        "INVALID_ARGUMENT",
        `参考图总大小不能超过 ${MAX_REFERENCE_TOTAL_BYTES} 字节。`,
      );
    }
    const detectedMime = detectImageMime(bytes);
    if (!detectedMime || detectedMime !== mimeType) {
      throw new ImageBridgeError("INVALID_ARGUMENT", "参考图 MIME 与文件内容不匹配。");
    }
    images.push({ name, mimeType, byteLength: bytes.length, bytesBase64 });
  }
  return images;
}

export class ExtensionBridgeServer {
  readonly host: "127.0.0.1";
  readonly requestedPort: number;
  private readonly token: string;
  private readonly defaultJobTimeoutMs: number;
  private readonly maxBodyBytes: number;
  private readonly maxImageBytes: number;
  private readonly maxPromptChars: number;
  private readonly jobs = new Map<string, ExtensionBridgeJob>();
  private readonly server: Server;
  private extensionConnected = false;
  private chatgptAuthenticated = false;
  private tabReady = false;
  private extensionVersion: string | null = null;
  private tabUrl: string | null = null;
  private lastSeenAt: string | null = null;
  private boundPort: number | null = null;
  private closedPromise: Promise<void>;

  constructor(options: ExtensionBridgeServerOptions) {
    this.host = options.host;
    this.requestedPort = options.port;
    this.token = options.token;
    this.defaultJobTimeoutMs = options.defaultJobTimeoutMs ?? DEFAULT_JOB_TTL_MS;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
    this.maxPromptChars = options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS;
    this.server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.closedPromise = once(this.server, "close").then(() => undefined);
  }

  async start(): Promise<void> {
    this.server.listen(this.requestedPort, this.host);
    await once(this.server, "listening");
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Bridge server did not expose a TCP address.");
    }
    this.boundPort = address.port;
  }

  get port(): number {
    if (this.boundPort === null) throw new Error("Bridge server is not running.");
    return this.boundPort;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return this.closedPromise;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  waitUntilClosed(): Promise<void> {
    return this.closedPromise;
  }

  getStatus(): ExtensionBridgeStatus {
    this.expireJobs();
    const lastSeen = this.lastSeenAt ? Date.parse(this.lastSeenAt) : 0;
    const extensionConnected = this.extensionConnected && Date.now() - lastSeen < 15_000;
    return {
      version: EXTENSION_PROTOCOL_VERSION,
      extensionConnected,
      chatgptAuthenticated: extensionConnected && this.chatgptAuthenticated,
      tabReady: extensionConnected && this.tabReady,
      tabUrl: this.tabUrl,
      extensionVersion: this.extensionVersion,
      lastSeenAt: this.lastSeenAt,
      activeJobId: this.activeClaimedJob()?.id ?? null,
    };
  }

  submitJob(
    prompt: string,
    timeoutMs = this.defaultJobTimeoutMs,
    inputs: WireReferenceImage[] = [],
    referenceFingerprint?: string,
    conversationMode?: "auto" | "new" | "reuse",
  ): PublicExtensionJob {
    if (!prompt.trim()) throw new Error("Prompt must not be empty.");
    if (prompt.length > this.maxPromptChars) throw new Error("Prompt is too long.");

    const now = Date.now();
    const job: ExtensionBridgeJob = {
      id: randomUUID(),
      prompt,
      ...(inputs.length > 0 ? { inputs } : {}),
      ...(inputs.length > 0 && referenceFingerprint
        ? { referenceFingerprint: referenceFingerprint.slice(0, 200) }
        : {}),
      ...(inputs.length > 0 && conversationMode ? { conversationMode } : {}),
      state: "queued",
      createdAt: new Date(now).toISOString(),
      deadlineAt: new Date(now + timeoutMs).toISOString(),
    };
    this.jobs.set(job.id, job);
    return publicJob(job);
  }

  getJob(id: string): PublicExtensionJob | null {
    this.expireJobs();
    const job = this.jobs.get(id);
    return job ? publicJob(job) : null;
  }

  async waitForJob(id: string, timeoutMs: number): Promise<PublicExtensionJob> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = this.getJob(id);
      if (!job) throw new Error("Unknown job.");
      if (job.state === "completed" || job.state === "failed") return job;
      await delay(250);
    }
    throw new Error("Timed out waiting for job.");
  }

  private activeClaimedJob(): ExtensionBridgeJob | null {
    for (const job of this.jobs.values()) {
      if (job.state === "claimed") return job;
    }
    return null;
  }

  private expireJobs(): void {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      if (
        (job.state === "queued" || job.state === "claimed") &&
        Date.parse(job.deadlineAt) <= now
      ) {
        job.state = "failed";
        job.completedAt = new Date(now).toISOString();
        job.error = { code: "TIMEOUT", message: "Bridge job expired before completion." };
      }
    }
  }

  private authorize(request: IncomingMessage, response: ServerResponse): boolean {
    const origin = request.headers.origin;
    if (origin && !origin.startsWith("chrome-extension://")) {
      jsonResponse(response, 403, { error: "unexpected_origin" }, origin);
      return false;
    }

    const authorization = request.headers.authorization ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!safeTokenEqual(token, this.token)) {
      jsonResponse(response, 401, { error: "unauthorized" }, origin);
      return false;
    }
    return true;
  }

  private async readJson(request: IncomingMessage): Promise<JsonObject> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > this.maxBodyBytes) {
        const error = new Error("Request body is too large.");
        Object.assign(error, { statusCode: 413 });
        throw error;
      }
      chunks.push(buffer);
    }
    if (chunks.length === 0) return {};
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON body must be an object.");
    }
    return parsed as JsonObject;
  }

  private async handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const origin = request.headers.origin;
    if (request.method === "OPTIONS") {
      if (!origin?.startsWith("chrome-extension://")) {
        jsonResponse(response, 403, { error: "unexpected_origin" }, origin);
        return;
      }
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Headers", "authorization,content-type");
      response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      response.statusCode = 204;
      response.end();
      return;
    }

    if (!this.authorize(request, response)) return;

    try {
      const url = new URL(request.url ?? "/", `http://${this.host}:${this.port}`);
      if (request.method === "GET" && url.pathname === "/v1/status") {
        jsonResponse(response, 200, this.getStatus(), origin);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/extension/status") {
        const body = await this.readJson(request);
        this.extensionConnected = true;
        this.chatgptAuthenticated = body.authenticated === true;
        this.tabReady = body.tabReady === true;
        this.tabUrl = typeof body.url === "string" ? body.url.slice(0, 2_000) : null;
        this.extensionVersion =
          typeof body.version === "string" ? body.version.slice(0, 40) : null;
        this.lastSeenAt = new Date().toISOString();
        jsonResponse(response, 200, this.getStatus(), origin);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/jobs") {
        const body = await this.readJson(request);
        if (typeof body.prompt !== "string") {
          jsonResponse(response, 400, { error: "prompt_required" }, origin);
          return;
        }
        const timeoutMs =
          typeof body.timeoutMs === "number" && body.timeoutMs > 0
            ? Math.min(body.timeoutMs, 30 * 60_000)
            : this.defaultJobTimeoutMs;
        const inputs = normalizeReferenceImages(body.inputs);
        const referenceFingerprint =
          typeof body.referenceFingerprint === "string" ? body.referenceFingerprint : undefined;
        const conversationMode =
          body.conversationMode === "new" ||
          body.conversationMode === "reuse" ||
          body.conversationMode === "auto"
            ? body.conversationMode
            : undefined;
        jsonResponse(
          response,
          201,
          this.submitJob(
            body.prompt,
            timeoutMs,
            inputs,
            referenceFingerprint,
            conversationMode,
          ),
          origin,
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/jobs/claim") {
        this.extensionConnected = true;
        this.lastSeenAt = new Date().toISOString();
        this.expireJobs();
        if (this.activeClaimedJob()) {
          jsonResponse(response, 409, { error: "job_already_claimed" }, origin);
          return;
        }
        const queued = [...this.jobs.values()]
          .filter((job) => job.state === "queued")
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
        if (!queued) {
          jsonResponse(response, 204, null, origin);
          return;
        }
        queued.state = "claimed";
        queued.claimedAt = new Date().toISOString();
        jsonResponse(response, 200, queued, origin);
        return;
      }

      const jobMatch = /^\/v1\/jobs\/([^/]+)(?:\/result)?$/.exec(url.pathname);
      if (jobMatch?.[1]) {
        const jobId = decodeURIComponent(jobMatch[1]);
        const job = this.jobs.get(jobId);
        if (!job) {
          jsonResponse(response, 404, { error: "unknown_job" }, origin);
          return;
        }

        if (request.method === "GET" && url.pathname === `/v1/jobs/${jobId}`) {
          jsonResponse(response, 200, publicJob(job), origin);
          return;
        }

        if (request.method === "GET" && url.pathname === `/v1/jobs/${jobId}/result`) {
          if (job.state !== "completed" || !job.result) {
            jsonResponse(response, 409, { error: "job_result_not_ready" }, origin);
            return;
          }
          jsonResponse(response, 200, job.result, origin);
          return;
        }

        if (request.method === "POST" && url.pathname === `/v1/jobs/${jobId}/result`) {
          const body = await this.readJson(request);
          if (body.ok !== true) {
            const error = body.error as JsonObject | undefined;
            job.state = "failed";
            job.completedAt = new Date().toISOString();
            job.error = {
              code: typeof error?.code === "string" ? error.code : "EXTENSION_FAILED",
              message:
                typeof error?.message === "string"
                  ? error.message.slice(0, 2_000)
                  : "Extension reported failure.",
            };
            jsonResponse(response, 200, publicJob(job), origin);
            return;
          }

          const bytesBase64 = typeof body.bytesBase64 === "string" ? body.bytesBase64 : "";
          if (!/^[A-Za-z0-9+/=\s]+$/.test(bytesBase64)) {
            jsonResponse(response, 400, { error: "invalid_image_data" }, origin);
            return;
          }
          const bytes = Buffer.from(bytesBase64, "base64");
          if (bytes.length === 0 || bytes.length > this.maxImageBytes) {
            jsonResponse(response, 413, { error: "invalid_image_size" }, origin);
            return;
          }
          job.state = "completed";
          job.completedAt = new Date().toISOString();
          job.result = {
            bytesBase64,
            mimeType: typeof body.mimeType === "string" ? body.mimeType : "application/octet-stream",
            retrieval: "data-url",
            modelUrl: typeof body.modelUrl === "string" ? body.modelUrl.slice(0, 2_000) : "",
          };
          jsonResponse(response, 200, publicJob(job), origin);
          return;
        }
      }

      jsonResponse(response, 404, { error: "not_found" }, origin);
    } catch (error) {
      const statusCode =
        typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode?: number }).statusCode)
          : 400;
      jsonResponse(
        response,
        Number.isFinite(statusCode) ? statusCode : 400,
        { error: error instanceof Error ? error.message : "bad_request" },
        origin,
      );
    }
  }
}
