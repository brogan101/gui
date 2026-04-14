import { Router } from "express";
import { exec } from "child_process";
import { readFile, cp, rename } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import {
  execCommand,
  commandExists,
  ollamaReachable,
  isWindows,
  toolsRoot,
  shellQuote,
  ensureDir,
} from "../lib/runtime.js";
import { writeManagedJson, writeManagedFile } from "../lib/snapshot-manager.js";
import { thoughtLog } from "../lib/thought-log.js";
import { robustCleanup } from "../lib/windows-system.js";

const router = Router();
const TOOLS_DIR = toolsRoot();
const PROJECTS_FILE = path.join(TOOLS_DIR, "projects.json");
const PROJECT_PROFILES_FILE = path.join(TOOLS_DIR, "project-profiles.json");
const STUDIO_PRESETS_FILE = path.join(TOOLS_DIR, "studio-presets.json");
const WORKSPACE_SNAPSHOTS_DIR = path.join(TOOLS_DIR, "workspace-snapshots");
const WORKSPACE_ARCHIVES_DIR = path.join(TOOLS_DIR, "workspace-archives");
const SNAPSHOTS_FILE = path.join(TOOLS_DIR, "workspace-snapshots.json");

const TEMPLATE_DEFS = [
  { id: "python-app", type: "python", files: ["pyproject.toml", "src/main.py", "tests/test_smoke.py", ".gitignore", "README.md"] },
  { id: "fastapi", type: "python", files: ["pyproject.toml", "app/main.py", "tests/test_health.py", ".gitignore", "README.md"] },
  { id: "react-vite", type: "node", files: ["package.json", "index.html", "src/main.tsx", "src/App.tsx", "src/index.css", ".gitignore", "README.md"] },
  { id: "electron-tauri", type: "node", files: ["package.json", "src/main.tsx", "src/App.tsx", "README.md"] },
  { id: "dotnet-console", type: "dotnet", files: ["Program.cs", "README.md", ".gitignore"] },
  { id: "docs-spec", type: "docs", files: ["README.md", "docs/index.md", ".gitignore"] },
  { id: "ui-vibe-lab", type: "node", files: ["package.json", "src/main.tsx", "src/App.tsx", "src/screens/brief.md", "README.md"] },
];

async function loadProjects(): Promise<any[]> {
  try {
    if (existsSync(PROJECTS_FILE)) return JSON.parse(await readFile(PROJECTS_FILE, "utf-8"));
  } catch {}
  return [];
}

async function saveProjects(projects: any[]): Promise<void> {
  await ensureDir(TOOLS_DIR);
  await writeManagedJson(PROJECTS_FILE, projects);
}

async function loadProfiles(): Promise<Record<string, any>> {
  try {
    if (existsSync(PROJECT_PROFILES_FILE)) return JSON.parse(await readFile(PROJECT_PROFILES_FILE, "utf-8"));
  } catch {}
  return {};
}

async function saveProfiles(profiles: Record<string, any>): Promise<void> {
  await ensureDir(TOOLS_DIR);
  await writeManagedJson(PROJECT_PROFILES_FILE, profiles);
}

async function loadSnapshots(): Promise<any[]> {
  try {
    if (existsSync(SNAPSHOTS_FILE)) return JSON.parse(await readFile(SNAPSHOTS_FILE, "utf-8"));
  } catch {}
  return [];
}

async function saveSnapshots(snapshots: any[]): Promise<void> {
  await ensureDir(TOOLS_DIR);
  await writeManagedJson(SNAPSHOTS_FILE, snapshots);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function hasAnyFilesWithExt(projectPath: string, extensions: string[]): boolean {
  try {
    const files = readdirSync(projectPath);
    return files.some((f) => extensions.some((ext) => f.endsWith(ext)));
  } catch {
    return false;
  }
}

function detectProjectType(projectPath: string): string {
  if (hasAnyFilesWithExt(projectPath, [".sln", ".csproj"])) {
    if (existsSync(path.join(projectPath, "MainWindow.xaml"))) return "dotnet-wpf";
    if (existsSync(path.join(projectPath, "Form1.cs"))) return "dotnet-winforms";
    return "dotnet-webapi";
  }
  if (existsSync(path.join(projectPath, "package.json"))) return "node";
  if (existsSync(path.join(projectPath, "requirements.txt")) || existsSync(path.join(projectPath, "pyproject.toml"))) return "python";
  if (existsSync(path.join(projectPath, "Cargo.toml"))) return "rust";
  return "other";
}

async function checkProjectReadiness(projectPath: string): Promise<any> {
  const issues: string[] = [];
  const hasGit = existsSync(path.join(projectPath, ".git"));
  const hasContinue = existsSync(path.join(projectPath, ".continue")) || existsSync(path.join(os.homedir(), ".continue"));
  const hasPackageJson = existsSync(path.join(projectPath, "package.json"));
  const hasPyproject = existsSync(path.join(projectPath, "pyproject.toml"));
  if (!hasGit) issues.push("No git repository initialized");
  if (!hasContinue) issues.push("Continue config not found");
  if (!await ollamaReachable()) issues.push("Ollama is not running — AI coding assistance unavailable");
  if (!await commandExists("code")) issues.push("VS Code CLI not found on PATH");
  if (!await commandExists("git")) issues.push("Git not found on PATH");
  const ollamaOk = !issues.some((i) => i.includes("Ollama"));
  const aiReadiness = issues.length === 0 ? "ready" : ollamaOk ? "partial" : "not-ready";
  return { hasGit, hasContinue, hasPackageJson, hasPyproject, aiReadiness, aiReadinessIssues: issues };
}

function defaultProfile(projectId: string, type: string): any {
  const base = {
    projectId,
    preferredCodingModel: "",
    preferredReasoningModel: "",
    preferredEmbeddingsModel: "",
    autoOpenAider: false,
    autoReindex: false,
  };
  if (type === "node") return { ...base, lintCommand: "pnpm lint", testCommand: "pnpm test", buildCommand: "pnpm build", runCommand: "pnpm dev" };
  if (type === "python") return { ...base, lintCommand: "ruff check .", testCommand: "pytest", buildCommand: "python -m build", runCommand: "python -m app.main" };
  if (type === "dotnet") return { ...base, lintCommand: "dotnet format --verify-no-changes", testCommand: "dotnet test", buildCommand: "dotnet build", runCommand: "dotnet run" };
  return base;
}

async function writeTemplateFiles(targetPath: string, templateId: string, projectName: string, brief?: string): Promise<void> {
  const template = TEMPLATE_DEFS.find((t) => t.id === templateId);
  if (!template) return;
  await ensureDir(targetPath);
  const files: Record<string, string> = {
    ".gitignore": `node_modules/\ndist/\n.vscode/\n.env\n__pycache__/\n.pytest_cache/\n.venv/\n`,
    "README.md": `# ${projectName}\n\n${brief || "AI-generated workspace scaffold."}\n\n## Template\n- ${templateId}\n\n## Next steps\n- Open in VS Code\n- Validate model roles\n- Start Aider if desired\n`,
    "src/main.py": `def main():\n    print('Hello from ${projectName}')\n\nif __name__ == '__main__':\n    main()\n`,
    "tests/test_smoke.py": `def test_smoke():\n    assert True\n`,
    "app/main.py": `from fastapi import FastAPI\n\napp = FastAPI(title='${projectName}')\n\n@app.get('/healthz')\ndef healthz():\n    return {'status': 'ok'}\n`,
    "tests/test_health.py": `from app.main import app\n\ndef test_placeholder():\n    assert app.title == '${projectName}'\n`,
    "pyproject.toml": `[project]\nname = '${projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}'\nversion = '0.1.0'\ndescription = '${(brief || "AI scaffold").replace(/'/g, "")}'\nrequires-python = '>=3.11'\n\n[tool.pytest.ini_options]\ntestpaths = ['tests']\n`,
    "package.json": JSON.stringify({ name: projectName.toLowerCase().replace(/[^a-z0-9]+/g, "-"), private: true, version: "0.1.0", scripts: { dev: "vite", build: "vite build", lint: "eslint .", test: "vitest" } }, null, 2),
    "index.html": `<!doctype html><html><body><div id='root'></div><script type='module' src='/src/main.tsx'></script></body></html>`,
    "src/main.tsx": `import React from 'react';\nimport ReactDOM from 'react-dom/client';\nimport App from './App';\nimport './index.css';\n\nReactDOM.createRoot(document.getElementById('root')!).render(<App />);\n`,
    "src/App.tsx": `export default function App() {\n  return <main style={{padding:24,fontFamily:'Inter, sans-serif'}}><h1>${projectName}</h1><p>${(brief || "Generated workspace").replace(/`/g, "")}</p></main>;\n}\n`,
    "src/index.css": `:root { color-scheme: dark; } body { margin: 0; background: #0a0d14; color: #f4f7ff; }`,
    "Program.cs": `Console.WriteLine("Hello from ${projectName}");\n`,
    "docs/index.md": `# ${projectName}\n\n${brief || "Documentation workspace scaffold."}\n`,
    "src/screens/brief.md": `# UI brief\n\n${brief || "Describe the UI direction here."}\n`,
  };
  for (const relativePath of template.files) {
    const absolute = path.join(targetPath, relativePath);
    await ensureDir(path.dirname(absolute));
    await writeManagedFile(absolute, files[relativePath] || `# ${projectName}\n`);
  }
}

router.get("/workspace/projects", async (_req, res) => {
  const [projects, profiles] = await Promise.all([loadProjects(), loadProfiles()]);
  const enriched = await Promise.all(projects.map(async (p: any) => ({ ...p, profile: profiles[p.id], ...await checkProjectReadiness(p.path) })));
  const pinnedCount = enriched.filter((p: any) => p.pinned).length;
  const recentCount = enriched.filter((p: any) => !p.pinned).length;
  enriched.sort((a: any, b: any) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return new Date(b.lastOpened).getTime() - new Date(a.lastOpened).getTime();
  });
  return res.json({ projects: enriched, recentCount, pinnedCount });
});

router.post("/workspace/projects", async (req, res) => {
  const body = req.body;
  const projects = await loadProjects();
  await ensureDir(body.path);
  thoughtLog.publish({
    category: "workspace",
    title: "Workspace Create Requested",
    message: `Preparing workspace ${body.name}`,
    metadata: { path: body.path, templateId: body.templateId, bootstrapRepo: !!body.bootstrapRepo },
  });
  if (body.templateId) {
    await writeTemplateFiles(body.path, body.templateId, body.name, body.brief);
  }
  if (body.bootstrapRepo) {
    try {
      await execCommand(`git init ${shellQuote(body.path)}`, 10000);
    } catch {}
  }
  const newProject = {
    id: randomUUID(),
    name: body.name,
    path: body.path,
    type: body.type || detectProjectType(body.path),
    pinned: false,
    lastOpened: new Date().toISOString(),
  };
  projects.push(newProject);
  await saveProjects(projects);
  const profiles = await loadProfiles();
  profiles[newProject.id] = defaultProfile(newProject.id, newProject.type);
  await saveProfiles(profiles);
  if (body.openInVscode) {
    exec(isWindows ? `cmd /c start "" code ${shellQuote(body.path)}` : `code ${shellQuote(body.path)}`);
  }
  if (body.openAider) {
    exec(isWindows ? `cmd /c start "Aider" cmd /k "cd /d ${shellQuote(body.path)} && aider"` : `x-terminal-emulator -e 'cd ${shellQuote(body.path)} && aider'`);
  }
  return res.json({ ...newProject, profile: profiles[newProject.id], ...await checkProjectReadiness(body.path) });
});

router.post("/workspace/projects/:projectId/open", async (req, res) => {
  const { projectId } = req.params;
  const { mode } = req.body;
  const projects = await loadProjects();
  const project = projects.find((p: any) => p.id === projectId);
  if (!project) return res.status(404).json({ success: false, message: "Project not found" });
  project.lastOpened = new Date().toISOString();
  await saveProjects(projects);
  try {
    if (mode === "terminal") {
      if (await commandExists("wt")) {
        exec(`cmd /c start "" wt -d ${shellQuote(project.path)}`);
      } else if (isWindows) {
        exec(`cmd /c start "Terminal" cmd /k "cd /d ${shellQuote(project.path)}"`);
      } else {
        exec(`x-terminal-emulator -e 'cd ${shellQuote(project.path)} && bash'`);
      }
    } else if (mode === "vscode-aider") {
      exec(isWindows ? `cmd /c start "" code ${shellQuote(project.path)}` : `code ${shellQuote(project.path)}`);
      setTimeout(() => {
        if (isWindows) exec(`cmd /c start "Aider" cmd /k "cd /d ${shellQuote(project.path)} && aider"`);
        else exec(`x-terminal-emulator -e 'cd ${shellQuote(project.path)} && aider'`);
      }, 1200);
    } else {
      exec(isWindows ? `cmd /c start "" code ${shellQuote(project.path)}` : `code ${shellQuote(project.path)}`);
    }
    return res.json({ success: true, message: `Opened '${project.name}' in ${mode}` });
  } catch (err: any) {
    return res.json({ success: false, message: "Failed to open project", details: err.message });
  }
});

router.post("/workspace/projects/:projectId/pin", async (req, res) => {
  const { projectId } = req.params;
  const projects = await loadProjects();
  const project = projects.find((p: any) => p.id === projectId);
  if (!project) return res.status(404).json({ success: false, message: "Project not found" });
  project.pinned = !project.pinned;
  await saveProjects(projects);
  return res.json({ success: true, message: project.pinned ? "Project pinned" : "Project unpinned" });
});

router.get("/workspace/snapshots", async (_req, res) => {
  const snapshots = await loadSnapshots();
  return res.json({ snapshots });
});

router.post("/workspace/projects/:projectId/snapshots", async (req, res) => {
  const { projectId } = req.params;
  const { label } = req.body;
  const projects = await loadProjects();
  const project = projects.find((entry: any) => entry.id === projectId);
  if (!project) return res.status(404).json({ success: false, message: "Project not found" });
  const snapshotId = randomUUID();
  const snapshotLabel = label?.trim() || `Snapshot ${new Date().toLocaleString()}`;
  const snapshotPath = path.join(WORKSPACE_SNAPSHOTS_DIR, `${slugify(project.name)}-${Date.now()}`);
  await ensureDir(WORKSPACE_SNAPSHOTS_DIR);
  await cp(project.path, snapshotPath, { recursive: true, force: true });
  const snapshots = await loadSnapshots();
  const snapshot = {
    id: snapshotId,
    projectId,
    label: snapshotLabel,
    createdAt: new Date().toISOString(),
    sourcePath: project.path,
    snapshotPath,
  };
  snapshots.unshift(snapshot);
  await saveSnapshots(snapshots);
  return res.json({ success: true, snapshot });
});

router.post("/workspace/projects/:projectId/archive", async (req, res) => {
  const { projectId } = req.params;
  const projects = await loadProjects();
  const project = projects.find((entry: any) => entry.id === projectId);
  if (!project) return res.status(404).json({ success: false, message: "Project not found" });
  const archivePath = path.join(WORKSPACE_ARCHIVES_DIR, `${slugify(project.name)}-${Date.now()}`);
  await ensureDir(WORKSPACE_ARCHIVES_DIR);
  try {
    await rename(project.path, archivePath);
  } catch {
    await cp(project.path, archivePath, { recursive: true, force: true });
    await robustCleanup(project.path);
  }
  project.path = archivePath;
  project.archived = true;
  project.lastOpened = new Date().toISOString();
  await saveProjects(projects);
  return res.json({ success: true, message: "Workspace archived", archivePath, project });
});

router.post("/workspace/projects/:projectId/clone", async (req, res) => {
  const { projectId } = req.params;
  const { path: targetPath, name } = req.body;
  if (!targetPath) return res.status(400).json({ success: false, message: "Target path required" });
  const projects = await loadProjects();
  const project = projects.find((entry: any) => entry.id === projectId);
  if (!project) return res.status(404).json({ success: false, message: "Project not found" });
  await ensureDir(path.dirname(targetPath));
  await cp(project.path, targetPath, { recursive: true, force: true });
  const profiles = await loadProfiles();
  const clonedProject = {
    id: randomUUID(),
    name: name?.trim() || `${project.name} Copy`,
    path: targetPath,
    type: project.type,
    pinned: false,
    lastOpened: new Date().toISOString(),
  };
  projects.push(clonedProject);
  await saveProjects(projects);
  if (profiles[project.id]) {
    profiles[clonedProject.id] = { ...profiles[project.id], projectId: clonedProject.id };
    await saveProfiles(profiles);
  }
  return res.json({ success: true, project: clonedProject });
});

router.delete("/workspace/projects/:projectId", async (req, res) => {
  const { projectId } = req.params;
  const projects = await loadProjects();
  const index = projects.findIndex((entry: any) => entry.id === projectId);
  if (index === -1) return res.status(404).json({ success: false, message: "Project not found" });
  const [project] = projects.splice(index, 1);
  const cleanup = await robustCleanup(project.path);
  await saveProjects(projects);
  const profiles = await loadProfiles();
  delete profiles[projectId];
  await saveProfiles(profiles);
  return res.json({
    success: cleanup.success,
    message: cleanup.message,
    removed: cleanup.removed || false,
    scheduledForReboot: cleanup.scheduledForReboot || false,
    projectId,
  });
});

router.get("/workspace/readiness", async (_req, res) => {
  const items = [
    {
      label: "Ollama",
      status: await ollamaReachable() ? "ok" : "error",
      message: await ollamaReachable() ? "Running and reachable at port 11434" : "Not running. Start Ollama to enable AI coding",
    },
    {
      label: "VS Code",
      status: await commandExists("code") ? "ok" : "warning",
      message: await commandExists("code") ? "Found on PATH" : "VS Code CLI not found on PATH",
    },
    {
      label: "Continue Extension",
      status: existsSync(path.join(os.homedir(), ".continue")) ? "ok" : "warning",
      message: existsSync(path.join(os.homedir(), ".continue")) ? "~/.continue directory found" : "~/.continue not found — install Continue VS Code extension",
    },
    {
      label: "Aider",
      status: await commandExists("aider") ? "ok" : "warning",
      message: await commandExists("aider") ? "Found on PATH" : "Aider not installed (pip install aider-chat)",
    },
    {
      label: "Git",
      status: await commandExists("git") ? "ok" : "error",
      message: await commandExists("git") ? "Found on PATH" : "Git not installed",
    },
  ];
  const errorCount = items.filter((i) => i.status === "error").length;
  const warningCount = items.filter((i) => i.status === "warning").length;
  const overallStatus = errorCount > 0 ? "not-ready" : warningCount > 0 ? "partial" : "ready";
  const recommendations = items.filter((i) => i.status !== "ok").map((i) => i.message);
  return res.json({ overallStatus, items, recommendations });
});

router.get("/workspace/templates", async (_req, res) => {
  return res.json({ templates: TEMPLATE_DEFS });
});

router.get("/workspace/profiles", async (_req, res) => {
  return res.json({ profiles: await loadProfiles() });
});

router.put("/workspace/profiles/:projectId", async (req, res) => {
  const { projectId } = req.params;
  const profiles = await loadProfiles();
  profiles[projectId] = { ...profiles[projectId] || { projectId }, ...req.body, projectId };
  await saveProfiles(profiles);
  return res.json({ success: true, profile: profiles[projectId] });
});

router.get("/workspace/studio-presets", async (_req, res) => {
  let saved: any[] = [];
  try {
    if (existsSync(STUDIO_PRESETS_FILE)) saved = JSON.parse(await readFile(STUDIO_PRESETS_FILE, "utf-8"));
  } catch {}
  return res.json({ presets: saved, templates: TEMPLATE_DEFS });
});

router.post("/workspace/studio-presets", async (req, res) => {
  const incoming = req.body;
  await ensureDir(TOOLS_DIR);
  await writeManagedJson(STUDIO_PRESETS_FILE, incoming.presets || []);
  return res.json({ success: true, count: incoming.presets?.length || 0 });
});

export default router;
