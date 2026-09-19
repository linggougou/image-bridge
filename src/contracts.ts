import type { BackendName } from "./config.js";

export type ReferenceImageInput = {
  name: string;
  mimeType: string;
  byteLength: number;
  bytesBase64: string;
};

export type GeneratedImageResult = {
  outputPath: string;
  mimeType: string;
  bytes: number;
  retrieval: "download" | "data-url";
  prompt: string;
  modelUrl: string;
};

export type BackendLoginResult = {
  backend: BackendName;
  profileDir: string;
  url: string;
};

export type BackendStatus = {
  backend: BackendName;
  authenticated: boolean;
  url: string;
  profileDir: string;
};
