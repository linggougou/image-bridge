import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_GEMINI_URL = "https://gemini.google.com/app";
export const DEFAULT_CHATGPT_URL = "https://chatgpt.com/";

export type BrowserChannel = "chrome" | "msedge" | "bundled";
export type BackendName = "gemini" | "chatgpt" | "chrome-extension";

export type BridgeConfig = {
  homeDir: string;
  backend: BackendName;
  profileDir: string;
  geminiProfileDir: string;
  chatgptProfileDir: string;
  chromeExtensionDir: string;
  outputDir: string;
  geminiUrl: string;
  chatgptUrl: string;
  extensionBridgeHost: "127.0.0.1";
  extensionBridgePort: number;
  extensionBridgeTokenPath: string;
  extensionJobTimeoutMs: number;
  timeoutMs: number;
  navigationTimeoutMs: number;
  loginTimeoutMs: number;
  headless: boolean;
  browserChannel: BrowserChannel;
};

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  return fallback;
}

function parseBrowserChannel(value: string | undefined): BrowserChannel {
  if (value === "msedge" || value === "bundled") return value;
  return "chrome";
}

export function isBackendName(value: string | undefined): value is BackendName {
  return value === "gemini" || value === "chatgpt" || value === "chrome-extension";
}

function parseBackendName(value: string | undefined): BackendName {
  return isBackendName(value) ? value : "gemini";
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

function parseLoopbackHost(value: string | undefined): "127.0.0.1" {
  if (!value || value === "127.0.0.1" || value === "localhost") return "127.0.0.1";
  return "127.0.0.1";
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return value;
}

function resolveConfiguredPath(
  value: string | undefined,
  fallback: string,
  cwd: string,
  home: string,
): string {
  const selected = value?.trim() ? expandHome(value.trim(), home) : fallback;
  return isAbsolute(selected) ? resolve(selected) : resolve(cwd, selected);
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
  home = homedir(),
): BridgeConfig {
  const homeDir = resolveConfiguredPath(
    env.IMAGE_BRIDGE_HOME,
    join(home, ".image-bridge"),
    cwd,
    home,
  );

  const backend = parseBackendName(env.IMAGE_BRIDGE_BACKEND);
  const legacyProfileOverride = env.IMAGE_BRIDGE_PROFILE_DIR;
  const geminiProfileDir = resolveConfiguredPath(
    env.IMAGE_BRIDGE_GEMINI_PROFILE_DIR ?? legacyProfileOverride,
    join(homeDir, "chrome-profile", "gemini"),
    cwd,
    home,
  );
  const chatgptProfileDir = resolveConfiguredPath(
    env.IMAGE_BRIDGE_CHATGPT_PROFILE_DIR,
    join(homeDir, "chrome-profile", "chatgpt"),
    cwd,
    home,
  );
  const chromeExtensionDir = resolveConfiguredPath(
    env.IMAGE_BRIDGE_EXTENSION_DIR,
    join(homeDir, "chrome-extension"),
    cwd,
    home,
  );

  return {
    homeDir,
    backend,
    profileDir:
      backend === "chatgpt"
        ? chatgptProfileDir
        : backend === "chrome-extension"
          ? chromeExtensionDir
          : geminiProfileDir,
    geminiProfileDir,
    chatgptProfileDir,
    chromeExtensionDir,
    outputDir: resolveConfiguredPath(
      env.IMAGE_BRIDGE_OUTPUT_DIR,
      join(cwd, "outputs"),
      cwd,
      home,
    ),
    geminiUrl: env.GEMINI_WEB_URL?.trim() || DEFAULT_GEMINI_URL,
    chatgptUrl: env.CHATGPT_WEB_URL?.trim() || DEFAULT_CHATGPT_URL,
    extensionBridgeHost: parseLoopbackHost(env.IMAGE_BRIDGE_EXTENSION_HOST),
    extensionBridgePort: parsePort(env.IMAGE_BRIDGE_EXTENSION_PORT, 47_831),
    extensionBridgeTokenPath: resolveConfiguredPath(
      env.IMAGE_BRIDGE_EXTENSION_TOKEN_PATH,
      join(homeDir, "extension-bridge-token"),
      cwd,
      home,
    ),
    extensionJobTimeoutMs: parsePositiveInteger(
      env.IMAGE_BRIDGE_EXTENSION_JOB_TIMEOUT_MS,
      300_000,
    ),
    timeoutMs: parsePositiveInteger(env.IMAGE_BRIDGE_TIMEOUT_MS, 180_000),
    navigationTimeoutMs: parsePositiveInteger(env.IMAGE_BRIDGE_NAVIGATION_TIMEOUT_MS, 45_000),
    loginTimeoutMs: parsePositiveInteger(env.IMAGE_BRIDGE_LOGIN_TIMEOUT_MS, 300_000),
    headless: parseBoolean(env.IMAGE_BRIDGE_HEADLESS, true),
    browserChannel: parseBrowserChannel(env.IMAGE_BRIDGE_BROWSER_CHANNEL),
  };
}
