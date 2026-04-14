import { Router } from "express";
import os from "os";
import path from "path";
import ts from "typescript";
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import {
  execCommand,
  commandExists,
  ollamaReachable,
  isWindows,
  toolsRoot,
  ensureDir,
  postJson,
} from "../lib/runtime.js";
import { writeManagedJson, writeManagedFile } from "../lib/snapshot-manager.js";
import {
  generateOpenScadScript,
  generateBlenderPythonScript,
  optimizeGCode,
  getImageGenStatus,
  expandImagePrompt,
  generateImage,
  runInstall,
  testEndpoint,
} from "../lib/studio-pipeline.js";

const router = Router();
const STUDIOS_DIR = path.join(os.homedir(), "LocalAI-Studios");
const MODEL_ROLES_FILE = path.join(toolsRoot(), "model-roles.json");

const GENERATION_CONSTRAINTS = [
  "Never generate an entire app in one response.",
  "Generate one file at a time from the manifest queue.",
  "Do not leave TODOs, placeholders, or fake imports.",
  "Preserve the established Studio UX and design language.",
];

const COMMON_REVIEW_CHECKLIST = [
  "No placeholder code, TODOs, or mocked imports.",
  "All referenced imports must exist in package metadata or sibling files.",
  "The file must compile or parse for its language before moving on.",
  "Only the current file may be generated in this step.",
];

const STUDIO_TEMPLATES = [
  { id: "react-vite", label: "React + Vite", category: "frontend", icon: "⚛️", description: "React 18, Vite, TypeScript, Tailwind CSS, shadcn/ui", stack: ["React 18", "Vite", "TypeScript", "Tailwind CSS", "shadcn/ui"] },
  { id: "nextjs", label: "Next.js App", category: "fullstack", icon: "▲", description: "Next.js 14 App Router, TypeScript, Tailwind CSS", stack: ["Next.js 14", "App Router", "TypeScript", "Tailwind CSS"] },
  { id: "fastapi", label: "FastAPI Backend", category: "backend", icon: "⚡", description: "FastAPI, Pydantic v2, SQLAlchemy, uvicorn", stack: ["FastAPI", "Pydantic v2", "SQLAlchemy", "uvicorn"] },
  { id: "python-app", label: "Python App", category: "backend", icon: "🐍", description: "Python 3, pyproject.toml, pytest, ruff, typing", stack: ["Python 3", "pyproject.toml", "pytest", "ruff"] },
  { id: "electron", label: "Electron Desktop", category: "desktop", icon: "🖥️", description: "Electron, React, TypeScript — desktop app", stack: ["Electron", "React", "TypeScript", "Auto-updater"] },
  { id: "tauri", label: "Tauri Desktop", category: "desktop", icon: "🦀", description: "Tauri (Rust), React frontend — lightweight native app", stack: ["Tauri", "Rust", "React", "TypeScript"] },
  { id: "express-api", label: "Express API", category: "backend", icon: "🚀", description: "Node.js Express, TypeScript, zod validation, pino logging", stack: ["Express", "TypeScript", "zod", "pino"] },
  { id: "dotnet-console", label: ".NET Console", category: "dotnet", icon: "🟦", description: ".NET 9 Console App, DI, Serilog, typed options", stack: [".NET 9", "Serilog", "DI", "Typed options"] },
  { id: "dotnet-wpf", label: ".NET WPF App", category: "dotnet", icon: "🪟", description: ".NET 9 WPF, MVVM, typed settings", stack: [".NET 9", "WPF", "MVVM", "CommunityToolkit.Mvvm"] },
  { id: "vue-vite", label: "Vue 3 + Vite", category: "frontend", icon: "💚", description: "Vue 3 Composition API, Vite, TypeScript, Pinia", stack: ["Vue 3", "Vite", "TypeScript", "Pinia"] },
  { id: "svelte-kit", label: "SvelteKit", category: "fullstack", icon: "🔥", description: "SvelteKit, TypeScript, Tailwind CSS", stack: ["SvelteKit", "TypeScript", "Tailwind CSS"] },
  { id: "docs-spec", label: "Docs / Spec", category: "docs", icon: "📚", description: "Markdown docs, MkDocs or VitePress, Vale linter", stack: ["Markdown", "VitePress", "Vale linter", "Conventional commits"] },
  { id: "chrome-extension", label: "Chrome Extension", category: "browser", icon: "🧩", description: "Chrome Extension Manifest v3, React popup, TypeScript", stack: ["Chrome MV3", "React", "TypeScript", "Vite"] },
  { id: "cli-tool", label: "CLI Tool", category: "tools", icon: "🔧", description: "Node.js CLI with commander, inquirer, chalk", stack: ["Node.js", "commander", "inquirer", "chalk"] },
  { id: "discord-bot", label: "Discord Bot", category: "bots", icon: "🤖", description: "Discord.js v14 bot, TypeScript, slash commands", stack: ["Discord.js v14", "TypeScript", "Slash commands"] },
];

const buildJobs = new Map<string, any>();

async function getPreferredStudioModel(): Promise<string | null> {
  try {
    if (!existsSync(MODEL_ROLES_FILE)) return null;
    const roles = JSON.parse(await readFile(MODEL_ROLES_FILE, "utf-8"));
    return roles["primary-coding"] || roles.chat || null;
  } catch {
    return null;
  }
}

function slugifyStudioName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "studio";
}

function listStudioTemplates() {
  return STUDIO_TEMPLATES;
}

function logJob(jobId: string, message: string): void {
  const job = buildJobs.get(jobId);
  if (!job) return;
  job.log.push(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
  buildJobs.set(jobId, job);
}

function setJobError(jobId: string, message: string): void {
  const job = buildJobs.get(jobId);
  if (!job) return;
  logJob(jobId, `ERROR: ${message}`);
  job.status = "error";
  job.finishedAt = new Date().toISOString();
  buildJobs.set(jobId, job);
}

function inferTemplateFromBrief(brief: string): string {
  const lower = brief.toLowerCase();
  if (lower.includes("fastapi")) return "fastapi";
  if (lower.includes("electron")) return "electron";
  if (lower.includes("tauri")) return "tauri";
  if (lower.includes("wpf") || lower.includes("desktop")) return "dotnet-wpf";
  if (lower.includes("api") || lower.includes("express")) return "express-api";
  if (lower.includes("python")) return "python-app";
  if (lower.includes("vue")) return "vue-vite";
  if (lower.includes("svelte")) return "svelte-kit";
  if (lower.includes("next")) return "nextjs";
  return "react-vite";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function stripCodeFence(value: string): string {
  return value.trim().replace(/^```[a-zA-Z0-9_-]*\s*/, "").replace(/```$/, "").trim();
}

function normalizeGeneratedContent(_filePath: string, content: string): string {
  const normalized = stripCodeFence(content).replace(/\r\n/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

function renderTemplate(template: string, context: Record<string, any>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key) => `${context[key] ?? ""}`);
}

function createCommonFiles(): any[] {
  return [
    { path: ".ai-rules.md", purpose: "Describe generation rules and project constraints for future AI edits.", templateKey: "ai-rules", language: "markdown", reviewFocus: ["constraints", "project brief"] },
    { path: "README.md", purpose: "Introduce the project, architecture, and how to start it.", templateKey: "readme", language: "markdown", dependsOn: [".ai-rules.md"], reviewFocus: ["onboarding steps", "stack accuracy"] },
    { path: "IMPLEMENTATION_PLAN.md", purpose: "List the manifest-driven execution plan and next steps.", templateKey: "implementation-plan", language: "markdown", dependsOn: ["README.md"], reviewFocus: ["atomic execution plan", "next steps"] },
    { path: ".gitignore", purpose: "Ignore generated artifacts and local secrets.", templateKey: "gitignore", language: "text", reviewFocus: ["common local artifacts"] },
  ];
}

const TEMPLATE_DEFINITIONS = new Map<string, any>([
  ["react-vite", {
    metadata: STUDIO_TEMPLATES.find((t) => t.id === "react-vite"),
    architecture: ["Vite bootstraps a React + TypeScript frontend.", "The landing screen explains the generated architecture and next steps.", "The project stays intentionally small so later agentic passes can extend it safely."],
    dependencies: ["react", "react-dom", "vite", "typescript", "@vitejs/plugin-react"],
    commands: ["pnpm install", "pnpm dev", "pnpm build"],
    files: [...createCommonFiles(), { path: "package.json", purpose: "Define React + Vite scripts and dependencies.", templateKey: "package-json", language: "json" }, { path: "tsconfig.json", purpose: "Configure TypeScript for a Vite frontend.", templateKey: "tsconfig", language: "json", dependsOn: ["package.json"] }, { path: "index.html", purpose: "Provide the single HTML mount point.", templateKey: "index-html", language: "html", dependsOn: ["package.json"] }, { path: "src/main.tsx", purpose: "Mount the React application.", templateKey: "main-tsx", language: "typescript", dependsOn: ["package.json", "index.html"] }, { path: "src/App.tsx", purpose: "Render the initial application shell.", templateKey: "app-tsx", language: "typescript", dependsOn: ["src/main.tsx"] }, { path: "src/index.css", purpose: "Provide the base page styling.", templateKey: "index-css", language: "css", dependsOn: ["src/App.tsx"] }],
  }],
  ["nextjs", {
    metadata: STUDIO_TEMPLATES.find((t) => t.id === "nextjs"),
    architecture: ["Next.js App Router serves a single landing page.", "Global styles and metadata are centralized in app/layout.tsx.", "The generated app is intentionally minimal and ready for future agentic expansion."],
    dependencies: ["next", "react", "react-dom", "typescript"],
    commands: ["pnpm install", "pnpm dev", "pnpm build"],
    files: [...createCommonFiles(), { path: "package.json", purpose: "Define Next.js scripts and dependencies.", templateKey: "package-json", language: "json" }, { path: "tsconfig.json", purpose: "Configure TypeScript for Next.js.", templateKey: "tsconfig", language: "json" }, { path: "app/layout.tsx", purpose: "Wrap the App Router layout and metadata.", templateKey: "app-layout", language: "typescript" }, { path: "app/page.tsx", purpose: "Render the landing page.", templateKey: "app-page", language: "typescript", dependsOn: ["app/layout.tsx"] }, { path: "app/globals.css", purpose: "Set global styles for the generated app.", templateKey: "globals-css", language: "css", dependsOn: ["app/page.tsx"] }],
  }],
  ["fastapi", {
    metadata: STUDIO_TEMPLATES.find((t) => t.id === "fastapi"),
    architecture: ["FastAPI exposes a health route and a root route.", "Application settings stay small and explicit in pyproject.toml.", "The API scaffold is ready for later routers and services."],
    dependencies: ["fastapi", "uvicorn", "pydantic", "sqlalchemy"],
    commands: ["python -m venv .venv", "pip install -e .", "uvicorn src.main:app --reload"],
    files: [...createCommonFiles(), { path: "pyproject.toml", purpose: "Define the FastAPI project dependencies.", templateKey: "pyproject", language: "toml" }, { path: "src/main.py", purpose: "Expose the FastAPI application entrypoint.", templateKey: "main-py", language: "python", dependsOn: ["pyproject.toml"] }, { path: "tests/test_smoke.py", purpose: "Provide a minimal smoke test.", templateKey: "test-py", language: "python", dependsOn: ["src/main.py"] }],
  }],
  ["python-app", {
    metadata: STUDIO_TEMPLATES.find((t) => t.id === "python-app"),
    architecture: ["A typed Python entrypoint runs from src/main.py.", "Tests and linting are configured in pyproject.toml.", "The scaffold is kept small so agentic follow-up passes stay focused."],
    dependencies: ["python", "pytest", "ruff"],
    commands: ["python -m venv .venv", "pip install -e .", "pytest"],
    files: [...createCommonFiles(), { path: "pyproject.toml", purpose: "Define the Python package metadata and tooling.", templateKey: "pyproject", language: "toml" }, { path: "src/main.py", purpose: "Run the application entrypoint.", templateKey: "cli-main-py", language: "python", dependsOn: ["pyproject.toml"] }, { path: "tests/test_smoke.py", purpose: "Provide a minimal smoke test.", templateKey: "test-py", language: "python", dependsOn: ["src/main.py"] }],
  }],
  ["electron", {
    metadata: STUDIO_TEMPLATES.find((t) => t.id === "electron"),
    architecture: ["Electron starts a single BrowserWindow from a lightweight main process.", "The renderer remains a React + Vite surface.", "The preload layer is reserved for future IPC without over-building the first pass."],
    dependencies: ["electron", "react", "react-dom", "vite", "typescript"],
    commands: ["pnpm install", "pnpm dev", "pnpm build"],
    files: [...createCommonFiles(), { path: "package.json", purpose: "Define Electron scripts and dependencies.", templateKey: "electron-package-json", language: "json" }, { path: "electron/main.ts", purpose: "Boot the Electron main process.", templateKey: "electron-main-ts", language: "typescript" }, { path: "src/main.tsx", purpose: "Mount the renderer app.", templateKey: "main-tsx", language: "typescript" }, { path: "src/App.tsx", purpose: "Render the desktop application shell.", templateKey: "app-tsx", language: "typescript" }, { path: "src/index.css", purpose: "Style the renderer shell.", templateKey: "index-css", language: "css" }],
  }],
  ["express-api", {
    metadata: STUDIO_TEMPLATES.find((t) => t.id === "express-api"),
    architecture: ["Express serves a small health and root endpoint.", "The app separates the HTTP bootstrap from process startup.", "TypeScript keeps the initial surface explicit and maintainable."],
    dependencies: ["express", "typescript"],
    commands: ["pnpm install", "pnpm dev", "pnpm build"],
    files: [...createCommonFiles(), { path: "package.json", purpose: "Define Express scripts and dependencies.", templateKey: "express-package-json", language: "json" }, { path: "tsconfig.json", purpose: "Configure TypeScript for Node.js.", templateKey: "node-tsconfig", language: "json" }, { path: "src/app.ts", purpose: "Create the Express app instance.", templateKey: "express-app-ts", language: "typescript" }, { path: "src/index.ts", purpose: "Start the Express server.", templateKey: "express-index-ts", language: "typescript", dependsOn: ["src/app.ts"] }],
  }],
]);

// Fill in remaining template definitions for completeness
for (const tmpl of STUDIO_TEMPLATES) {
  if (!TEMPLATE_DEFINITIONS.has(tmpl.id)) {
    TEMPLATE_DEFINITIONS.set(tmpl.id, {
      metadata: tmpl,
      architecture: [`${tmpl.label} scaffold.`],
      dependencies: tmpl.stack,
      commands: ["pnpm install", "pnpm dev", "pnpm build"],
      files: createCommonFiles(),
    });
  }
}

function templateContextForManifest(manifest: any): Record<string, any> {
  const template = TEMPLATE_DEFINITIONS.get(manifest.templateId)?.metadata || STUDIO_TEMPLATES[0];
  return {
    projectName: manifest.projectName,
    slug: manifest.slug,
    brief: manifest.brief,
    templateLabel: template.label,
    architectureBulletList: manifest.architecture.map((item: string) => `- ${item}`).join("\n"),
    dependencyBulletList: manifest.dependencies.map((item: string) => `- ${item}`).join("\n"),
    commandBulletList: manifest.commands.map((item: string) => `- ${item}`).join("\n"),
    year: new Date().getFullYear(),
  };
}

function planFromManifest(manifest: any, notes: string[] = []): any {
  const template = TEMPLATE_DEFINITIONS.get(manifest.templateId)?.metadata;
  return {
    name: manifest.projectName,
    summary: manifest.brief,
    recommendedTemplate: manifest.templateId,
    stack: template?.stack || [],
    files: manifest.files.map((file: any) => file.path),
    commands: manifest.commands,
    notes: [...notes, "Studio uses a manifest-driven Plan-Act-Verify pipeline.", "Each file is generated, reviewed, and verified independently."],
    manifest,
  };
}

function buildManifestFromTemplate(brief: string, templateId: string, slug: string, projectName: string, architecture?: string[], dependencies?: string[], commands?: string[]): any {
  const definition = TEMPLATE_DEFINITIONS.get(templateId) || TEMPLATE_DEFINITIONS.get("react-vite");
  const context = { slug };
  return {
    version: 1,
    projectName,
    slug,
    brief,
    templateId: definition.metadata.id,
    architecture: architecture?.length ? architecture : definition.architecture,
    dependencies: dependencies?.length ? dependencies : definition.dependencies,
    constraints: GENERATION_CONSTRAINTS,
    commands: commands?.length ? commands : definition.commands,
    reviewerChecklist: COMMON_REVIEW_CHECKLIST,
    files: definition.files.map((file: any) => ({
      ...file,
      path: renderTemplate(file.path, context),
      dependsOn: file.dependsOn?.map((dep: string) => renderTemplate(dep, context)),
    })),
  };
}

async function createStudioPlan(brief: string, templateId?: string): Promise<any> {
  const requestedTemplate = TEMPLATE_DEFINITIONS.get(templateId || "")?.metadata.id;
  const fallbackTemplate = requestedTemplate || inferTemplateFromBrief(brief);
  const fallbackManifest = buildManifestFromTemplate(brief, fallbackTemplate, slugifyStudioName(brief), brief);
  const fallbackPlan = planFromManifest(fallbackManifest);
  if (!await ollamaReachable()) {
    return { plan: fallbackPlan, generatedBy: "fallback" };
  }
  const model = await getPreferredStudioModel();
  if (!model) {
    return { plan: fallbackPlan, generatedBy: "fallback" };
  }
  try {
    const prompt = [
      "You are the Architect phase of a multi-step software generation pipeline.",
      "Return ONLY valid JSON with keys: projectName, summary, recommendedTemplate, architecture, dependencies, commands, notes.",
      `Allowed recommendedTemplate values: ${STUDIO_TEMPLATES.map((t) => t.id).join(", ")}`,
      "Do not generate file contents. This phase only outputs the blueprint.",
      `User brief: ${brief}`,
      templateId ? `Preferred template: ${templateId}` : "",
    ].filter(Boolean).join("\n");
    const result = await postJson<{ response?: string }>("http://127.0.0.1:11434/api/generate", { model, prompt, stream: false, format: "json" }, 35000);
    const parsed = JSON.parse(result.response || "{}");
    const selectedTemplate = TEMPLATE_DEFINITIONS.has(parsed.recommendedTemplate || "") ? parsed.recommendedTemplate : fallbackTemplate;
    const manifest = buildManifestFromTemplate(parsed.summary || brief, selectedTemplate, slugifyStudioName(parsed.projectName || brief), parsed.projectName || brief, parsed.architecture, parsed.dependencies, parsed.commands);
    return { plan: planFromManifest(manifest, parsed.notes || []), generatedBy: model };
  } catch {
    return { plan: fallbackPlan, generatedBy: "fallback" };
  }
}

function createStudioBuildJob(name: string, brief: string, templateId: string, aiPlan?: any): any {
  const safeName = name.replace(/[^a-zA-Z0-9-_ ]/g, "").trim() || "studio";
  const studioPath = path.join(STUDIOS_DIR, safeName);
  const manifest = aiPlan?.manifest || buildManifestFromTemplate(brief || safeName, templateId, slugifyStudioName(safeName), safeName);
  const jobId = randomUUID();
  const job = {
    id: jobId,
    name: safeName,
    status: "pending",
    phase: "architect",
    log: [],
    studioPath,
    startedAt: new Date().toISOString(),
    manifest,
    artifacts: manifest.files.map((file: any) => ({ path: file.path, status: "queued", reviewNotes: [], verification: [] })),
  };
  buildJobs.set(jobId, job);
  void runStudioBuild(jobId);
  return job;
}

function getStudioBuildJob(jobId: string): any {
  return buildJobs.get(jobId);
}

async function maybeInitializeGit(jobId: string, studioPath: string, name: string): Promise<void> {
  if (!await commandExists("git")) return;
  try {
    await execCommand("git init", 15000, studioPath);
    await execCommand("git add .", 5000, studioPath);
    await execCommand(`git commit -m "Initial scaffold: ${name}"`, 10000, studioPath);
    logJob(jobId, "Git repository initialized and initial commit made");
  } catch {
    logJob(jobId, "Git init skipped (non-fatal)");
  }
}

async function maybeOpenInCode(jobId: string, studioPath: string): Promise<void> {
  if (!await commandExists("code")) return;
  try {
    const command = isWindows ? `start "" code "${studioPath}"` : `code "${studioPath}"`;
    await execCommand(command, 8000);
    logJob(jobId, "Opened in VS Code");
  } catch {
    logJob(jobId, "VS Code open skipped");
  }
}

function collectStaticReviewIssues(filePath: string, content: string, manifest: any): string[] {
  const issues: string[] = [];
  const lower = content.toLowerCase();
  const placeholderTokens = ["todo", "tbd", "lorem ipsum", "placeholder", "your code here"];
  for (const token of placeholderTokens) {
    if (lower.includes(token)) issues.push(`Contains placeholder token: ${token}`);
  }
  if (/\bfrom ['"]@\/components\/ui\//.test(content) && manifest.templateId !== "react-vite") {
    issues.push("Imports a UI package outside the selected template stack.");
  }
  if (filePath.endsWith("package.json")) {
    try {
      const parsed = JSON.parse(content);
      if (!parsed.scripts || Object.keys(parsed.scripts).length === 0) {
        issues.push("package.json is missing scripts.");
      }
    } catch {
      issues.push("package.json is invalid JSON.");
    }
  }
  return issues;
}

async function reviewGeneratedFile(manifest: any, file: any, content: string, model: string | null): Promise<{ ok: boolean; issues: string[] }> {
  const issues = collectStaticReviewIssues(file.path, content, manifest);
  if (model && await ollamaReachable()) {
    try {
      const prompt = [
        "You are the Reviewer phase of a manifest-driven software generation pipeline.",
        "Return ONLY valid JSON with keys: ok (boolean), issues (string array).",
        "Block the file if imports are hallucinated, the file breaks the manifest contract, or placeholder code exists.",
        `Project: ${manifest.projectName}`,
        `Target file: ${file.path}`,
        `Purpose: ${file.purpose}`,
        `Reviewer checklist: ${manifest.reviewerChecklist.join(" | ")}`,
        "File content:",
        content,
      ].join("\n");
      const result = await postJson<{ response?: string }>("http://127.0.0.1:11434/api/generate", { model, prompt, stream: false, format: "json" }, 30000);
      const parsed = JSON.parse(result.response || "{}");
      if (Array.isArray(parsed.issues)) issues.push(...parsed.issues.filter(Boolean));
      if (parsed.ok === false) return { ok: false, issues: uniqueStrings(issues).slice(0, 8) };
    } catch {}
  }
  return { ok: issues.length === 0, issues: uniqueStrings(issues).slice(0, 8) };
}

async function verifyGeneratedFile(filePath: string, content: string): Promise<{ ok: boolean; diagnostics: string[] }> {
  const extension = path.extname(filePath).toLowerCase();
  try {
    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
      const result = ts.transpileModule(content, {
        fileName: filePath,
        compilerOptions: {
          jsx: extension === ".tsx" || extension === ".jsx" ? ts.JsxEmit.ReactJSX : ts.JsxEmit.None,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        reportDiagnostics: true,
      });
      const diagnostics = (result.diagnostics || []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      return { ok: diagnostics.length === 0, diagnostics: diagnostics.length ? diagnostics : ["TypeScript syntax OK"] };
    }
    if (extension === ".json") {
      JSON.parse(content);
      return { ok: true, diagnostics: ["JSON parse OK"] };
    }
    if (extension === ".py" && await commandExists("python")) {
      const tempDir = path.join(os.tmpdir(), `studio-verify-${randomUUID()}`);
      await mkdir(tempDir, { recursive: true });
      const tempFile = path.join(tempDir, path.basename(filePath));
      await writeFile(tempFile, content, "utf-8");
      await execCommand(`python -m py_compile "${tempFile}"`, 15000, tempDir);
      return { ok: true, diagnostics: ["Python compile OK"] };
    }
    return { ok: true, diagnostics: ["Verification skipped for this file type"] };
  } catch (error: any) {
    return { ok: false, diagnostics: [error.message] };
  }
}

async function generateManifestFile(manifest: any, file: any): Promise<string> {
  const context = templateContextForManifest(manifest);
  let generated = `# ${manifest.projectName}\n\n${file.purpose}\n`;
  if (await ollamaReachable()) {
    const model = await getPreferredStudioModel();
    if (model) {
      try {
        const prompt = [
          "You are the Builder phase of a manifest-driven software generation pipeline.",
          "Generate ONLY the requested file content. Do not describe the result.",
          `Project: ${manifest.projectName}`,
          `Brief: ${manifest.brief}`,
          `Template: ${manifest.templateId}`,
          `Target file: ${file.path}`,
          `Purpose: ${file.purpose}`,
          `Dependencies: ${manifest.dependencies.join(", ")}`,
          `Architecture: ${manifest.architecture.join(" | ")}`,
          "Generate the complete file content now:",
        ].join("\n");
        const result = await postJson<{ response?: string }>("http://127.0.0.1:11434/api/generate", { model, prompt, stream: false }, 40000);
        const candidate = stripCodeFence(result.response || "");
        if (candidate.trim()) generated = candidate;
      } catch {}
    }
  }
  return normalizeGeneratedContent(file.path, generated);
}

async function runStudioBuild(jobId: string): Promise<void> {
  const job = buildJobs.get(jobId);
  if (!job || !job.manifest) return;
  try {
    job.status = "running";
    buildJobs.set(jobId, job);
    await ensureDir(STUDIOS_DIR);
    await ensureDir(job.studioPath);
    logJob(jobId, "Architect phase: writing manifest.json blueprint");
    await writeManagedJson(path.join(job.studioPath, "manifest.json"), job.manifest);
    logJob(jobId, `Manifest contains ${job.manifest.files.length} atomic generation tasks`);
    const reviewModel = await getPreferredStudioModel();
    if (reviewModel) {
      job.reviewerModel = reviewModel;
      buildJobs.set(jobId, job);
      logJob(jobId, `Reviewer agent ready: ${reviewModel}`);
    } else {
      logJob(jobId, "Reviewer agent fallback: local static checks");
    }
    for (const file of job.manifest.files) {
      const artifact = job.artifacts.find((entry: any) => entry.path === file.path);
      if (!artifact) continue;
      job.currentFile = file.path;
      job.phase = "builder";
      artifact.status = "writing";
      buildJobs.set(jobId, job);
      logJob(jobId, `Builder phase: generating ${file.path}`);
      const generated = await generateManifestFile(job.manifest, file);
      const targetPath = path.join(job.studioPath, file.path);
      await ensureDir(path.dirname(targetPath));
      await writeManagedFile(targetPath, generated);
      artifact.status = "reviewing";
      job.phase = "reviewer";
      buildJobs.set(jobId, job);
      logJob(jobId, `Reviewer phase: checking ${file.path}`);
      const review = await reviewGeneratedFile(job.manifest, file, generated, reviewModel);
      artifact.reviewNotes = review.issues;
      if (!review.ok) {
        artifact.status = "failed";
        buildJobs.set(jobId, job);
        throw new Error(`Reviewer blocked ${file.path}: ${review.issues.join("; ")}`);
      }
      artifact.status = "verified";
      job.phase = "verifier";
      buildJobs.set(jobId, job);
      logJob(jobId, `Verifier phase: validating ${file.path}`);
      const verification = await verifyGeneratedFile(targetPath, generated);
      artifact.verification = verification.diagnostics;
      if (!verification.ok) {
        artifact.status = "failed";
        buildJobs.set(jobId, job);
        throw new Error(`Verification failed for ${file.path}: ${verification.diagnostics.join("; ")}`);
      }
      logJob(jobId, `Verified ${file.path}`);
      logJob(jobId, `Context buffer cleared after ${file.path}`);
    }
    await maybeInitializeGit(jobId, job.studioPath, job.name);

    // ── Vibe Coding: auto-install dependencies ──────────────────────────────
    const hasPackageJson = existsSync(path.join(job.studioPath, "package.json"));
    const hasPyproject   = existsSync(path.join(job.studioPath, "pyproject.toml"));
    if (hasPackageJson) {
      job.phase = "install";
      buildJobs.set(jobId, job);
      logJob(jobId, "Vibe Coding: running pnpm install...");
      const installResult = await runInstall(job.studioPath);
      job.installResult = installResult;
      buildJobs.set(jobId, job);
      if (installResult.success) {
        logJob(jobId, `pnpm install succeeded in ${installResult.durationMs}ms`);
      } else {
        logJob(jobId, `pnpm install warning: ${installResult.stderr.slice(0, 200)}`);
      }
    } else if (hasPyproject) {
      logJob(jobId, "Python project detected — run `pip install -e .` to install dependencies");
    }

    await maybeOpenInCode(jobId, job.studioPath);
    job.status = "done";
    job.phase = "completed";
    job.finishedAt = new Date().toISOString();
    buildJobs.set(jobId, job);
    logJob(jobId, `Studio ready: ${job.studioPath}`);
  } catch (error: any) {
    setJobError(jobId, error.message);
  }
}

router.get("/studios/templates", async (_req, res) => {
  return res.json({ templates: listStudioTemplates() });
});

router.get("/studios/catalog", async (_req, res) => {
  return res.json({
    workspaces: listStudioTemplates().map((template) => ({
      id: template.id,
      label: template.label,
      description: template.description,
      templateId: template.id,
      category: template.category,
    })),
    parameterBlocks: [
      { id: "quality-gates", label: "Quality Gates", lines: ["Manifest-first builds only", "Reviewer blocks placeholders and hallucinated imports", "Verifier runs after every file write"] },
      { id: "pipeline", label: "Plan-Act-Verify", lines: ["Architect writes manifest.json", "Builder processes one file at a time", "Context buffer clears between files"] },
      { id: "repo-readiness", label: "Repo Readiness", lines: ["Git initialized with first commit when available", "VS Code workspace opens automatically", "AI rules file in repo root"] },
    ],
  });
});

router.post("/studios/plan", async (req, res) => {
  const { brief, templateId } = req.body;
  if (!brief?.trim()) {
    return res.status(400).json({ success: false, message: "brief required" });
  }
  try {
    const result = await createStudioPlan(brief, templateId);
    return res.json({ success: true, ...result });
  } catch (error: any) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/studios/build", async (req, res) => {
  const { name, brief, templateId, aiPlan } = req.body;
  if (!name?.trim() || !templateId) {
    return res.status(400).json({ success: false, message: "name and templateId required" });
  }
  const job = createStudioBuildJob(name, brief || name, templateId, aiPlan);
  return res.json({ success: true, jobId: job.id, studioPath: job.studioPath });
});

router.get("/studios/build/:jobId", async (req, res) => {
  const job = getStudioBuildJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, message: "Job not found" });
  }
  return res.json({ success: true, job });
});

// ── Vibe Coding: test endpoint ─────────────────────────────────────────────

router.post("/studios/vibecheck", async (req, res) => {
  const { studioPath, port, endpointPath, startCommand } = req.body as {
    studioPath?: string;
    port?: number;
    endpointPath?: string;
    startCommand?: string;
  };
  if (!studioPath) {
    return res.status(400).json({ success: false, message: "studioPath required" });
  }
  if (!existsSync(studioPath)) {
    return res.status(404).json({ success: false, message: "studioPath not found" });
  }
  const result = await testEndpoint(
    studioPath,
    port ?? 5173,
    endpointPath ?? "/",
    startCommand ?? "pnpm dev",
  );
  return res.json({ success: result.success, result });
});

// ── CAD / Hardware Studio routes ──────────────────────────────────────────

/** POST /studios/cad/openscad — generate an OpenSCAD script from a description */
router.post("/studios/cad/openscad", async (req, res) => {
  const { description, save } = req.body as { description?: string; save?: boolean };
  if (!description?.trim()) {
    return res.status(400).json({ success: false, message: "description required" });
  }
  try {
    const result = await generateOpenScadScript(description, save !== false);
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /studios/cad/blender — generate a Blender Python script from a description */
router.post("/studios/cad/blender", async (req, res) => {
  const { description, save } = req.body as { description?: string; save?: boolean };
  if (!description?.trim()) {
    return res.status(400).json({ success: false, message: "description required" });
  }
  try {
    const result = await generateBlenderPythonScript(description, save !== false);
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /studios/cad/gcode — optimize raw G-Code */
router.post("/studios/cad/gcode", async (req, res) => {
  const { gcode, printerType, save } = req.body as {
    gcode?: string;
    printerType?: "fdm" | "laser";
    save?: boolean;
  };
  if (!gcode?.trim()) {
    return res.status(400).json({ success: false, message: "gcode required" });
  }
  try {
    const result = await optimizeGCode(gcode, printerType ?? "fdm", save !== false);
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err instanceof Error ? err.message : String(err) });
  }
});

// ── Image Generation Studio routes ────────────────────────────────────────

/** GET /studios/imagegen/status — probe ComfyUI and SD Web UI */
router.get("/studios/imagegen/status", async (_req, res) => {
  const status = await getImageGenStatus();
  return res.json(status);
});

/** POST /studios/imagegen/expand-prompt — run the Prompt Architect */
router.post("/studios/imagegen/expand-prompt", async (req, res) => {
  const { prompt, style } = req.body as {
    prompt?: string;
    style?: "photorealistic" | "anime" | "oil-painting" | "sketch" | "cinematic";
  };
  if (!prompt?.trim()) {
    return res.status(400).json({ success: false, message: "prompt required" });
  }
  try {
    const result = await expandImagePrompt(prompt, style ?? "photorealistic");
    return res.json({ success: true, result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err instanceof Error ? err.message : String(err) });
  }
});

/** POST /studios/imagegen/generate — generate an image */
router.post("/studios/imagegen/generate", async (req, res) => {
  const {
    prompt,
    expandPrompt,
    style,
    steps,
    cfgScale,
    width,
    height,
    seed,
    saveImages,
  } = req.body as {
    prompt?: string;
    expandPrompt?: boolean;
    style?: "photorealistic" | "anime" | "oil-painting" | "sketch" | "cinematic";
    steps?: number;
    cfgScale?: number;
    width?: number;
    height?: number;
    seed?: number;
    saveImages?: boolean;
  };
  if (!prompt?.trim()) {
    return res.status(400).json({ success: false, message: "prompt required" });
  }
  const result = await generateImage(prompt, {
    expandPrompt: expandPrompt !== false,
    style:        style ?? "photorealistic",
    steps:        steps ?? 20,
    cfgScale:     cfgScale ?? 7,
    width:        width ?? 512,
    height:       height ?? 512,
    seed:         seed ?? -1,
    saveImages:   saveImages !== false,
  });
  return res.status(result.success ? 200 : 503).json({ success: result.success, result });
});

router.get("/studios/integrations", async (_req, res) => {
  return res.json({
    repos: [
      { id: "open-webui", name: "Open WebUI", repo: "https://github.com/open-webui/open-webui", why: "Browser-first chat UI for any local or remote LLM", category: "core", integrated: true },
      { id: "pipelines", name: "Open WebUI Pipelines", repo: "https://github.com/open-webui/pipelines", why: "Build workflows, RAG pipelines, and function calling on top of Open WebUI", category: "enhancement", integrated: false },
      { id: "mcpo", name: "MCPO", repo: "https://github.com/open-webui/mcpo", why: "Expose MCP tools as OpenAPI endpoints — bridges Claude tools to Open WebUI", category: "enhancement", integrated: false },
      { id: "continue", name: "Continue", repo: "https://github.com/continuedev/continue", why: "Best VS Code AI coding assistant — managed from the Continue page", category: "core", integrated: true },
      { id: "aider", name: "Aider", repo: "https://github.com/Aider-AI/aider", why: "High-agency repo editing with architect mode and git integration", category: "core", integrated: true },
      { id: "litellm", name: "LiteLLM", repo: "https://github.com/BerriAI/litellm", why: "Route any model call through a unified OpenAI-compatible gateway with fallbacks and aliases", category: "core", integrated: true },
      { id: "fabric", name: "Fabric", repo: "https://github.com/danielmiessler/fabric", why: "Prompt pattern library — AI-augmented workflows for summarization, extraction, analysis", category: "enhancement", integrated: false },
      { id: "jan", name: "Jan", repo: "https://github.com/janhq/jan", why: "Desktop alternative to Open WebUI with model management", category: "alternative", integrated: false },
      { id: "lm-studio", name: "LM Studio", repo: "https://lmstudio.ai", why: "GUI model manager with OpenAI-compatible local server", category: "alternative", integrated: false },
      { id: "taskfile", name: "Taskfile", repo: "https://github.com/go-task/task", why: "Replace Makefile with YAML task runner — run lint/test/build from VS Code", category: "tooling", integrated: false },
      { id: "ollama-benchmark", name: "Ollama Benchmark", repo: "https://github.com/ggerganov/llama.cpp", why: "Benchmark tokens/sec on your GPU before committing to a model", category: "tooling", integrated: false },
      { id: "anythingllm", name: "AnythingLLM", repo: "https://github.com/Mintplex-Labs/anything-llm", why: "RAG on your own documents with local models — self-hosted", category: "enhancement", integrated: false },
    ],
  });
});

export default router;
