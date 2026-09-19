import { normalizeError, type ImageBridgeError } from "./errors.js";

export type BridgeSuccess<T extends Record<string, unknown>> = {
  ok: true;
  command: string;
} & T;

export type BridgeFailure = {
  ok: false;
  command: string;
  error: {
    code: string;
    message: string;
  };
};

export function successResult<T extends Record<string, unknown>>(
  command: string,
  data: T,
): BridgeSuccess<T> {
  return { ok: true, command, ...data };
}

export function failureResult(command: string, error: unknown): BridgeFailure {
  const normalized = normalizeError(error);
  return {
    ok: false,
    command,
    error: {
      code: normalized.code,
      message: normalized.message,
    },
  };
}

export function writeJsonResult(
  result: BridgeSuccess<Record<string, unknown>> | BridgeFailure,
  stream: NodeJS.WritableStream = process.stdout,
): void {
  stream.write(`${JSON.stringify(result)}\n`);
}

