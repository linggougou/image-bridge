import { describe, expect, it } from "vitest";

import { ImageBridgeError } from "../src/errors.js";
import { failureResult, successResult } from "../src/result.js";

describe("result contracts", () => {
  it("builds a success result", () => {
    expect(successResult("status", { authenticated: true })).toEqual({
      ok: true,
      command: "status",
      authenticated: true,
    });
  });

  it("builds a stable failure result", () => {
    expect(
      failureResult(
        "generate",
        new ImageBridgeError("NOT_AUTHENTICATED", "login required"),
      ),
    ).toEqual({
      ok: false,
      command: "generate",
      error: {
        code: "NOT_AUTHENTICATED",
        message: "login required",
      },
    });
  });
});

