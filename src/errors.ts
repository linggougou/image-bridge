export type ImageBridgeErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_AUTHENTICATED"
  | "SESSION_EXPIRED"
  | "TIMEOUT"
  | "UI_CHANGED"
  | "IMAGE_NOT_FOUND"
  | "IMAGE_RETRIEVAL_FAILED"
  | "OUTPUT_EXISTS"
  | "BROWSER_FAILED"
  | "BRIDGE_UNAVAILABLE"
  | "EXTENSION_UNAVAILABLE"
  | "TAB_NOT_READY"
  | "PROTOCOL_ERROR"
  | "UNSUPPORTED_INPUT"
  | "REFERENCE_IMAGE_UPLOAD_FAILED"
  | "REFERENCE_IMAGE_NOT_SUBMITTED"
  | "FILESYSTEM_FAILED"
  | "UNKNOWN";

export class ImageBridgeError extends Error {
  readonly code: ImageBridgeErrorCode;

  constructor(code: ImageBridgeErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ImageBridgeError";
    this.code = code;
  }
}

export function normalizeError(error: unknown): ImageBridgeError {
  if (error instanceof ImageBridgeError) {
    return error;
  }

  if (error instanceof Error) {
    return new ImageBridgeError("UNKNOWN", error.message, error);
  }

  return new ImageBridgeError("UNKNOWN", String(error), error);
}
