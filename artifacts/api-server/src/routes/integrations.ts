import { Router } from "express";
import { exec } from "child_process";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import {
  commandExists,
  maybeVersion,
  fetchText,
  isWindows,
  toolsRoot,
  ensureDir,
} from "../lib/runtime.js";
import { writeManagedJson } from "../lib/snapshot-manager.js";

const router = Router();
const TOOLS_DIR = toolsRoot();
const INTEGRATIONS_STATE_FILE = path.join(TOOLS_DIR, "integrations-state.json");

interface Integration {
  id: string;
  name: string;
  repo: string;
  category: string;
  description: string;
  installMethod: string;
  pipPackage?: string;
  wingetId?: string;
  packageId?: string;
  localPort?: number;
  healthUrl?: string;
  aiderTip?: string;
  usedFor: string;
  docs: string;
  installCmd: string;
  startCmd: string;
  updateCmd: string;
  detect: () => Promise<boolean>;
  version: () => Promise<string | null>;
  running: () => Promise<boolean>;
}

const INTEGRATIONS: Integration[] = [
  {
    id: "open-webui", name: "Open WebUI", repo: "https://github.com/open-webui/open-webui", category: "core",
    description: "Polished browser-first chat interface for any local or remote LLM. Supports RAG, tools, model management, and collaborative workspaces.",
    installMethod: "pip", pipPackage: "open-webui", localPort: 8080, healthUrl: "http://localhost:8080",
    detect: async () => commandExists("open-webui"),
    version: async () => maybeVersion("open-webui --version"),
    running: async () => fetchText("http://localhost:8080", undefined, 2500).then(() => true).catch(() => false),
    installCmd: "pip install open-webui",
    startCmd: isWindows ? 'start "Open WebUI" cmd /k "open-webui serve"' : "open-webui serve",
    updateCmd: "pip install --upgrade open-webui",
    docs: "https://docs.openwebui.com", usedFor: "Main chat UI, RAG, model management, team workspaces",
  },
  {
    id: "open-webui-pipelines", name: "Open WebUI Pipelines", repo: "https://github.com/open-webui/pipelines", category: "core",
    description: "Workflow and pipeline engine for Open WebUI — RAG pipelines, function calling, agent chains, and custom tools exposed as callable endpoints.",
    installMethod: "pip", pipPackage: "open-webui-pipelines", localPort: 9099, healthUrl: "http://localhost:9099",
    detect: async () => fetchText("http://localhost:9099", undefined, 2000).then(() => true).catch(() => false),
    version: async () => null,
    running: async () => fetchText("http://localhost:9099", undefined, 2000).then(() => true).catch(() => false),
    installCmd: "pip install open-webui-pipelines",
    startCmd: "uvicorn main:app --host 0.0.0.0 --port 9099",
    updateCmd: "pip install --upgrade open-webui-pipelines",
    docs: "https://github.com/open-webui/pipelines", usedFor: "Visual workflow builder, RAG pipelines, custom tool endpoints",
  },
  {
    id: "litellm", name: "LiteLLM Gateway", repo: "https://github.com/BerriAI/litellm", category: "core",
    description: `OpenAI-compatible proxy that unifies all your local and remote models under one endpoint. Enables model aliases, fallbacks, load balancing, and cost tracking. Fixes Aider's "LLM Provider NOT provided" error.`,
    installMethod: "pip", pipPackage: "litellm[proxy]", localPort: 4000, healthUrl: "http://localhost:4000/health",
    detect: async () => commandExists("litellm"),
    version: async () => maybeVersion("litellm --version"),
    running: async () => fetchText("http://localhost:4000/health", undefined, 2000).then(() => true).catch(() => false),
    installCmd: 'pip install "litellm[proxy]"',
    startCmd: isWindows ? `start "LiteLLM" cmd /k "litellm --model ollama/qwen2.5-coder:7b --port 4000"` : "litellm --model ollama/qwen2.5-coder:7b --port 4000",
    updateCmd: 'pip install --upgrade "litellm[proxy]"',
    docs: "https://docs.litellm.ai", usedFor: "Unified model gateway, Aider integration, Continue integration, cost tracking",
    aiderTip: "Once LiteLLM is running: aider --model openai/<model-name> --openai-api-base http://localhost:4000",
  },
  {
    id: "mcpo", name: "MCPO (MCP→OpenAPI)", repo: "https://github.com/open-webui/mcpo", category: "core",
    description: "Exposes MCP (Model Context Protocol) tool servers as OpenAPI REST endpoints. Bridges Claude's tool ecosystem into Open WebUI and LiteLLM.",
    installMethod: "pip", pipPackage: "mcpo", localPort: 8200, healthUrl: "http://localhost:8200",
    detect: async () => commandExists("mcpo"),
    version: async () => null,
    running: async () => fetchText("http://localhost:8200", undefined, 2000).then(() => true).catch(() => false),
    installCmd: "pip install mcpo", startCmd: "mcpo --port 8200", updateCmd: "pip install --upgrade mcpo",
    docs: "https://github.com/open-webui/mcpo", usedFor: "Expose MCP tools to Open WebUI and LiteLLM as callable REST endpoints",
  },
  {
    id: "aider", name: "Aider", repo: "https://github.com/Aider-AI/aider", category: "coding",
    description: "High-agency AI coding assistant that edits your repo files directly. Supports architect/ask/code modes, git integration, auto-linting, and multi-file edits. Use with LiteLLM to fix the model provider error.",
    installMethod: "pip", pipPackage: "aider-chat",
    detect: async () => commandExists("aider"),
    version: async () => maybeVersion("aider --version"),
    running: async () => false,
    installCmd: "pip install aider-chat", startCmd: "aider", updateCmd: "pip install --upgrade aider-chat",
    docs: "https://aider.chat/docs", usedFor: "Repo-level code editing, architect mode, multi-file changes",
  },
  {
    id: "continue", name: "Continue (VS Code)", repo: "https://github.com/continuedev/continue", category: "coding",
    description: "Best VS Code AI coding extension. Inline completions, chat sidebar, codebase context, and rules files. Managed from the Continue page in this app.",
    installMethod: "vscode",
    detect: async () => existsSync(path.join(os.homedir(), ".continue")),
    version: async () => null,
    running: async () => false,
    installCmd: "code --install-extension Continue.continue", startCmd: "", updateCmd: "code --install-extension Continue.continue",
    docs: "https://docs.continue.dev", usedFor: "VS Code inline completions, codebase chat, rule packs",
  },
  {
    id: "librechat", name: "LibreChat", repo: "https://github.com/danny-avila/LibreChat", category: "chat",
    description: "Advanced self-hosted chat workstation with agents, MCP support, code interpreter, artifacts, multi-model switching, message search, and actions/functions. More powerful than Open WebUI for serious agentic workflows.",
    installMethod: "docker", localPort: 3080, healthUrl: "http://localhost:3080",
    detect: async () => fetchText("http://localhost:3080", undefined, 2000).then(() => true).catch(() => false),
    version: async () => null,
    running: async () => fetchText("http://localhost:3080", undefined, 2000).then(() => true).catch(() => false),
    installCmd: "docker compose up -d  # See https://www.librechat.ai/docs/local",
    startCmd: "docker compose up -d", updateCmd: "docker compose pull && docker compose up -d",
    docs: "https://www.librechat.ai/docs", usedFor: "Agents, MCP tools, artifacts, code interpreter, serious agentic work",
  },
  {
    id: "jan", name: "Jan", repo: "https://github.com/janhq/jan", category: "local-models",
    description: "Local-first desktop app for downloading, running, and managing local models. Provides its own OpenAI-compatible server. Alternative to Ollama for users who prefer a GUI-first model manager.",
    installMethod: "winget", wingetId: "janhq.jan", localPort: 1337, healthUrl: "http://localhost:1337",
    detect: async () => fetchText("http://localhost:1337", undefined, 2000).then(() => true).catch(() => false),
    version: async () => null,
    running: async () => fetchText("http://localhost:1337", undefined, 2000).then(() => true).catch(() => false),
    installCmd: isWindows ? "winget install janhq.jan" : "Download from https://jan.ai",
    startCmd: isWindows ? 'start "" "jan"' : "jan",
    updateCmd: isWindows ? "winget upgrade janhq.jan" : "Download latest from https://jan.ai",
    docs: "https://jan.ai/docs", usedFor: "GUI model manager, local-first runtime, offline model downloads",
  },
  {
    id: "anythingllm", name: "AnythingLLM", repo: "https://github.com/Mintplex-Labs/anything-llm", category: "local-models",
    description: "Self-hosted RAG platform. Drop in documents and chat with them using local models. No cloud required.",
    installMethod: "manual", localPort: 3001,
    detect: async () => false,
    version: async () => null,
    running: async () => fetchText("http://localhost:3001/api/ping", undefined, 2000).then(() => true).catch(() => false),
    installCmd: "Download installer from https://useanything.com", startCmd: "", updateCmd: "Download latest from https://useanything.com",
    docs: "https://docs.useanything.com", usedFor: "Local RAG on your documents, private knowledge base",
  },
  {
    id: "langflow", name: "Langflow", repo: "https://github.com/langflow-ai/langflow", category: "workflows",
    description: "Visual agent and workflow builder. Drag-and-drop LLM pipeline construction. Exposes flows as API endpoints and MCP servers. Best pick for visual automation without writing code.",
    installMethod: "pip", pipPackage: "langflow", localPort: 7860, healthUrl: "http://localhost:7860",
    detect: async () => commandExists("langflow"),
    version: async () => maybeVersion("langflow --version"),
    running: async () => fetchText("http://localhost:7860", undefined, 2000).then(() => true).catch(() => false),
    installCmd: "pip install langflow",
    startCmd: isWindows ? 'start "Langflow" cmd /k "langflow run"' : "langflow run",
    updateCmd: "pip install --upgrade langflow",
    docs: "https://docs.langflow.org", usedFor: "Visual agent/workflow builder, flow-as-API, MCP server authoring",
  },
  {
    id: "worldgui", name: "WorldGUI (Computer Use)", repo: "https://github.com/showlab/WorldGUI", category: "computer-use",
    description: "Computer-use agent framework. AI can control your Windows desktop — click buttons, fill forms, launch apps, and execute multi-step GUI tasks. Adds \"AI can control my PC\" capability.",
    installMethod: "pip", pipPackage: "worldgui",
    detect: async () => commandExists("worldgui"),
    version: async () => null,
    running: async () => false,
    installCmd: "pip install worldgui  # or: git clone https://github.com/showlab/WorldGUI && pip install -e .",
    startCmd: "python -m worldgui", updateCmd: "pip install --upgrade worldgui",
    docs: "https://github.com/showlab/WorldGUI", usedFor: "AI desktop automation, GUI task execution, computer-use agent",
  },
  {
    id: "fabric", name: "Fabric", repo: "https://github.com/danielmiessler/fabric", category: "tools",
    description: "AI augmentation framework with 100+ prompt patterns. Pipe any content through patterns like summarize, extract wisdom, create quiz, write essay. Runs locally with Ollama.",
    installMethod: "pip", pipPackage: "fabric-ai",
    detect: async () => commandExists("fabric"),
    version: async () => maybeVersion("fabric --version"),
    running: async () => false,
    installCmd: "pip install fabric-ai", startCmd: "", updateCmd: "pip install --upgrade fabric-ai",
    docs: "https://github.com/danielmiessler/fabric", usedFor: "Prompt pattern library, summarization, extraction, writing augmentation",
  },
  {
    id: "taskfile", name: "Taskfile (Task runner)", repo: "https://github.com/go-task/task", category: "tools",
    description: "Modern Makefile replacement using YAML. Define lint/test/build/run tasks per project. Integrates with VS Code and runs from Workspace page.",
    installMethod: "winget", wingetId: "Task.Task",
    detect: async () => commandExists("task"),
    version: async () => maybeVersion("task --version"),
    running: async () => false,
    installCmd: isWindows ? "winget install Task.Task" : 'sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d',
    startCmd: "task",
    updateCmd: isWindows ? "winget upgrade Task.Task" : 'sh -c "$(curl --location https://taskfile.dev/install.sh)" -- -d',
    docs: "https://taskfile.dev", usedFor: "Project task runner, lint/test/build shortcuts from VS Code",
  },
  {
    id: "openclaw", name: "OpenClaw", repo: "https://github.com/openclaw/openclaw", category: "assistant",
    description: 'Base assistant/runtime reference architecture. Defines the channel/routine pattern for "AI assistant running on your own devices." Use for overall assistant product direction and multi-routine orchestration.',
    installMethod: "git-clone",
    detect: async () => existsSync(path.join(os.homedir(), "LocalAI-Tools", "repos", "openclaw")),
    version: async () => null,
    running: async () => false,
    installCmd: `git clone https://github.com/openclaw/openclaw "${path.join(os.homedir(), "LocalAI-Tools", "repos", "openclaw")}"`,
    startCmd: "",
    updateCmd: `git -C "${path.join(os.homedir(), "LocalAI-Tools", "repos", "openclaw")}" pull`,
    docs: "https://github.com/openclaw/openclaw", usedFor: "Assistant architecture reference, channel/routine ideas, multi-device AI patterns",
  },
  {
    id: "ironclaw", name: "IronClaw (Security)", repo: "https://github.com/nearai/ironclaw", category: "security",
    description: "Security and backend safety reference. Provides sandboxing patterns, capability permissions, endpoint allowlists, secrets handling, routines, audit logs. Use to harden the local AI stack against misuse.",
    installMethod: "git-clone",
    detect: async () => existsSync(path.join(os.homedir(), "LocalAI-Tools", "repos", "ironclaw")),
    version: async () => null,
    running: async () => false,
    installCmd: `git clone https://github.com/nearai/ironclaw "${path.join(os.homedir(), "LocalAI-Tools", "repos", "ironclaw")}"`,
    startCmd: "",
    updateCmd: `git -C "${path.join(os.homedir(), "LocalAI-Tools", "repos", "ironclaw")}" pull`,
    docs: "https://github.com/nearai/ironclaw", usedFor: "Sandboxing, capability permissions, secrets handling, auditability",
  },
  {
    id: "nerve", name: "Nerve (Cockpit GUI)", repo: "https://github.com/daggerhashimoto/openclaw-nerve", category: "assistant",
    description: "Main GUI inspiration for the command-center shell. Provides patterns for voice control, workspace/file control, kanban/taskboard, sessions, charts, usage visibility, and the cockpit layout. Also contains health-check/rollback patterns used in our updater.",
    installMethod: "git-clone",
    detect: async () => existsSync(path.join(os.homedir(), "LocalAI-Tools", "repos", "nerve")),
    version: async () => null,
    running: async () => false,
    installCmd: `git clone https://github.com/daggerhashimoto/openclaw-nerve "${path.join(os.homedir(), "LocalAI-Tools", "repos", "nerve")}"`,
    startCmd: "",
    updateCmd: `git -C "${path.join(os.homedir(), "LocalAI-Tools", "repos", "nerve")}" pull`,
    docs: "https://github.com/daggerhashimoto/openclaw-nerve", usedFor: "Cockpit UI patterns, voice controls, kanban, health-check/rollback architecture",
  },
  {
    id: "openclaw-windows-node", name: "OpenClaw Windows Node", repo: "https://github.com/openclaw/openclaw-windows-node", category: "windows",
    description: "Windows integration reference. Provides tray app behavior, Windows helper/node services, and PowerToys/desktop-side integration patterns for running AI as a background Windows service.",
    installMethod: "git-clone",
    detect: async () => existsSync(path.join(os.homedir(), "LocalAI-Tools", "repos", "openclaw-windows-node")),
    version: async () => null,
    running: async () => false,
    installCmd: `git clone https://github.com/openclaw/openclaw-windows-node "${path.join(os.homedir(), "LocalAI-Tools", "repos", "openclaw-windows-node")}"`,
    startCmd: "",
    updateCmd: `git -C "${path.join(os.homedir(), "LocalAI-Tools", "repos", "openclaw-windows-node")}" pull`,
    docs: "https://github.com/openclaw/openclaw-windows-node", usedFor: "Tray app, Windows helper services, PowerToys integration patterns",
  },
  {
    id: "mcp-ui", name: "MCP-UI (Tool Renderer)", repo: "https://github.com/MCP-UI-Org/mcp-ui", category: "mcp",
    description: "Plugin/tool UI renderer for MCP. Makes tools render cards, inspectors, dialogs, mini-dashboards, and rich widgets instead of raw text blobs. Bridges MCP tool results into the chat UI.",
    installMethod: "npm", packageId: "@mcp-ui/core",
    detect: async () => false,
    version: async () => null,
    running: async () => false,
    installCmd: "npm install @mcp-ui/core", startCmd: "", updateCmd: "npm update @mcp-ui/core",
    docs: "https://github.com/MCP-UI-Org/mcp-ui", usedFor: "Rich tool output rendering in chat — cards, tables, charts instead of text",
  },
  {
    id: "renovate", name: "Renovate", repo: "https://github.com/renovatebot/renovate", category: "devops",
    description: "Automated dependency update tracking and PR creation. Used behind the scenes for detecting when npm/pip/winget packages in the stack have new versions available. Powers the updater's dependency detection.",
    installMethod: "npm", packageId: "renovate",
    detect: async () => commandExists("renovate"),
    version: async () => maybeVersion("renovate --version"),
    running: async () => false,
    installCmd: "npm install -g renovate", startCmd: "renovate", updateCmd: "npm update -g renovate",
    docs: "https://docs.renovatebot.com", usedFor: "Automated dependency tracking, update detection, PR generation for version bumps",
  },
  {
    id: "release-please", name: "Release Please", repo: "https://github.com/googleapis/release-please", category: "devops",
    description: "Release/changelog automation. Generates clean release PRs, version bumps, and structured CHANGELOG notes that the updater page can display as human-readable release notes.",
    installMethod: "npm", packageId: "release-please",
    detect: async () => commandExists("release-please"),
    version: async () => maybeVersion("release-please --version"),
    running: async () => false,
    installCmd: "npm install -g release-please", startCmd: "", updateCmd: "npm update -g release-please",
    docs: "https://github.com/googleapis/release-please", usedFor: "Changelog generation, version bump PRs, structured release notes for the updater page",
  },
];

async function loadState(): Promise<Record<string, any>> {
  try {
    if (existsSync(INTEGRATIONS_STATE_FILE)) return JSON.parse(await readFile(INTEGRATIONS_STATE_FILE, "utf-8"));
  } catch {}
  return {};
}

async function saveState(state: Record<string, any>): Promise<void> {
  await ensureDir(TOOLS_DIR);
  await writeManagedJson(INTEGRATIONS_STATE_FILE, state);
}

router.get("/integrations", async (_req, res) => {
  const state = await loadState();
  const results = await Promise.all(
    INTEGRATIONS.map(async (intg) => {
      let installed = false;
      let running = false;
      let version: string | null = null;
      try { installed = await intg.detect(); } catch {}
      try { running = installed && await intg.running(); } catch {}
      try { version = installed ? await intg.version() : null; } catch {}
      return {
        id: intg.id,
        name: intg.name,
        repo: intg.repo,
        category: intg.category,
        description: intg.description,
        installMethod: intg.installMethod,
        installCmd: intg.installCmd,
        startCmd: intg.startCmd,
        updateCmd: intg.updateCmd,
        docs: intg.docs,
        usedFor: intg.usedFor,
        localPort: intg.localPort,
        healthUrl: intg.healthUrl,
        aiderTip: intg.aiderTip,
        installed,
        running,
        version,
        pinned: state[intg.id]?.pinned || false,
        updateAvailable: false,
      };
    })
  );
  return res.json({ integrations: results });
});

router.post("/integrations/:id/pin", async (req, res) => {
  const state = await loadState();
  const current = state[req.params.id] || {};
  state[req.params.id] = { ...current, pinned: !current.pinned };
  await saveState(state);
  return res.json({ success: true, pinned: state[req.params.id].pinned });
});

router.post("/integrations/:id/install", async (req, res) => {
  const intg = INTEGRATIONS.find((i) => i.id === req.params.id);
  if (!intg) return res.status(404).json({ success: false, message: "Integration not found" });
  try {
    if (intg.installMethod === "pip") {
      const pkg = intg.pipPackage || intg.id;
      const cmd = isWindows
        ? `start "Installing ${intg.name}" cmd /k "pip install ${pkg} && echo Done - you can close this window"`
        : `x-terminal-emulator -e "pip install ${pkg}"`;
      exec(cmd);
      return res.json({ success: true, message: `Installing ${intg.name} via pip...` });
    }
    if (intg.installMethod === "winget" && isWindows) {
      const id = intg.wingetId;
      exec(`start "Installing ${intg.name}" cmd /k "winget install ${id} --accept-package-agreements --accept-source-agreements && echo Done"`);
      return res.json({ success: true, message: `Installing ${intg.name} via winget...` });
    }
    if (intg.installMethod === "vscode") {
      exec(intg.installCmd);
      return res.json({ success: true, message: `Installing ${intg.name} VS Code extension...` });
    }
    return res.json({ success: true, message: `Manual install required. Command: ${intg.installCmd}`, manual: true, installCmd: intg.installCmd });
  } catch (err: any) {
    return res.json({ success: false, message: err.message });
  }
});

router.post("/integrations/:id/start", async (req, res) => {
  const intg = INTEGRATIONS.find((i) => i.id === req.params.id);
  if (!intg || !intg.startCmd) return res.status(404).json({ success: false, message: "Cannot start this integration" });
  exec(isWindows ? intg.startCmd : `${intg.startCmd} >/dev/null 2>&1 &`);
  return res.json({ success: true, message: `${intg.name} start command sent` });
});

router.get("/integrations/updates", async (_req, res) => {
  const updates: any[] = [];
  for (const intg of INTEGRATIONS) {
    let installed = false;
    try { installed = await intg.detect(); } catch {}
    if (!installed) continue;
    updates.push({ id: intg.id, name: intg.name, updateCmd: intg.updateCmd, hasUpdate: false });
  }
  return res.json({ updates, checkedAt: new Date().toISOString() });
});

router.post("/integrations/:id/update", async (req, res) => {
  const intg = INTEGRATIONS.find((i) => i.id === req.params.id);
  if (!intg) return res.status(404).json({ success: false, message: "Not found" });
  const cmd = isWindows
    ? `start "Updating ${intg.name}" cmd /k "${intg.updateCmd} && echo Done"`
    : `x-terminal-emulator -e "${intg.updateCmd}"`;
  exec(cmd);
  return res.json({ success: true, message: `Updating ${intg.name}...` });
});

export default router;
