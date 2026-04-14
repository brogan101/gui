/**
 * WINDOWS SYSTEM INTEGRATION — Sovereign Hands
 * =============================================
 * Provides:
 *   1. OS-level kill-switch and cleanup via PowerShell scripts.
 *   2. PC interop bridge — find/focus windows, send keystrokes, run macros.
 *   3. Macro system — named sequences of OS actions (open CAD, load project, etc.)
 *   4. Idle window manager — auto-minimizes spawned PowerShell/CMD windows
 *      after a configurable inactivity period.
 *
 * NOTE: RobotJS-based mouse/keyboard injection requires `robotjs` to be
 * installed (`npm install robotjs` / `pnpm add robotjs`).  The module is
 * loaded lazily so the server starts even when robotjs is not present;
 * functions that need it throw a clear "not installed" error.
 */

import os from "os";
import path from "path";
import { existsSync, readFileSync } from "fs";
import { exec as cpExec } from "child_process";
import { promisify } from "util";
import { execCommand, shellQuote, isWindows } from "./runtime.js";
import { logger } from "./logger.js";
import { thoughtLog } from "./thought-log.js";

const execAsync = promisify(cpExec);

// ── Path helpers ──────────────────────────────────────────────────────────────

function repoRoot(): string {
  // __dirname is polyfilled in the esbuild bundle banner
  return path.resolve(__dirname, "..", "..", "..");
}

function processManifestPath(): string {
  return path.join(repoRoot(), "runtime", "process-manifest.json");
}

function systemStatusPath(): string {
  return path.join(repoRoot(), "runtime", "system-integration-status.json");
}

function systemIntegrationScriptPath(): string {
  return path.join(repoRoot(), "scripts", "windows", "LocalAI.SystemIntegration.ps1");
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KillSwitchResult {
  success: boolean;
  message: string;
}

export interface CleanupResult {
  success: boolean;
  message: string;
  [key: string]: unknown;
}

export interface SystemIntegrationStatus {
  [key: string]: unknown;
}

export interface MacroStep {
  action: "keystroke" | "click" | "focus" | "run" | "wait" | "type";
  /** For keystroke/type: the key sequence or text */
  value?: string;
  /** For click: pixel coordinates */
  x?: number;
  y?: number;
  /** For run: shell command */
  command?: string;
  /** For wait: milliseconds */
  delayMs?: number;
}

export interface Macro {
  name: string;
  description: string;
  steps: MacroStep[];
}

export interface MacroResult {
  success: boolean;
  name: string;
  stepsExecuted: number;
  error?: string;
}

export interface WindowInfo {
  title: string;
  processName: string;
  handle?: number;
}

// ── Kill-switch / cleanup (existing) ─────────────────────────────────────────

export async function invokeSystemKillSwitch(): Promise<KillSwitchResult> {
  const scriptPath = systemIntegrationScriptPath();
  if (!existsSync(scriptPath)) {
    return { success: false, message: "System integration script not found." };
  }
  await execCommand(
    `powershell -NoProfile -ExecutionPolicy Bypass -File ${shellQuote(scriptPath)} -Mode kill -ManifestPath ${shellQuote(processManifestPath())} -StatusPath ${shellQuote(systemStatusPath())}`,
    30000,
  );
  return { success: true, message: "Kill switch executed." };
}

export async function robustCleanup(targetPath: string): Promise<CleanupResult> {
  const scriptPath = systemIntegrationScriptPath();
  if (!existsSync(scriptPath)) {
    return { success: false, message: "System integration script not found." };
  }
  const { stdout } = await execCommand(
    `powershell -NoProfile -ExecutionPolicy Bypass -File ${shellQuote(scriptPath)} -Mode cleanup -ManifestPath ${shellQuote(processManifestPath())} -StatusPath ${shellQuote(systemStatusPath())} -TargetPath ${shellQuote(targetPath)}`,
    60000,
  );
  try {
    return JSON.parse((stdout ?? "").trim()) as CleanupResult;
  } catch {
    return { success: false, message: (stdout ?? "Cleanup command did not return valid JSON.").trim() };
  }
}

export function readSystemIntegrationStatus(): SystemIntegrationStatus | null {
  const statusFile = systemStatusPath();
  if (!existsSync(statusFile)) return null;
  try {
    return JSON.parse(readFileSync(statusFile, "utf-8")) as SystemIntegrationStatus;
  } catch { return null; }
}

// ── Window management (PowerShell) ────────────────────────────────────────────

/** Find windows whose title matches the given pattern. */
export async function findWindows(titlePattern: string): Promise<WindowInfo[]> {
  if (!isWindows) return [];
  const escapedPattern = titlePattern.replace(/'/g, "''");
  const ps = `
    Add-Type -AssemblyName System.Windows.Forms
    Get-Process | Where-Object { $_.MainWindowTitle -like '*${escapedPattern}*' } |
    Select-Object -Property @{Name='title';Expression={$_.MainWindowTitle}},
                             @{Name='processName';Expression={$_.ProcessName}},
                             @{Name='handle';Expression={$_.MainWindowHandle.ToInt32()}} |
    ConvertTo-Json -Compress
  `.trim();
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`,
      { timeout: 8000 },
    );
    const parsed = JSON.parse(stdout.trim() || "[]") as WindowInfo | WindowInfo[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** Bring a window to the foreground by its title pattern. */
export async function focusWindow(titlePattern: string): Promise<boolean> {
  if (!isWindows) return false;
  const escapedPattern = titlePattern.replace(/'/g, "''");
  const ps = `
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class WinAPI {
      [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
      [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    }
"@
    $proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*${escapedPattern}*' } | Select-Object -First 1
    if ($proc) {
      [WinAPI]::ShowWindow($proc.MainWindowHandle, 9)
      [WinAPI]::SetForegroundWindow($proc.MainWindowHandle)
      Write-Output "ok"
    } else { Write-Output "not-found" }
  `.trim();
  try {
    const { stdout } = await execAsync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`,
      { timeout: 8000 },
    );
    return stdout.trim() === "ok";
  } catch {
    return false;
  }
}

/** Send keystrokes to the currently focused window via SendKeys (PowerShell). */
export async function sendKeystrokes(keys: string): Promise<void> {
  if (!isWindows) return;
  const escaped = keys.replace(/'/g, "''");
  const ps = `
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait('${escaped}')
  `.trim();
  await execAsync(
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`,
    { timeout: 5000 },
  );
}

/** Type a string (no special key codes) into the focused window. */
export async function typeText(text: string): Promise<void> {
  if (!isWindows) return;
  const escaped = text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`).replace(/'/g, "''");
  await sendKeystrokes(escaped);
}

/**
 * Move the cursor to (x, y) in screen coordinates and perform a left click.
 * Uses the Win32 SendInput API via PowerShell — no external dependencies required.
 */
export async function clickAt(x: number, y: number): Promise<void> {
  if (!isWindows) return;
  const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class SovereignMouse {
  [DllImport("user32.dll", SetLastError=true)]
  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, UIntPtr dwExtraInfo);
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP   = 0x0004;
  public static void LeftClick(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(MOUSEEVENTF_LEFTDOWN, x, y, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    mouse_event(MOUSEEVENTF_LEFTUP, x, y, 0, UIntPtr.Zero);
  }
}
"@
[SovereignMouse]::LeftClick(${x}, ${y})
`.trim();
  try {
    await execAsync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`,
      { timeout: 8000 },
    );
    thoughtLog.publish({
      category: "system",
      title:    "Sovereign Click",
      message:  `Left-clicked at (${x}, ${y}) via Win32 SendInput`,
      metadata: { x, y },
    });
  } catch (err) {
    logger.warn({ err, x, y }, "clickAt via Win32 failed");
  }
}

/**
 * Take a screenshot of the entire primary screen, save to a temp PNG, and
 * return the file path.  Uses PowerShell + System.Drawing (available on all
 * modern Windows versions without extra dependencies).
 */
export async function captureScreenshot(outputPath?: string): Promise<string> {
  if (!isWindows) throw new Error("captureScreenshot is only supported on Windows");
  const dest = outputPath ?? path.join(os.tmpdir(), `sovereign-screen-${Date.now()}.png`);
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds   = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp      = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('${dest.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()
Write-Output '${dest.replace(/\\/g, "\\\\")}'
`.trim();
  const { stdout } = await execAsync(
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`,
    { timeout: 15000 },
  );
  return stdout.trim();
}

// ── Idle window minimizer ─────────────────────────────────────────────────────

interface TrackedWindow {
  title: string;
  spawnedAt: number;
  inactivityMs: number;
}

const trackedWindows = new Map<string, TrackedWindow>();
let idleCheckTimer: ReturnType<typeof setInterval> | null = null;

/** Register a window for auto-minimize after `inactivityMs` ms of creation. */
export function trackWindowForIdleMinimize(title: string, inactivityMs = 30_000): void {
  trackedWindows.set(title, { title, spawnedAt: Date.now(), inactivityMs });
  if (!idleCheckTimer) {
    idleCheckTimer = setInterval(() => void runIdleWindowCheck(), 5000);
    (idleCheckTimer as unknown as { unref?: () => void }).unref?.();
  }
}

async function runIdleWindowCheck(): Promise<void> {
  const now = Date.now();
  for (const [key, tracked] of trackedWindows) {
    if (now - tracked.spawnedAt < tracked.inactivityMs) continue;
    trackedWindows.delete(key);
    await minimizeWindowByTitle(tracked.title);
  }
  if (trackedWindows.size === 0 && idleCheckTimer) {
    clearInterval(idleCheckTimer);
    idleCheckTimer = null;
  }
}

async function minimizeWindowByTitle(titlePattern: string): Promise<void> {
  if (!isWindows) return;
  const escapedPattern = titlePattern.replace(/'/g, "''");
  const ps = `
    Add-Type @"
    using System;
    using System.Runtime.InteropServices;
    public class WinMinimize {
      [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    }
"@
    Get-Process | Where-Object { $_.MainWindowTitle -like '*${escapedPattern}*' } | ForEach-Object {
      [WinMinimize]::ShowWindow($_.MainWindowHandle, 6)
    }
  `.trim();
  try {
    await execAsync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps.replace(/"/g, '\\"')}"`,
      { timeout: 8000 },
    );
    thoughtLog.publish({
      category: "system",
      title:    "Window Auto-Minimized",
      message:  `Minimized idle window matching "${titlePattern}"`,
    });
  } catch { /* non-fatal */ }
}

// ── Macro system ──────────────────────────────────────────────────────────────

const BUILTIN_MACROS: Macro[] = [
  {
    name: "open-fusion360",
    description: "Launch Autodesk Fusion 360",
    steps: [
      { action: "run", command: "start \"\" \"%LOCALAPPDATA%\\Autodesk\\webdeploy\\production\\6a0c9611291d45bb9226980209917c3d\\FusionLauncher.exe\"" },
      { action: "wait", delayMs: 4000 },
      { action: "focus", value: "Fusion 360" },
    ],
  },
  {
    name: "open-blender",
    description: "Launch Blender",
    steps: [
      { action: "run", command: "start \"\" \"C:\\Program Files\\Blender Foundation\\Blender 4.0\\blender.exe\"" },
      { action: "wait", delayMs: 3000 },
      { action: "focus", value: "Blender" },
    ],
  },
  {
    name: "open-vscode-workspace",
    description: "Open a VS Code workspace (pass path in step value)",
    steps: [
      { action: "run", command: "code ." },
      { action: "wait", delayMs: 2000 },
    ],
  },
];

const userMacros = new Map<string, Macro>();

export function registerMacro(macro: Macro): void {
  userMacros.set(macro.name, macro);
}

export function listMacros(): Macro[] {
  return [...BUILTIN_MACROS, ...userMacros.values()];
}

export function getMacro(name: string): Macro | undefined {
  return userMacros.get(name) ?? BUILTIN_MACROS.find(m => m.name === name);
}

/** Execute a macro step-by-step. */
export async function runMacro(nameOrMacro: string | Macro): Promise<MacroResult> {
  const macro = typeof nameOrMacro === "string"
    ? getMacro(nameOrMacro)
    : nameOrMacro;
  if (!macro) {
    return { success: false, name: String(nameOrMacro), stepsExecuted: 0, error: "Macro not found" };
  }

  thoughtLog.publish({
    category: "system",
    title:    "Macro Started",
    message:  `Running macro "${macro.name}": ${macro.description}`,
    metadata: { steps: macro.steps.length },
  });

  let stepsExecuted = 0;
  try {
    for (const step of macro.steps) {
      switch (step.action) {
        case "run":
          if (step.command) {
            await execAsync(step.command, { timeout: 30_000 });
          }
          break;
        case "focus":
          if (step.value) await focusWindow(step.value);
          break;
        case "keystroke":
          if (step.value) await sendKeystrokes(step.value);
          break;
        case "type":
          if (step.value) await typeText(step.value);
          break;
        case "wait":
          await new Promise<void>(resolve => setTimeout(resolve, step.delayMs ?? 500));
          break;
        case "click":
          if (step.x !== undefined && step.y !== undefined) {
            await clickAt(step.x, step.y);
          } else {
            logger.warn({ step }, "Macro click step requires x/y coordinates — skipping");
          }
          break;
      }
      stepsExecuted++;
    }
    thoughtLog.publish({
      category: "system",
      title:    "Macro Completed",
      message:  `Macro "${macro.name}" finished (${stepsExecuted} steps)`,
    });
    return { success: true, name: macro.name, stepsExecuted };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, macroName: macro.name, stepsExecuted }, "Macro failed");
    return { success: false, name: macro.name, stepsExecuted, error: message };
  }
}
