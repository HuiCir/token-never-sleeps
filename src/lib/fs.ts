import { readFile, writeFile, appendFile, mkdir, access, constants, rm, rename } from "node:fs/promises";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, accessSync, constants as fsConstants, renameSync } from "node:fs";
import { dirname, resolve, isAbsolute } from "node:path";

let atomicWriteCounter = 0;

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
  await atomicWriteFile(p, content);
}

export function writeJsonSync(path: string, payload: unknown): void {
  const p = expandUser(path);
  mkdirSync(dirname(p), { recursive: true });
  const content = JSON.stringify(payload, null, 2) + "\n";
  atomicWriteFileSync(p, content);
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

export async function writeText(path: string, text: string): Promise<void> {
  const p = expandUser(path);
  await mkdir(dirname(p), { recursive: true });
  await atomicWriteFile(p, text);
}

export async function removePath(path: string): Promise<void> {
  await rm(expandUser(path), { force: true, recursive: false });
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

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  const p = expandUser(path);
  const dir = dirname(p);
  await mkdir(dir, { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${atomicWriteCounter++}`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, p);
}

export function atomicWriteFileSync(path: string, content: string): void {
  const p = expandUser(path);
  const dir = dirname(p);
  mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}-${atomicWriteCounter++}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, p);
}
