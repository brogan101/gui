import { Router } from "express";
import { exec } from "child_process";
import { promisify } from "util";
import { readFile, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { execCommand, toolsRoot } from "../lib/runtime.js";
import { writeManagedJson } from "../lib/snapshot-manager.js";
import {
  invokeSystemKillSwitch, robustCleanup, readSystemIntegrationStatus,
  findWindows, focusWindow, runMacro, listMacros, registerMacro,
  type Macro,
} from "../lib/windows-system.js";
import {
  sovereignEdit, proposeSelfEdit, triggerServerRestart,
} from "../lib/self-edit.js";
import { taskQueue } from "../lib/task-queue.js";
import { thoughtLog } from "../lib/thought-log.js";

const execAsync = promisify(exec);
const router = Router();
const HOME = os.homedir();
const TOOLS_DIR = path.join(HOME, "LocalAI-Tools");
const ACTIVITY_FILE = path.join(TOOLS_DIR, "activity.json");

async function httpReachable(url: string, timeout = 2500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function appendActivity(action: string, status: string, message: string, component?: string): Promise<void> {
  let entries: any[] = [];
  try {
    if (existsSync(ACTIVITY_FILE)) {
      const content = await readFile(ACTIVITY_FILE, "utf-8");
      entries = JSON.parse(content);
    }
  } catch {}
  entries.unshift({ id: randomUUID(), timestamp: new Date().toISOString(), action, component, status, message });
  entries = entries.slice(0, 200);
  try {
    if (!existsSync(TOOLS_DIR)) await mkdir(TOOLS_DIR, { recursive: true });
    await writeManagedJson(ACTIVITY_FILE, entries);
  } catch {}
}

async function tryVersion(cmd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync(cmd, { timeout: 5000 });
    return stdout.trim().split("\n")[0];
  } catch {
    return undefined;
  }
}

async function getDirSize(dirPath: string): Promise<number> {
  if (!existsSync(dirPath)) return 0;
  async function walk(currentPath: string): Promise<number> {
    try {
      const stats = await stat(currentPath);
      if (!stats.isDirectory()) return stats.size;
      const { readdir } = await import("fs/promises");
      const entries = await readdir(currentPath, { withFileTypes: true });
      let total = 0;
      for (const entry of entries) {
        total += await walk(path.join(currentPath, entry.name));
      }
      return total;
    } catch {
      return 0;
    }
  }
  return await walk(dirPath);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + " GB";
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + " MB";
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(1) + " KB";
  return bytes + " B";
}

router.get("/system/diagnostics", async (_req, res) => {
  const items: any[] = [];
  items.push({ category: "System", label: "OS", status: "ok", value: os.platform() + " " + os.arch() + " " + os.release() });
  items.push({ category: "System", label: "Hostname", status: "ok", value: os.hostname() });
  items.push({ category: "System", label: "Home Directory", status: "ok", value: HOME });
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memUsed = totalMem - freeMem;
  const memPct = Math.round((memUsed / totalMem) * 100);
  items.push({ category: "System", label: "Memory", status: memPct > 90 ? "warning" : "ok", value: `${formatBytes(memUsed)} / ${formatBytes(totalMem)} (${memPct}%)` });
  const cpuCount = os.cpus().length;
  items.push({ category: "System", label: "CPU Cores", status: "ok", value: String(cpuCount) });
  const ollamaVersion = await tryVersion("ollama --version");
  const ollamaRunning = await httpReachable("http://127.0.0.1:11434/api/tags");
  items.push({ category: "AI Stack", label: "Ollama", status: !!ollamaVersion ? (ollamaRunning ? "ok" : "warning") : "error", value: ollamaVersion || "Not installed", details: ollamaRunning ? "Running on port 11434" : ollamaVersion ? "Installed but not running" : "Not installed" });
  const webuiRunning = await httpReachable("http://127.0.0.1:8080");
  items.push({ category: "AI Stack", label: "Open WebUI", status: webuiRunning ? "ok" : "warning", value: webuiRunning ? "Running on port 8080" : "Not running" });
  const litellmRunning = await httpReachable("http://127.0.0.1:4000/health");
  items.push({ category: "AI Stack", label: "LiteLLM Gateway", status: litellmRunning ? "ok" : "unknown", value: litellmRunning ? "Running on port 4000" : "Not running (optional)" });
  const tools = [
    { label: "Python", cmd: "python --version || python3 --version" },
    { label: "Node.js", cmd: "node --version" },
    { label: "Git", cmd: "git --version" },
    { label: "GitHub CLI", cmd: "gh --version" },
    { label: ".NET SDK", cmd: "dotnet --version" },
    { label: "VS Code", cmd: "code --version" },
    { label: "Aider", cmd: "aider --version" },
    { label: "Cargo/Rust", cmd: "cargo --version" },
    { label: "cloudflared", cmd: "cloudflared --version" },
  ];
  for (const tool of tools) {
    const version = await tryVersion(tool.cmd);
    items.push({ category: "Dev Tools", label: tool.label, status: version ? "ok" : "warning", value: version || "Not found" });
  }
  const paths = [
    { label: "LocalAI-Tools", path: TOOLS_DIR },
    { label: "LocalAI-OpenWebUI", path: path.join(HOME, "LocalAI-OpenWebUI") },
    { label: "Continue Config", path: path.join(HOME, ".continue") },
    { label: "LocalAI-Backups", path: path.join(HOME, "LocalAI-Backups") },
  ];
  for (const p of paths) {
    items.push({ category: "Paths", label: p.label, status: existsSync(p.path) ? "ok" : "warning", value: existsSync(p.path) ? "Found" : "Missing", details: p.path });
  }
  const recommendations: string[] = [];
  const errors = items.filter((i) => i.status === "error");
  const warnings = items.filter((i) => i.status === "warning");
  if (errors.length > 0) recommendations.push(`Fix ${errors.length} critical issue(s)`);
  if (warnings.length > 0) recommendations.push(`Review ${warnings.length} warning(s) for improvements`);
  if (errors.length === 0 && warnings.length === 0) recommendations.push("System looks healthy!");
  return res.json({ items, generatedAt: new Date().toISOString(), recommendations });
});

router.get("/system/logs", async (req, res) => {
  const source = req.query.source || "all";
  const lines = parseInt(String(req.query.lines || "100"), 10);
  const logLines: any[] = [];
  const ollamaLogPaths = [
    path.join(HOME, "AppData/Local/Ollama/logs/server.log"),
    "/var/log/ollama.log",
    "/tmp/ollama.log",
  ];
  const webuiLogPaths = [
    path.join(HOME, "LocalAI-OpenWebUI/webui.log"),
    "/tmp/open-webui.log",
  ];
  async function readLogFile(filePath: string, src: string): Promise<void> {
    if (!existsSync(filePath)) return;
    try {
      const content = await readFile(filePath, "utf-8");
      const fileLines = content.split("\n").filter(Boolean).slice(-lines);
      for (const line of fileLines) {
        const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/);
        const levelMatch = line.match(/\b(INFO|WARN|WARNING|ERROR|DEBUG|FATAL)\b/i);
        logLines.push({
          timestamp: tsMatch?.[1],
          level: levelMatch?.[1]?.toUpperCase(),
          message: line,
          source: src,
        });
      }
    } catch {}
  }
  if (source === "ollama" || source === "all") {
    try {
      const { stdout } = await execAsync(`journalctl -u ollama --no-pager -n ${lines} 2>/dev/null || true`, { timeout: 5000 });
      if (stdout.trim()) {
        stdout.split("\n").filter(Boolean).forEach((line) => {
          logLines.push({ message: line, source: "ollama" });
        });
      } else {
        for (const p of ollamaLogPaths) await readLogFile(p, "ollama");
      }
    } catch {
      for (const p of ollamaLogPaths) await readLogFile(p, "ollama");
    }
  }
  if (source === "webui" || source === "all") {
    for (const p of webuiLogPaths) await readLogFile(p, "webui");
  }
  if (logLines.length === 0) {
    logLines.push({ message: "No log files found. On Windows, Ollama logs are at %USERPROFILE%/AppData/Local/Ollama/logs/server.log", source: "system", level: "INFO" });
    logLines.push({ message: "Open WebUI logs depend on how it was started — check your launch terminal or task manager", source: "system", level: "INFO" });
  }
  const finalLines = logLines.slice(-lines);
  return res.json({ lines: finalLines, source, truncated: finalLines.length >= lines });
});

router.get("/system/process/status", async (_req, res) => {
  const integration = readSystemIntegrationStatus();
  return res.json({
    integration: integration || {
      state: "inactive",
      message: "System tray integration is not currently reporting status.",
    },
  });
});

router.post("/system/process/kill-switch", async (_req, res) => {
  try {
    const result = await invokeSystemKillSwitch();
    return res.json(result);
  } catch (err: any) {
    return res.json({ success: false, message: err.message });
  }
});

router.get("/system/cleanup/scan", async (_req, res) => {
  const artifacts: any[] = [];
  let staleWrappers = 0;
  let obsoleteScripts = 0;
  const staleScripts = [
    { file: "AI-On.cmd", desc: "Old AI stack on script", type: "old-cmd", risk: "safe" },
    { file: "AI-Off.cmd", desc: "Old AI stack off script", type: "old-cmd", risk: "safe" },
    { file: "AI-Toggle.cmd", desc: "Old toggle script", type: "old-cmd", risk: "safe" },
    { file: "Toggle-LocalAI-Stack.cmd", desc: "Stale toggle wrapper", type: "stale-wrapper", risk: "safe" },
    { file: "Open-WebUI.cmd", desc: "Stale WebUI opener", type: "stale-wrapper", risk: "safe" },
    { file: "Manage-AI.ps1", desc: "Old AI management script", type: "old-ps1", risk: "moderate" },
    { file: "Manage-LocalAI-Stack.ps1", desc: "Old stack management script", type: "old-ps1", risk: "moderate" },
    { file: "LocalAI-Update-Manager-v2.ps1", desc: "Old update manager", type: "old-ps1", risk: "moderate" },
    { file: "FIXLOG-v4.1.txt", desc: "Old fix log", type: "stale-reference", risk: "safe" },
    { file: "FIXLOG-v4.3.txt", desc: "Old fix log", type: "stale-reference", risk: "safe" },
    { file: "FIXLOG-v4.4.txt", desc: "Old fix log", type: "stale-reference", risk: "safe" },
    { file: "RUTHLESS-AUDIT-v4.txt", desc: "Old audit doc", type: "stale-reference", risk: "safe" },
  ];
  for (const f of staleScripts) {
    const filePath = path.join(TOOLS_DIR, f.file);
    if (existsSync(filePath)) {
      if (f.type === "stale-wrapper") staleWrappers++;
      if (f.type.startsWith("old-")) obsoleteScripts++;
      const s = await stat(filePath).catch(() => null);
      artifacts.push({ id: filePath, path: filePath, type: f.type, description: f.desc, risk: f.risk, selected: f.risk === "safe", sizeBytes: s?.size || 0 });
    }
  }
  const chatHistoryDir = path.join(TOOLS_DIR, "chat-history");
  if (existsSync(chatHistoryDir)) {
    try {
      const { readdir } = await import("fs/promises");
      const files = await readdir(chatHistoryDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const fp = path.join(chatHistoryDir, file);
        const s = await stat(fp).catch(() => null);
        if (!s) continue;
        const ageDays = (Date.now() - s.mtimeMs) / 86400000;
        if (ageDays > 30) {
          artifacts.push({ id: fp, path: fp, type: "stale-reference", description: `Old chat session (${Math.floor(ageDays)}d old): ${file}`, risk: "safe", selected: true, sizeBytes: s.size });
        }
      }
    } catch {}
  }
  const studiosDir = path.join(HOME, "LocalAI-Studios");
  if (existsSync(studiosDir)) {
    try {
      const { readdir } = await import("fs/promises");
      const studios = await readdir(studiosDir, { withFileTypes: true });
      for (const entry of studios) {
        if (!entry.isDirectory()) continue;
        const studioPath = path.join(studiosDir, entry.name);
        const hasGit = existsSync(path.join(studioPath, ".git"));
        const s = await stat(studioPath).catch(() => null);
        if (!s) continue;
        const ageDays = (Date.now() - s.mtimeMs) / 86400000;
        if (!hasGit && ageDays > 7) {
          const size = await getDirSize(studioPath);
          artifacts.push({ id: studioPath, path: studioPath, type: "stale-reference", description: `Scaffolded studio with no git (${Math.floor(ageDays)}d untouched): ${entry.name}`, risk: "moderate", selected: false, sizeBytes: size });
        }
      }
    } catch {}
  }
  const tempFiles = ["localai-start-api.ps1", "localai-start-ui.ps1"];
  for (const tf of tempFiles) {
    const fp = path.join(os.tmpdir(), tf);
    if (existsSync(fp)) {
      const s = await stat(fp).catch(() => null);
      artifacts.push({ id: fp, path: fp, type: "stale-reference", description: `Temp launcher script: ${tf}`, risk: "safe", selected: true, sizeBytes: s?.size || 0 });
    }
  }
  const distDir = path.resolve(fileURLToPath(import.meta.url), "..", "..", "dist");
  if (existsSync(distDir)) {
    try {
      const { readdir } = await import("fs/promises");
      const distFiles = await readdir(distDir);
      const oldWorkers = distFiles.filter((f) => f.startsWith("pino-worker") && f.endsWith(".mjs"));
      if (oldWorkers.length > 2) {
        for (const w of oldWorkers.slice(2)) {
          const fp = path.join(distDir, w);
          const s = await stat(fp).catch(() => null);
          artifacts.push({ id: fp, path: fp, type: "stale-reference", description: `Old pino worker (superseded by latest build): ${w}`, risk: "safe", selected: true, sizeBytes: s?.size || 0 });
        }
      }
    } catch {}
  }
  const bytes = artifacts.reduce((sum, a) => sum + (a.sizeBytes || 0), 0);
  const safeCount = artifacts.filter((a) => a.risk === "safe").length;
  return res.json({ artifacts, totalFound: artifacts.length, staleWrappers, obsoleteScripts, safeCount, spaceSavable: formatBytes(bytes), spaceSavableBytes: bytes });
});

router.post("/system/cleanup/execute", async (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const artifactIds: string[] = Array.isArray(body.artifactIds) ? body.artifactIds : [];
  const removedPaths: string[] = [];
  const skipped: any[] = [];
  const scheduledForReboot: string[] = [];
  for (const candidate of artifactIds) {
    const normalized = path.normalize(candidate);
    if (!normalized.startsWith(TOOLS_DIR)) {
      skipped.push({ path: candidate, reason: "Outside managed tools directory" });
      continue;
    }
    if (!existsSync(normalized)) {
      skipped.push({ path: candidate, reason: "Already missing" });
      continue;
    }
    try {
      const cleanup = await robustCleanup(normalized);
      if (cleanup.success && cleanup.removed) {
        removedPaths.push(normalized);
      } else if (cleanup.success && cleanup.scheduledForReboot) {
        scheduledForReboot.push(normalized);
      } else {
        skipped.push({ path: candidate, reason: cleanup.message });
      }
    } catch (err: any) {
      skipped.push({ path: candidate, reason: err.message });
    }
  }
  const status = skipped.length > 0 ? "warning" : "success";
  await appendActivity("cleanup", status, `Cleanup completed: ${removedPaths.length} removed, ${scheduledForReboot.length} scheduled, ${skipped.length} skipped`);
  return res.json({
    success: skipped.length === 0,
    message: `Cleanup done: ${removedPaths.length} removed, ${scheduledForReboot.length} scheduled for reboot, ${skipped.length} skipped`,
    removedPaths,
    scheduledForReboot,
    skipped,
  });
});

router.get("/system/setup/inspect", async (_req, res) => {
  const managedApps = [
    { id: "pwsh", name: "PowerShell 7", category: "Shell", cmd: "pwsh --version" },
    { id: "wt", name: "Windows Terminal", category: "Shell", cmd: "wt --version" },
    { id: "git", name: "Git", category: "Dev", cmd: "git --version" },
    { id: "gh", name: "GitHub CLI", category: "Dev", cmd: "gh --version" },
    { id: "python", name: "Python 3.12", category: "Dev", cmd: "python --version" },
    { id: "node", name: "Node.js LTS", category: "Dev", cmd: "node --version" },
    { id: "dotnet", name: ".NET 9 SDK", category: "Dev", cmd: "dotnet --version" },
    { id: "cargo", name: "Rust / Cargo", category: "Dev", cmd: "cargo --version" },
    { id: "code", name: "VS Code", category: "Dev", cmd: "code --version" },
    { id: "ollama", name: "Ollama", category: "AI", cmd: "ollama --version" },
    { id: "aider", name: "Aider", category: "AI", cmd: "aider --version" },
    { id: "litellm", name: "LiteLLM", category: "AI", cmd: "python -m litellm --version" },
    { id: "nvitop", name: "nvitop", category: "AI", cmd: "nvitop --version" },
    { id: "rg", name: "ripgrep", category: "Tools", cmd: "rg --version" },
    { id: "fd", name: "fd", category: "Tools", cmd: "fd --version" },
    { id: "jq", name: "jq", category: "Tools", cmd: "jq --version" },
    { id: "cmake", name: "CMake", category: "Tools", cmd: "cmake --version" },
    { id: "cloudflared", name: "cloudflared", category: "Tunnel", cmd: "cloudflared --version" },
  ];
  const items: any[] = [];
  let missingCount = 0;
  let okCount = 0;
  for (const app of managedApps) {
    const version = await tryVersion(app.cmd);
    const installed = !!version;
    if (installed) okCount++;
    else missingCount++;
    items.push({ id: app.id, name: app.name, category: app.category, installed, version, status: installed ? "ok" : "missing", canRepair: !installed, repairAction: installed ? undefined : `winget install ${app.name}` });
  }
  const recommendations: string[] = [];
  if (missingCount > managedApps.length / 2) recommendations.push("Fresh PC detected — run full bootstrap to install everything");
  if (missingCount > 0) recommendations.push(`${missingCount} components missing — use Repair to install`);
  if (okCount === managedApps.length) recommendations.push("All managed components are installed");
  return res.json({ items, isFreshPC: missingCount > managedApps.length / 2, missingCount, brokenCount: 0, okCount, recommendations });
});

router.post("/system/setup/repair", async (req, res) => {
  const { itemIds, mode } = req.body;
  const wingetMap: Record<string, string> = {
    pwsh: "Microsoft.PowerShell",
    wt: "Microsoft.WindowsTerminal",
    git: "Git.Git",
    gh: "GitHub.cli",
    python: "Python.Python.3.12",
    node: "OpenJS.NodeJS.LTS",
    dotnet: "Microsoft.DotNet.SDK.9",
    cargo: "Rustlang.Rustup",
    code: "Microsoft.VisualStudioCode",
    ollama: "Ollama.Ollama",
    rg: "BurntSushi.ripgrep.MSVC",
    fd: "sharkdp.fd",
    jq: "jqlang.jq",
    cmake: "Kitware.CMake",
    cloudflared: "Cloudflare.cloudflared",
  };
  const pipMap: Record<string, string> = { nvitop: "nvitop", aider: "aider-chat", litellm: "litellm[all]" };
  const versionCmdMap: Record<string, string> = {
    pwsh: "pwsh --version",
    wt: "wt --version",
    git: "git --version",
    gh: "gh --version",
    python: "python --version",
    node: "node --version",
    dotnet: "dotnet --version",
    cargo: "cargo --version",
    code: "code --version",
    ollama: "ollama --version",
    rg: "rg --version",
    fd: "fd --version",
    jq: "jq --version",
    cmake: "cmake --version",
    cloudflared: "cloudflared --version",
    nvitop: "nvitop --version",
    aider: "aider --version",
    litellm: "python -m litellm --version",
  };
  let repairIds: string[] = itemIds || [];
  if (mode === "all-missing") {
    repairIds = [];
    for (const id of [...Object.keys(wingetMap), ...Object.keys(pipMap)]) {
      const version = await tryVersion(versionCmdMap[id] || "");
      if (!version) repairIds.push(id);
    }
  }
  const cmds: string[] = [];
  for (const id of repairIds) {
    if (wingetMap[id]) cmds.push(`winget install --id ${wingetMap[id]} -e --silent`);
    else if (pipMap[id]) cmds.push(`python -m pip install ${pipMap[id]}`);
  }
  if (cmds.length > 0) {
    const queuedJob = taskQueue.enqueue(
      "System Repair",
      "system-repair",
      async ({ updateProgress, publishThought }: any) => {
        publishThought("Repair Started", "Repair commands entered the async queue", { commandCount: cmds.length });
        updateProgress(10, "Launching repair commands", { cmds });
        await new Promise<void>((resolve, reject) => {
          exec(cmds.join(" && "), { timeout: 300000 }, (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        updateProgress(100, "Repair commands completed", { cmds });
        return { commands: cmds };
      },
      { capability: "sysadmin", metadata: { cmds } }
    );
    thoughtLog.publish({
      category: "system",
      title: "Repair Queued",
      message: `Queued ${cmds.length} repair command(s)`,
      metadata: { jobId: queuedJob.id, cmds },
    });
    const message = `Repair queued for ${cmds.length} component(s). Job ${queuedJob.id} is now running asynchronously.`;
    await appendActivity("repair", "success", message);
    return res.json({ success: true, message, jobId: queuedJob.id });
  }
  const message = cmds.length > 0 ? `Repair started for ${cmds.length} component(s). This may take several minutes.` : `No auto-repair available for selected items.`;
  await appendActivity("repair", "success", message);
  return res.json({ success: true, message });
});

router.get("/system/activity", async (_req, res) => {
  try {
    if (existsSync(ACTIVITY_FILE)) {
      const content = await readFile(ACTIVITY_FILE, "utf-8");
      const entries = JSON.parse(content);
      return res.json({ entries, total: entries.length });
    }
  } catch {}
  return res.json({ entries: [], total: 0 });
});

router.get("/system/storage", async (_req, res) => {
  const dirs = [
    { label: "LocalAI-Tools", path: TOOLS_DIR, category: "config" },
    { label: "LocalAI-OpenWebUI", path: path.join(HOME, "LocalAI-OpenWebUI"), category: "app" },
    { label: "LocalAI-Setup", path: path.join(HOME, "LocalAI-Setup"), category: "config" },
    { label: "LocalAI-Backups", path: path.join(HOME, "LocalAI-Backups"), category: "backup" },
    { label: "Ollama Models (~/.ollama)", path: path.join(HOME, ".ollama", "models"), category: "models" },
    { label: "Continue Config (~/.continue)", path: path.join(HOME, ".continue"), category: "config" },
  ];
  const items: any[] = [];
  let totalBytes = 0;
  let modelsBytes = 0;
  for (const d of dirs) {
    const size = await getDirSize(d.path);
    totalBytes += size;
    if (d.category === "models") modelsBytes += size;
    items.push({ label: d.label, path: d.path, sizeBytes: size, sizeFormatted: formatBytes(size), category: d.category });
  }
  return res.json({ items, totalBytes, totalFormatted: formatBytes(totalBytes), modelsBytes, modelsFormatted: formatBytes(modelsBytes) });
});

// ── Sovereign self-edit endpoints ─────────────────────────────────────────────

// POST /system/sovereign/preview — diff preview without writing
router.post("/system/sovereign/preview", async (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const filePath   = typeof body.filePath   === "string" ? body.filePath   : "";
  const newContent = typeof body.newContent === "string" ? body.newContent : "";
  if (!filePath || !newContent) {
    return res.status(400).json({ success: false, message: "filePath and newContent are required" });
  }
  try {
    const proposal = await proposeSelfEdit(filePath, newContent);
    return res.json({ success: true, proposal: { filePath: proposal.filePath, diff: proposal.diff, lineCount: proposal.lineCount } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error instanceof Error ? error.message : String(error) });
  }
});

// POST /system/sovereign/edit — apply a self-edit (backs up original)
router.post("/system/sovereign/edit", async (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const filePath   = typeof body.filePath   === "string" ? body.filePath   : "";
  const newContent = typeof body.newContent === "string" ? body.newContent : "";
  if (!filePath || !newContent) {
    return res.status(400).json({ success: false, message: "filePath and newContent are required" });
  }
  try {
    const result = await sovereignEdit(filePath, newContent);
    return res.json(result);
  } catch (error) {
    return res.status(400).json({ success: false, message: error instanceof Error ? error.message : String(error) });
  }
});

// POST /system/sovereign/restart — graceful process restart
router.post("/system/sovereign/restart", (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const reason = typeof body.reason === "string" ? body.reason.trim() : "API-triggered restart";
  res.json({ success: true, message: `Server will restart in ~500 ms — ${reason}` });
  triggerServerRestart(reason, 500);
});

// ── PC interop / macro endpoints ──────────────────────────────────────────────

// GET /system/windows — list open windows matching an optional title pattern
router.get("/system/windows", async (req, res) => {
  const pattern = typeof req.query["pattern"] === "string" ? req.query["pattern"] : "";
  const windows = await findWindows(pattern || "");
  return res.json({ windows });
});

// POST /system/windows/focus — bring a window to the foreground
router.post("/system/windows/focus", async (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const pattern = typeof body.pattern === "string" ? body.pattern.trim() : "";
  if (!pattern) return res.status(400).json({ success: false, message: "pattern required" });
  const focused = await focusWindow(pattern);
  return res.json({ success: focused, message: focused ? `Focused window matching "${pattern}"` : `No window found matching "${pattern}"` });
});

// GET /system/macros — list available macros
router.get("/system/macros", (_req, res) => {
  return res.json({ macros: listMacros() });
});

// POST /system/macros — register a new user macro
router.post("/system/macros", (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const macro = body as unknown as Macro;
  if (!macro.name || !Array.isArray(macro.steps)) {
    return res.status(400).json({ success: false, message: "macro name and steps are required" });
  }
  registerMacro(macro);
  return res.json({ success: true, message: `Macro "${macro.name}" registered` });
});

// POST /system/macros/:name/run — execute a named macro
router.post("/system/macros/:name/run", async (req, res) => {
  const { name } = req.params;
  const result = await runMacro(name);
  return res.json(result);
});

export default router;
