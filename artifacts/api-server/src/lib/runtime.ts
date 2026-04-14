import { exec as cpExec } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";

const execAsync = promisify(cpExec);
export const isWindows = process.platform === "win32";

export async function execCommand(
  command: string,
  timeout = 20000,
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  return execAsync(command, {
    timeout,
    cwd,
    windowsHide: true,
    maxBuffer: 1024 * 1024 * 16,
  });
}

export async function commandExists(command: string): Promise<boolean> {
  const lookup = isWindows ? `where ${command}` : `command -v ${command}`;
  try {
    await execCommand(lookup, 5000);
    return true;
  } catch {
    return false;
  }
}

export async function maybeVersion(command: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execCommand(command, 8000);
    const text = (stdout || stderr || "").trim();
    return text.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

export async function fetchJson<T = unknown>(
  url: string,
  init?: RequestInit,
  timeoutMs = 5000,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchText(
  url: string,
  init?: RequestInit,
  timeoutMs = 5000,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  timeoutMs = 15000,
): Promise<T> {
  return fetchJson<T>(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    timeoutMs,
  );
}

export async function ollamaReachable(): Promise<boolean> {
  try {
    await fetchJson("http://127.0.0.1:11434/api/tags", undefined, 2500);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
}

export function toolsRoot(): string {
  return path.join(os.homedir(), "LocalAI-Tools");
}

export function shellQuote(value: string): string {
  if (isWindows) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
