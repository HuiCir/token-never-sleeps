import { readFile, writeFile, appendFile, mkdir, access, constants } from "node:fs/promises";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, accessSync, constants as fsConstants } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";

export function expandUser(path: string): string {
  if (path.startsWith("~/") || path === "~") {
    const home = process.env.HOME || process.env.USERPROFILE || "/root";
    return resolve(home, path.slice(2));
  }
  return path;
}

export function resolvePath(path: string, base?: string): string {
  const expanded = expandUser(path);
  if (isAbsolute(expanded)) return expanded;
  return resolve(base || process.cwd(), expanded);
}

export async function readJson<T>(path: string, defaultValue?: T): Promise<T | null> {
  try {
    const content = await readFile(expandUser(path), "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return defaultValue ?? null;
  }
}

export function readJsonSync<T>(path: string, defaultValue?: T): T | null {
  try {
    const content = readFileSync(expandUser(path), "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return defaultValue ?? null;
  }
}

export async function writeJson(path: string, payload: unknown): Promise<void> {
  const p = expandUser(path);
  await mkdir(dirname(p), { recursive: true });
  const content = JSON.stringify(payload, null, 2) + "\n";
  await writeFile(p, content, "utf-8");
}

export function writeJsonSync(path: string, payload: unknown): void {
  const p = expandUser(path);
  mkdirSync(dirname(p), { recursive: true });
  const content = JSON.stringify(payload, null, 2) + "\n";
  writeFileSync(p, content, "utf-8");
}

export async function appendJsonl(path: string, payload: Record<string, unknown>): Promise<void> {
  const p = expandUser(path);
  await mkdir(dirname(p), { recursive: true });
  const line = JSON.stringify(payload, null, 0) + "\n";
  await appendFile(p, line, "utf-8");
}

export function appendJsonlSync(path: string, payload: Record<string, unknown>): void {
  const p = expandUser(path);
  mkdirSync(dirname(p), { recursive: true });
  const line = JSON.stringify(payload, null, 0) + "\n";
  appendFileSync(p, line, "utf-8");
}

export async function appendText(path: string, text: string): Promise<void> {
  const p = expandUser(path);
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, text, "utf-8");
}

export function appendTextSync(path: string, text: string): void {
  const p = expandUser(path);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, text, "utf-8");
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(expandUser(path), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function pathExistsSync(path: string): boolean {
  try {
    accessSync(expandUser(path), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
