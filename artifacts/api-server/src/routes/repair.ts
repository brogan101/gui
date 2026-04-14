import { Router } from "express";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { readdir } from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import {
  commandExists,
  maybeVersion,
  ollamaReachable,
  fetchText,
  isWindows,
  toolsRoot,
  ensureDir,
  execCommand,
} from "../lib/runtime.js";
import { writeManagedJson, writeManagedFile } from "../lib/snapshot-manager.js";

const router = Router();
const HOME = os.homedir();
const TOOLS_DIR = toolsRoot();
const REPAIR_LOG_FILE = path.join(TOOLS_DIR, "repair-log.json");

interface ComponentDef {
  id: string;
  name: string;
  category: string;
  detect: () => Promise<{ installed: boolean; version?: string | null; running?: boolean; path?: string }>;
  healthCheck: (installed: boolean, extra?: any) => Promise<{ status: string; details?: string }>;
  repairAction: string;
  repairCmd: string;
  repairDescription: string;
}

const COMPONENTS: ComponentDef[] = [
  // ── AI Stack ────────────────────────────────────────────────────────────
  {
    id: "ollama",
    name: "Ollama",
    category: "AI Stack",
    detect: async () => ({ installed: await commandExists("ollama"), version: await maybeVersion("ollama --version") }),
    healthCheck: async (v) => {
      const running = await ollamaReachable();
      if (!v) return { status: "error", details: "Ollama not installed" };
      if (!running) return { status: "warning", details: "Installed but not running — start from Stack page" };
      return { status: "ok", details: "Running on port 11434" };
    },
    repairAction: "winget",
    repairCmd: isWindows
      ? "winget install Ollama.Ollama --silent --accept-package-agreements"
      : "curl -fsSL https://ollama.ai/install.sh | sh",
    repairDescription: "Install Ollama via winget",
  },
  {
    id: "python",
    name: "Python 3.x",
    category: "Runtime",
    detect: async () => ({
      installed: (await commandExists("python")) || (await commandExists("python3")),
      version: (await maybeVersion("python --version")) || (await maybeVersion("python3 --version")),
    }),
    healthCheck: async (v) => (v ? { status: "ok", details: "Python available" } : { status: "error", details: "Python not found" }),
    repairAction: "winget",
    repairCmd: "winget install Python.Python.3.12 --silent --accept-package-agreements",
    repairDescription: "Install Python 3.12 via winget",
  },
  {
    id: "node",
    name: "Node.js LTS",
    category: "Runtime",
    detect: async () => ({ installed: await commandExists("node"), version: await maybeVersion("node --version") }),
    healthCheck: async (v) => (v ? { status: "ok" } : { status: "error", details: "Node.js not found" }),
    repairAction: "winget",
    repairCmd: "winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements",
    repairDescription: "Install Node.js LTS via winget",
  },
  {
    id: "git",
    name: "Git",
    category: "Dev Tools",
    detect: async () => ({ installed: await commandExists("git"), version: await maybeVersion("git --version") }),
    healthCheck: async (v) => (v ? { status: "ok" } : { status: "warning", details: "Git not found — workspace features limited" }),
    repairAction: "winget",
    repairCmd: "winget install Git.Git --silent --accept-package-agreements",
    repairDescription: "Install Git via winget",
  },
  {
    id: "code",
    name: "VS Code",
    category: "Dev Tools",
    detect: async () => ({ installed: await commandExists("code"), version: await maybeVersion("code --version") }),
    healthCheck: async (v) =>
      v ? { status: "ok" } : { status: "warning", details: "VS Code CLI not found — install VS Code and add to PATH" },
    repairAction: "winget",
    repairCmd: "winget install Microsoft.VisualStudioCode --silent --accept-package-agreements",
    repairDescription: "Install VS Code via winget",
  },
  {
    id: "continue",
    name: "Continue VS Code Extension",
    category: "AI Coding",
    detect: async () => {
      const configExists = existsSync(path.join(HOME, ".continue"));
      return { installed: configExists, version: configExists ? "config found" : null };
    },
    healthCheck: async (v) =>
      v
        ? { status: "ok", details: "~/.continue config directory found" }
        : { status: "warning", details: "Not configured — install Continue extension in VS Code" },
    repairAction: "vscode-ext",
    repairCmd: "code --install-extension Continue.continue",
    repairDescription: "Install Continue extension in VS Code",
  },
  {
    id: "aider",
    name: "Aider",
    category: "AI Coding",
    detect: async () => ({ installed: await commandExists("aider"), version: await maybeVersion("aider --version") }),
    healthCheck: async (v) => (v ? { status: "ok" } : { status: "warning", details: "Not installed — pip install aider-chat" }),
    repairAction: "pip",
    repairCmd: "pip install aider-chat",
    repairDescription: "Install Aider via pip",
  },
  {
    id: "litellm",
    name: "LiteLLM Gateway",
    category: "AI Routing",
    detect: async () => {
      const cmd = await commandExists("litellm");
      const running = await fetchText("http://localhost:4000/health", undefined, 2000)
        .then(() => true)
        .catch(() => false);
      return { installed: cmd, version: await maybeVersion("litellm --version"), running };
    },
    healthCheck: async (v) =>
      v
        ? { status: "ok" }
        : { status: "warning", details: "Not installed — needed to fix Aider model routing errors" },
    repairAction: "pip",
    repairCmd: 'pip install "litellm[proxy]"',
    repairDescription: "Install LiteLLM[proxy] via pip",
  },
  {
    id: "open-webui",
    name: "Open WebUI",
    category: "Chat UI",
    detect: async () => {
      const cmd = await commandExists("open-webui");
      const running = await fetchText("http://localhost:8080", undefined, 2000)
        .then(() => true)
        .catch(() => false);
      return { installed: cmd || running, version: await maybeVersion("open-webui --version"), running };
    },
    healthCheck: async (v, extra) => {
      if (!v) return { status: "unknown", details: "Not installed (optional)" };
      if (extra?.running) return { status: "ok", details: "Running on port 8080" };
      return { status: "warning", details: "Installed but not running" };
    },
    repairAction: "pip",
    repairCmd: "pip install open-webui",
    repairDescription: "Install Open WebUI via pip",
  },
  {
    id: "pnpm",
    name: "pnpm",
    category: "Runtime",
    detect: async () => {
      const pnpmPath = path.join(process.env.LOCALAPPDATA || HOME, "npm-global", "pnpm.cmd");
      const installed = existsSync(pnpmPath) || (await commandExists("pnpm"));
      return { installed, version: await maybeVersion("pnpm --version") };
    },
    healthCheck: async (v) =>
      v ? { status: "ok" } : { status: "error", details: "pnpm not found — LocalAI app will not start" },
    repairAction: "npm",
    repairCmd: "npm install -g pnpm",
    repairDescription: "Install pnpm globally via npm",
  },
  {
    id: "tools-dir",
    name: "LocalAI-Tools Directory",
    category: "Config",
    detect: async () => ({ installed: existsSync(TOOLS_DIR), version: existsSync(TOOLS_DIR) ? "exists" : null }),
    healthCheck: async (v) => (v ? { status: "ok", details: TOOLS_DIR } : { status: "warning", details: "Will be created on first run" }),
    repairAction: "mkdir",
    repairCmd: `mkdir -p "${TOOLS_DIR}"`,
    repairDescription: "Create LocalAI-Tools directory",
  },
  {
    id: "model-roles",
    name: "Model Role Assignments",
    category: "Config",
    detect: async () => {
      const rolesFile = path.join(TOOLS_DIR, "model-roles.json");
      const exists = existsSync(rolesFile);
      if (!exists) return { installed: false, version: null };
      const roles = JSON.parse(await readFile(rolesFile, "utf-8"));
      const assigned = Object.values(roles).filter(Boolean).length;
      return { installed: true, version: `${assigned} roles assigned` };
    },
    healthCheck: async (v) =>
      v ? { status: "ok" } : { status: "warning", details: "No model roles set — assign from Models page" },
    repairAction: "config-write",
    repairCmd: "",
    repairDescription: "Create default model-roles.json (empty assignments)",
  },
];

async function runComponentCheck(comp: ComponentDef): Promise<any> {
  const start = Date.now();
  try {
    const detected = await comp.detect();
    const health = await comp.healthCheck(detected.installed, detected);
    return {
      id: comp.id,
      name: comp.name,
      category: comp.category,
      status: health.status,
      value: detected.version || (detected.installed ? "installed" : "not found"),
      details: health.details,
      canRepair: health.status !== "ok" && !!comp.repairCmd,
      repairAction: comp.repairAction,
      repairCmd: comp.repairCmd,
      repairDescription: comp.repairDescription,
    };
  } catch (err: any) {
    return {
      id: comp.id,
      name: comp.name,
      category: comp.category,
      status: "error",
      value: "check failed",
      details: err.message,
      canRepair: !!comp.repairCmd,
      repairAction: comp.repairAction,
      repairCmd: comp.repairCmd,
      repairDescription: comp.repairDescription,
    };
  }
}

router.get("/repair/health", async (_req, res) => {
  const items = await Promise.all(COMPONENTS.map(runComponentCheck));
  const portChecks = [
    { port: 11434, name: "Ollama", id: "ollama" },
    { port: 8080, name: "Open WebUI", id: "open-webui" },
    { port: 4000, name: "LiteLLM", id: "litellm" },
    { port: 5173, name: "LocalAI UI", id: "localai-ui" },
    { port: 3001, name: "LocalAI API", id: "localai-api" },
  ];
  const portStatus = await Promise.all(
    portChecks.map(async (p) => ({
      ...p,
      reachable: await fetchText(`http://localhost:${p.port}`, undefined, 1500)
        .then(() => true)
        .catch(() => false),
    }))
  );
  const errors = items.filter((i) => i.status === "error").length;
  const warnings = items.filter((i) => i.status === "warning").length;
  const ok = items.filter((i) => i.status === "ok").length;
  const healthScore = Math.round((ok / items.length) * 100);
  const recommendations: string[] = [];
  const criticals = items.filter((i) => i.status === "error");
  if (criticals.length)
    recommendations.push(`${criticals.length} critical issue(s) found: ${criticals.map((i) => i.name).join(", ")}`);
  const warns = items.filter((i) => i.status === "warning");
  if (warns.length) recommendations.push(`${warns.length} warning(s): ${warns.map((i) => i.name).join(", ")}`);
  if (!criticals.length && !warns.length) recommendations.push("All components healthy");
  const ollamaItem = items.find((i) => i.id === "ollama");
  if (ollamaItem?.status === "ok") {
    const ollamaRunning = await ollamaReachable();
    if (ollamaRunning) {
      try {
        const { fetchJson } = await import("../lib/runtime.js");
        const models = await fetchJson<{ models?: unknown[] }>("http://127.0.0.1:11434/api/tags", undefined, 3000);
        if (!models.models?.length) recommendations.push("No models installed — pull at least one from the Models page");
      } catch {}
    }
  }
  return res.json({
    items,
    portStatus,
    healthScore,
    errors,
    warnings,
    ok,
    recommendations,
    checkedAt: new Date().toISOString(),
    isFreshPC: ok < items.length / 2,
  });
});

router.post("/repair/run", async (req, res) => {
  const { ids, mode = "selective" } = req.body;
  let targetIds: string[] = ids || [];
  if (mode === "all-broken" || mode === "all") {
    const items = await Promise.all(COMPONENTS.map(runComponentCheck));
    targetIds = items.filter((i) => (mode === "all" || i.status !== "ok") && i.canRepair).map((i) => i.id);
  }
  const results: any[] = [];
  const log: any[] = [];
  for (const id of targetIds) {
    const comp = COMPONENTS.find((c) => c.id === id);
    if (!comp) continue;
    const start = Date.now();
    const current = await runComponentCheck(comp);
    if (current.status === "ok") {
      results.push({ id, name: comp.name, action: "skipped", success: true, message: "Already installed/healthy", durationMs: Date.now() - start });
      continue;
    }
    if (!comp.repairCmd) {
      results.push({ id, name: comp.name, action: "manual", success: false, message: comp.repairDescription || "Manual repair required", durationMs: Date.now() - start });
      continue;
    }
    if (comp.repairAction === "mkdir") {
      await ensureDir(TOOLS_DIR);
      results.push({ id, name: comp.name, action: "mkdir", success: true, message: `Created ${TOOLS_DIR}`, durationMs: Date.now() - start });
      continue;
    }
    if (comp.repairAction === "config-write" && id === "model-roles") {
      const rolesFile = path.join(TOOLS_DIR, "model-roles.json");
      if (!existsSync(rolesFile)) {
        await ensureDir(TOOLS_DIR);
        await writeManagedJson(rolesFile, {
          "primary-coding": "",
          "fast-coding": "",
          autocomplete: "",
          reasoning: "",
          embeddings: "",
          chat: "",
        });
      }
      results.push({ id, name: comp.name, action: "config-write", success: true, message: "Created default model-roles.json", durationMs: Date.now() - start });
      continue;
    }
    try {
      const cmd = isWindows
        ? `start "Repairing ${comp.name}" cmd /k "${comp.repairCmd} && echo [DONE] ${comp.name} installed successfully && timeout /t 5"`
        : `${comp.repairCmd}`;
      exec(cmd);
      results.push({ id, name: comp.name, action: comp.repairAction, success: true, message: `Repair launched for ${comp.name}. Check the terminal window for progress.`, durationMs: Date.now() - start });
    } catch (err: any) {
      results.push({ id, name: comp.name, action: comp.repairAction, success: false, message: err.message, durationMs: Date.now() - start });
    }
    log.push({
      timestamp: new Date().toISOString(),
      id,
      action: comp.repairAction,
      success: results[results.length - 1].success,
      message: results[results.length - 1].message,
    });
  }
  let existing: any[] = [];
  if (existsSync(REPAIR_LOG_FILE)) {
    try {
      existing = JSON.parse(await readFile(REPAIR_LOG_FILE, "utf-8"));
    } catch {}
  }
  await ensureDir(TOOLS_DIR);
  await writeManagedJson(REPAIR_LOG_FILE, [...log, ...existing].slice(0, 200));
  const launched = results.filter((r) => r.success && r.action !== "skipped").length;
  const skipped = results.filter((r) => r.action === "skipped").length;
  return res.json({ success: true, results, launched, skipped, message: `${launched} repair(s) launched, ${skipped} already healthy` });
});

router.get("/repair/log", async (_req, res) => {
  if (!existsSync(REPAIR_LOG_FILE)) return res.json({ log: [] });
  try {
    const log = JSON.parse(await readFile(REPAIR_LOG_FILE, "utf-8"));
    return res.json({ log });
  } catch {
    return res.json({ log: [] });
  }
});

router.post("/repair/diagnose-integration/:id", async (req, res) => {
  const { id } = req.params;
  type IntegrationChecker = () => Promise<{ status: string; issues: string[]; fixes: string[] }>;
  const integrationChecks: Record<string, IntegrationChecker> = {
    ollama: async () => {
      const issues: string[] = [];
      const fixes: string[] = [];
      const installed = await commandExists("ollama");
      if (!installed) {
        issues.push("Ollama binary not found");
        fixes.push("winget install Ollama.Ollama");
        return { status: "error", issues, fixes };
      }
      const running = await ollamaReachable();
      if (!running) {
        issues.push("Ollama not responding on port 11434");
        fixes.push("Start Ollama from Stack page or run: ollama serve");
      }
      return { status: issues.length ? "warning" : "ok", issues, fixes };
    },
    litellm: async () => {
      const issues: string[] = [];
      const fixes: string[] = [];
      const installed = await commandExists("litellm");
      if (!installed) {
        issues.push("LiteLLM not installed");
        fixes.push('pip install "litellm[proxy]"');
        return { status: "error", issues, fixes };
      }
      const running = await fetchText("http://localhost:4000/health", undefined, 2000)
        .then(() => true)
        .catch(() => false);
      if (!running) {
        issues.push("LiteLLM not running on port 4000");
        fixes.push("Start from Stack > Components page");
      }
      if (running) {
        const ollamaOk = await ollamaReachable();
        if (!ollamaOk) {
          issues.push("Ollama is not reachable — LiteLLM cannot proxy to it");
          fixes.push("Start Ollama first");
        }
      }
      return { status: issues.length ? "warning" : "ok", issues, fixes };
    },
    aider: async () => {
      const issues: string[] = [];
      const fixes: string[] = [];
      const installed = await commandExists("aider");
      if (!installed) {
        issues.push("Aider not installed");
        fixes.push("pip install aider-chat");
        return { status: "error", issues, fixes };
      }
      const litellmRunning = await fetchText("http://localhost:4000/health", undefined, 1500)
        .then(() => true)
        .catch(() => false);
      if (!litellmRunning) {
        issues.push('LiteLLM not running — Aider will get "LLM Provider NOT provided" error');
        fixes.push("Start LiteLLM from Stack page, then use: aider --model openai/<model> --openai-api-base http://localhost:4000");
      }
      const ollamaOk = await ollamaReachable();
      if (!ollamaOk) {
        issues.push("Ollama not running — no local models available for Aider");
        fixes.push("Start Ollama from Stack page");
      }
      return { status: issues.length ? "warning" : "ok", issues, fixes };
    },
    continue: async () => {
      const issues: string[] = [];
      const fixes: string[] = [];
      const configDir = path.join(HOME, ".continue");
      if (!existsSync(configDir)) {
        issues.push("~/.continue directory missing — Continue extension not initialized");
        fixes.push("Install Continue in VS Code, open it once to generate config");
      }
      const configFile = path.join(configDir, "config.json");
      if (existsSync(configDir) && !existsSync(configFile)) {
        issues.push("config.json missing inside ~/.continue");
        fixes.push("Open VS Code with Continue extension and configure it once");
      }
      const vsCodeOk = await commandExists("code");
      if (!vsCodeOk) {
        issues.push("VS Code CLI not found on PATH");
        fixes.push("Install VS Code and add to PATH");
      }
      return { status: issues.length ? "warning" : "ok", issues, fixes };
    },
  };
  const checker = integrationChecks[id];
  if (!checker) return res.json({ status: "unknown", issues: [`No diagnosis available for: ${id}`], fixes: [] });
  const result = await checker();
  return res.json({ id, ...result, diagnosedAt: new Date().toISOString() });
});

router.post("/repair/detect-project-context", async (req, res) => {
  const { projectPath } = typeof req.body === "object" && req.body !== null ? req.body : {};
  if (!projectPath || !existsSync(projectPath)) {
    return res.status(400).json({ success: false, message: "Invalid project path" });
  }
  const checks: Record<string, boolean> = {};
  const files = await readdir(projectPath).catch(() => [] as string[]);
  const fileSet = new Set(files);
  checks.hasGit = fileSet.has(".git") || existsSync(path.join(projectPath, ".git"));
  checks.hasPackageJson = fileSet.has("package.json");
  checks.hasPyproject = fileSet.has("pyproject.toml");
  checks.hasRequirements = fileSet.has("requirements.txt");
  checks.hasCsproj = files.some((f) => f.endsWith(".csproj"));
  checks.hasCargoToml = fileSet.has("Cargo.toml");
  checks.hasContinueConfig = existsSync(path.join(projectPath, ".continue"));
  checks.hasAiRules = fileSet.has(".ai-rules.md");
  checks.hasTaskfile = fileSet.has("Taskfile.yml") || fileSet.has("Taskfile.yaml");
  checks.hasDockerfile = fileSet.has("Dockerfile") || fileSet.has("docker-compose.yml");
  const type = checks.hasCsproj
    ? "dotnet"
    : checks.hasCargoToml
    ? "rust"
    : checks.hasPackageJson
    ? "node"
    : checks.hasPyproject || checks.hasRequirements
    ? "python"
    : "unknown";
  let dependencies: string[] = [];
  if (checks.hasPackageJson) {
    try {
      const pkg = JSON.parse(await readFile(path.join(projectPath, "package.json"), "utf-8"));
      dependencies = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})];
    } catch {}
  }
  const recommendations: string[] = [];
  const suggestedRoles: Record<string, string> = {};
  if (type === "python") {
    recommendations.push("For Python projects, qwen2.5-coder:7b or deepseek-coder-v2:16b are recommended");
    recommendations.push("Install ruff for linting: pip install ruff");
    suggestedRoles["primary-coding"] = "qwen2.5-coder:7b";
  } else if (type === "node") {
    recommendations.push("For Node.js projects, qwen2.5-coder:7b with TypeScript support is recommended");
    suggestedRoles["primary-coding"] = "qwen2.5-coder:7b";
    suggestedRoles["autocomplete"] = "codegemma:7b";
  } else if (type === "dotnet") {
    recommendations.push("For .NET, qwen3-coder:8b handles C# well");
    suggestedRoles["primary-coding"] = "qwen3-coder:8b";
  } else if (type === "rust") {
    recommendations.push("For Rust, qwen2.5-coder:14b or deepseek-coder-v2 are strong choices");
    suggestedRoles["primary-coding"] = "qwen2.5-coder:14b";
  }
  if (!checks.hasContinueConfig && !checks.hasAiRules) {
    recommendations.push("No AI rules file found — create .ai-rules.md to give the AI coding context about this project");
  }
  if (!checks.hasGit) {
    recommendations.push('No git repository — initialize with: git init && git add . && git commit -m "initial"');
  }
  const vsCodeWorkspacePath = path.join(projectPath, `${path.basename(projectPath)}.code-workspace`);
  const hasVsCodeWorkspace = existsSync(vsCodeWorkspacePath);
  return res.json({
    success: true,
    projectPath,
    projectType: type,
    checks,
    dependencies: dependencies.slice(0, 20),
    recommendations,
    suggestedRoles,
    aiReadiness: checks.hasContinueConfig && checks.hasGit ? "ready" : checks.hasGit ? "partial" : "not-ready",
    hasVsCodeWorkspace,
    vsCodeWorkspacePath: hasVsCodeWorkspace ? vsCodeWorkspacePath : null,
  });
});

router.post("/repair/setup-project-ai", async (req, res) => {
  const { projectPath, templateId, openVscode = true } =
    typeof req.body === "object" && req.body !== null ? req.body : {};
  if (!projectPath || !existsSync(projectPath)) return res.status(400).json({ success: false, message: "Invalid path" });
  const actions: string[] = [];
  const rulesFile = path.join(projectPath, ".ai-rules.md");
  if (!existsSync(rulesFile)) {
    const rules = `# AI Rules for ${path.basename(projectPath)}

## Non-negotiables
- No placeholder code or TODO stubs in delivered output
- Fail loudly on errors — no silent swallowing
- Strict typing throughout
- Lint must pass before marking done

## Context
- Template: ${templateId || "unknown"}
- Generated: ${new Date().toISOString()}
`;
    await writeManagedFile(rulesFile, rules);
    actions.push("Created .ai-rules.md");
  }
  if (!existsSync(path.join(projectPath, ".git"))) {
    try {
      await execCommand(`git init`, 15000, projectPath);
      await execCommand(`git add .`, 5000, projectPath);
      await execCommand(`git commit -m "Initial scaffold"`, 10000, projectPath);
      actions.push("Initialized git repository");
    } catch {
      actions.push("Git init skipped (git may not be installed)");
    }
  }
  if (openVscode && (await commandExists("code"))) {
    exec(isWindows ? `start "" code "${projectPath}"` : `code "${projectPath}"`);
    actions.push("Opened in VS Code");
  }
  return res.json({ success: true, actions, projectPath });
});

export default router;
