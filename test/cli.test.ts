import { afterEach, describe, expect, it, vi } from "vitest";

import { run } from "../src/cli.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI contract", () => {
  it("returns a machine-readable error for an unknown option", async () => {
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });

    const exitCode = await run(["--unknown-option"]);
    expect(exitCode).toBe(1);

    const result = JSON.parse(output) as {
      ok: boolean;
      command: string;
      error: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.command).toBe("unknown");
    expect(result.error.code).not.toBe("UNKNOWN");
  });

  it("rejects an unsupported backend with a stable JSON error", async () => {
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });

    const exitCode = await run(["status", "--backend", "unknown"]);
    expect(exitCode).toBe(1);

    const result = JSON.parse(output) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_ARGUMENT");
    expect(result.error.message).toContain("gemini、chatgpt、chrome-extension");
  });

  it("rejects a missing reference image before invoking a backend", async () => {
    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });

    const exitCode = await run([
      "generate",
      "--backend",
      "chrome-extension",
      "--prompt",
      "test",
      "--input",
      "/definitely/missing/reference.png",
    ]);
    expect(exitCode).toBe(1);
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENT" },
    });
  });

  it("does not silently drop reference images on an unsupported backend", async () => {
    const directory = await mkdtemp(join(tmpdir(), "image-bridge-cli-reference-"));
    const input = join(directory, "reference.png");
    await writeFile(
      input,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    let output = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      output += String(chunk);
      return true;
    });
    try {
      const exitCode = await run([
        "generate",
        "--backend",
        "gemini",
        "--prompt",
        "test",
        "--input",
        input,
      ]);
      expect(exitCode).toBe(1);
      expect(JSON.parse(output)).toMatchObject({
        ok: false,
        error: { code: "UNSUPPORTED_INPUT" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
