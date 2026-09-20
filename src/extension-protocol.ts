export const EXTENSION_PROTOCOL_VERSION = 1;
export const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const DEFAULT_MAX_PROMPT_CHARS = 8_000;
export const DEFAULT_JOB_TTL_MS = 5 * 60_000;
export const MAX_REFERENCE_IMAGES = 4;
export const MAX_REFERENCE_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_REFERENCE_TOTAL_BYTES = 20 * 1024 * 1024;

export type WireReferenceImage = {
  name: string;
  mimeType: string;
  byteLength: number;
  bytesBase64: string;
};

export type PublicReferenceImage = Omit<WireReferenceImage, "bytesBase64">;

export type ExtensionBridgeStatus = {
  version: number;
  extensionConnected: boolean;
  chatgptAuthenticated: boolean;
  tabReady: boolean;
  tabUrl: string | null;
  extensionVersion: string | null;
  lastSeenAt: string | null;
  activeJobId: string | null;
};

export type ExtensionJobState = "queued" | "claimed" | "completed" | "failed";

export type ExtensionBridgeJob = {
  id: string;
  prompt: string;
  inputs?: WireReferenceImage[];
  referenceFingerprint?: string;
  conversationMode?: "auto" | "new" | "reuse";
  state: ExtensionJobState;
  createdAt: string;
  deadlineAt: string;
  claimedAt?: string;
  completedAt?: string;
  error?: {
    code: string;
    message: string;
  };
  result?: {
    bytesBase64: string;
    mimeType: string;
    retrieval: "data-url";
    modelUrl: string;
  };
};

export type PublicExtensionJob = Omit<ExtensionBridgeJob, "result" | "inputs"> & {
  inputs?: PublicReferenceImage[];
  result?: {
    bytes: number;
    mimeType: string;
    retrieval: "data-url";
    modelUrl: string;
  };
};
