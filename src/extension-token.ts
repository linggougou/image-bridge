import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export async function readExtensionBridgeToken(path: string): Promise<string> {
  return (await readFile(path, "utf8")).trim();
}

export async function readOrCreateExtensionBridgeToken(path: string): Promise<string> {
  try {
    const existing = await readExtensionBridgeToken(path);
    if (existing) return existing;
  } catch {
    // Create a new token below.
  }

  const token = randomBytes(32).toString("hex");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600).catch(() => undefined);
  return token;
}
