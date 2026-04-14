import { Router } from "express";
import { copyFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
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
  execCommand,
} from "../lib/runtime.js";
import { writeManagedFile } from "../lib/snapshot-manager.js";

const router = Router();
const HOME = os.homedir();
const TOOLS_DIR = toolsRoot();

async function processRunningWindows(imageName: string): Promise<boolean> {
  try {
    const { stdout } = await execCommand(`tasklist /FI "IMAGENAME eq ${imageName}"`, 5000);
    return stdout.toLowerCase().includes(imageName.toLowerCase());
  } catch {
    return false;
  }
}

async function processRunningUnix(pattern: string): Promise<boolean> {
  try {
    const { stdout } = await execCommand(`pgrep -f "${pattern}"`, 5000);
    return !!stdout.trim();
  } catch {
    return false;
  }
}

async function stopProcessWindows(imageName: string): Promise<void> {
  await execCommand(`taskkill /F /IM ${imageName}`, 8000).catch(() => undefined);
}

async function stopProcessUnix(pattern: string): Promise<void> {
  await execCommand(`pkill -f "${pattern}"`, 8000).catch(() => undefined);
}

interface ComponentDef {
  id: string;
  name: string;
  category: string;
  pathHint?: string;
  detect: () => Promise<{ installed: boolean; path?: string }>;
  version?: () => Promise<string | null>;
  running?: () => Promise<boolean>;
  start?: () => Promise<void>;
  stop?: () => Promise<void>;
}

const COMPONENTS: ComponentDef[] = [
  {
    id: "ollama",
    name: "Ollama",
    category: "ai",
    pathHint: "%LOCALAPPDATA%/Programs/Ollama",
    detect: async () => ({ installed: await commandExists("ollama") }),
    version: async () => maybeVersion("ollama --version"),
    running: async () => ollamaReachable(),
    start: async () => {
      if (isWindows) exec('cmd /c start "" ollama serve');
      else exec("ollama serve >/dev/null 2>&1 &");
    },
    stop: async () => {
      if (isWindows) await stopProcessWindows("ollama.exe");
      else await stopProcessUnix("ollama serve");
    },
  },
  {
    id: "open-webui",
    name: "Open WebUI",
    category: "ai",
    pathHint: "%USERPROFILE%/LocalAI-OpenWebUI/Scripts/open-webui.exe",
    detect: async () => {
      const exePath = path.join(HOME, "LocalAI-OpenWebUI", "Scripts", "open-webui.exe");
      return { installed: existsSync(exePath) || (await commandExists("open-webui")), path: existsSync(exePath) ? exePath : undefined };
    },
    version: async () => maybeVersion("open-webui --version"),
    running: async () =>
      fetchText("http://127.0.0.1:8080", undefined, 2500)
        .then(() => true)
        .catch(() => false),
    start: async () => {
      const exePath = path.join(HOME, "LocalAI-OpenWebUI", "Scripts", "open-webui.exe");
      if (existsSync(exePath)) {
        if (isWindows) exec(`cmd /c start "Open WebUI" "${exePath}" serve`);
        else exec(`"${exePath}" serve >/dev/null 2>&1 &`);
      } else {
        if (isWindows) exec('cmd /c start "Open WebUI" open-webui serve');
        else exec("open-webui serve >/dev/null 2>&1 &");
      }
    },
    stop: async () => {
      if (isWindows) await stopProcessWindows("open-webui.exe");
      else await stopProcessUnix("open-webui");
    },
  },
  {
    id: "litellm",
    name: "LiteLLM Gateway",
    category: "ai",
    pathHint: "pip install litellm",
    detect: async () => ({ installed: await commandExists("litellm") }),
    version: async () => maybeVersion("litellm --version"),
    running: async () =>
      fetchText("http://127.0.0.1:4000/health", undefined, 2500)
        .then(() => true)
        .catch(() => false),
    start: async () => {
      const cfg = path.join(TOOLS_DIR, "remote", "litellm-config.yaml");
      if (isWindows) exec(`cmd /c start "LiteLLM" cmd /k "litellm --config "${cfg}" --port 4000"`);
      else exec(`litellm --config ${cfg} --port 4000 >/dev/null 2>&1 &`);
    },
    stop: async () => {
      if (isWindows) await stopProcessWindows("litellm.exe");
      else await stopProcessUnix("litellm");
    },
  },
  {
    id: "vscode",
    name: "VS Code",
    category: "dev",
    pathHint: "%LOCALAPPDATA%/Programs/Microsoft VS Code/bin/code",
    detect: async () => ({ installed: await commandExists("code") }),
    version: async () => maybeVersion("code --version"),
  },
  {
    id: "python",
    name: "Python",
    category: "dev",
    detect: async () => ({ installed: await commandExists("python") }),
    version: async () => maybeVersion("python --version"),
  },
  {
    id: "git",
    name: "Git",
    category: "dev",
    detect: async () => ({ installed: await commandExists("git") }),
    version: async () => maybeVersion("git --version"),
  },
  {
    id: "github-cli",
    name: "GitHub CLI",
    category: "dev",
    detect: async () => ({ installed: await commandExists("gh") }),
    version: async () => maybeVersion("gh --version"),
  },
  {
    id: "node",
    name: "Node.js",
    category: "dev",
    detect: async () => ({ installed: await commandExists("node") }),
    version: async () => maybeVersion("node --version"),
  },
  {
    id: "dotnet",
    name: ".NET SDK",
    category: "dev",
    detect: async () => ({ installed: await commandExists("dotnet") }),
    version: async () => maybeVersion("dotnet --version"),
  },
  {
    id: "aider",
    name: "Aider",
    category: "tools",
    detect: async () => ({ installed: await commandExists("aider") }),
    version: async () => maybeVersion("aider --version"),
  },
  {
    id: "nvitop",
    name: "nvitop",
    category: "tools",
    detect: async () => ({ installed: await commandExists("nvitop") }),
    version: async () => maybeVersion("nvitop --version"),
  },
  {
    id: "windows-terminal",
    name: "Windows Terminal",
    category: "tools",
    pathHint: "Microsoft Store / winget",
    detect: async () => ({ installed: await commandExists("wt") }),
  },
  {
    id: "continue",
    name: "Continue (VS Code ext)",
    category: "tools",
    pathHint: "~/.continue",
    detect: async () => ({ installed: existsSync(path.join(HOME, ".continue")) }),
  },
  {
    id: "code-server",
    name: "code-server (Browser IDE)",
    category: "optional",
    detect: async () => ({ installed: await commandExists("code-server") }),
    version: async () => maybeVersion("code-server --version"),
    running: async () =>
      fetchText("http://127.0.0.1:8443", undefined, 2500)
        .then(() => true)
        .catch(() => false),
    start: async () => {
      if (isWindows)
        exec('start "Browser IDE" cmd /k "code-server --config %USERPROFILE%\\LocalAI-Tools\\remote\\code-server.yaml"');
      else exec("code-server --bind-addr 127.0.0.1:8443 >/dev/null 2>&1 &");
    },
    stop: async () => {
      if (isWindows) await stopProcessWindows("code-server.exe");
      else await stopProcessUnix("code-server");
    },
  },
  {
    id: "openvscode-server",
    name: "OpenVSCode Server",
    category: "optional",
    detect: async () => ({ installed: await commandExists("openvscode-server") }),
    version: async () => maybeVersion("openvscode-server --version"),
    running: async () =>
      fetchText("http://127.0.0.1:3000", undefined, 2500)
        .then(() => true)
        .catch(() => false),
    start: async () => {
      if (isWindows)
        exec('cmd /c start "OpenVSCode Server" cmd /k "openvscode-server --host 127.0.0.1 --port 3000"');
      else exec("openvscode-server --host 127.0.0.1 --port 3000 >/dev/null 2>&1 &");
    },
    stop: async () => {
      if (isWindows) await stopProcessWindows("openvscode-server.exe");
      else await stopProcessUnix("openvscode-server");
    },
  },
  {
    id: "cloudflare-tunnel",
    name: "Cloudflare Tunnel (cloudflared)",
    category: "optional",
    detect: async () => ({ installed: await commandExists("cloudflared") }),
    version: async () => maybeVersion("cloudflared --version"),
    running: async () =>
      isWindows ? processRunningWindows("cloudflared.exe") : processRunningUnix("cloudflared"),
    start: async () => {
      if (isWindows) exec('cmd /c start "Cloudflare Tunnel" cmd /k "cloudflared tunnel run"');
      else exec("cloudflared tunnel run >/dev/null 2>&1 &");
    },
    stop: async () => {
      if (isWindows) await stopProcessWindows("cloudflared.exe");
      else await stopProcessUnix("cloudflared");
    },
  },
  {
    id: "comfyui",
    name: "ComfyUI Desktop",
    category: "optional",
    pathHint: "Install separately if needed",
    detect: async () => ({ installed: false }),
  },
  {
    id: "rust",
    name: "Rust / Cargo",
    category: "optional",
    detect: async () => ({ installed: await commandExists("cargo") }),
    version: async () => maybeVersion("cargo --version"),
  },
];

async function detectComponent(comp: ComponentDef): Promise<any> {
  const detect = comp.detect ? await comp.detect() : { installed: false };
  const running = comp.running ? await comp.running().catch(() => false) : false;
  const version = detect.installed && comp.version ? await comp.version().catch(() => null) : null;
  const statusMessage = detect.installed
    ? undefined
    : comp.pathHint
    ? `Not found. ${comp.pathHint}`
    : "Not detected on PATH";
  return {
    id: comp.id,
    name: comp.name,
    installed: detect.installed,
    running,
    version: version || undefined,
    path: (detect as any).path || comp.pathHint,
    category: comp.category,
    canStart: detect.installed && !!comp.start && !running,
    canStop: running && !!comp.stop,
    canInstall: !detect.installed,
    statusMessage,
  };
}

router.get("/stack/status", async (req, res) => {
  try {
    const results = await Promise.all(COMPONENTS.map(detectComponent));
    const installed = results.filter((r) => r.installed).length;
    const healthScore = Math.round((installed / results.length) * 100);
    const ollamaReach = await ollamaReachable();
    const webuiReach = await fetchText("http://127.0.0.1:8080", undefined, 2500)
      .then(() => true)
      .catch(() => false);
    return res.json({ components: results, ollamaReachable: ollamaReach, openWebUIReachable: webuiReach, healthScore });
  } catch (err: any) {
    (req as any).log?.error(err);
    return res.status(500).json({ components: [], ollamaReachable: false, openWebUIReachable: false, healthScore: 0 });
  }
});

router.post("/stack/components/:componentId/start", async (req, res) => {
  const comp = COMPONENTS.find((c) => c.id === req.params.componentId);
  if (!comp) return res.status(404).json({ success: false, message: `Component '${req.params.componentId}' not found` });
  if (!comp.start) return res.json({ success: false, message: `No start command for '${comp.name}'` });
  try {
    await comp.start();
    return res.json({ success: true, message: `Starting ${comp.name}...` });
  } catch (err: any) {
    return res.json({ success: false, message: `Failed to start ${comp.name}`, details: err.message });
  }
});

router.post("/stack/components/:componentId/stop", async (req, res) => {
  const comp = COMPONENTS.find((c) => c.id === req.params.componentId);
  if (!comp) return res.status(404).json({ success: false, message: `Component '${req.params.componentId}' not found` });
  if (!comp.stop) return res.json({ success: false, message: `No stop command for '${comp.name}'` });
  try {
    await comp.stop();
    return res.json({ success: true, message: `${comp.name} stopped` });
  } catch (err: any) {
    return res.json({ success: false, message: `Stop may have failed for ${comp.name}`, details: err.message });
  }
});

router.post("/stack/components/:componentId/restart", async (req, res) => {
  const comp = COMPONENTS.find((c) => c.id === req.params.componentId);
  if (!comp) return res.status(404).json({ success: false, message: `Component '${req.params.componentId}' not found` });
  try {
    if (comp.stop) await comp.stop().catch(() => undefined);
    if (comp.start) await comp.start();
    return res.json({ success: true, message: `Restarting ${comp.name}...` });
  } catch (err: any) {
    return res.json({ success: false, message: `Restart failed for ${comp.name}`, details: err.message });
  }
});

router.post("/stack/backup", async (_req, res) => {
  const backupDir = path.join(HOME, "LocalAI-Backups");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const webuiExe = path.join(HOME, "LocalAI-OpenWebUI", "Scripts", "open-webui.exe");
  const secretKey = path.join(HOME, "LocalAI-Tools", ".webui_secret_key");
  try {
    await mkdir(backupDir, { recursive: true });
    const manifestPath = path.join(backupDir, `webui-backup-${timestamp}.txt`);
    const lines = [
      `Created: ${new Date().toISOString()}`,
      `Open WebUI executable exists: ${existsSync(webuiExe)}`,
      `Secret key exists: ${existsSync(secretKey)}`,
      `Tools root: ${TOOLS_DIR}`,
    ].join("\n");
    await writeManagedFile(manifestPath, lines);
    if (existsSync(secretKey)) {
      await copyFile(secretKey, path.join(backupDir, `.webui_secret_key.${timestamp}`)).catch(() => undefined);
    }
    return res.json({ success: true, message: `Backup manifest created → ${manifestPath}` });
  } catch (err: any) {
    return res.json({ success: false, message: "Backup failed", details: err.message });
  }
});

router.post("/stack/github-auth", async (_req, res) => {
  try {
    if (isWindows) exec('cmd /c start "GitHub Login" cmd /k "gh auth login --web"');
    else exec("gh auth login --web");
    return res.json({ success: true, message: "GitHub auth flow launched." });
  } catch (err: any) {
    return res.json({ success: false, message: "Failed to launch GitHub auth", details: err.message });
  }
});

router.get("/stack/github-status", async (_req, res) => {
  try {
    const { stdout, stderr } = await execCommand("gh auth status", 8000);
    const text = `${stdout}\n${stderr}`.trim();
    const authenticated = /logged in/i.test(text) || /oauth_token/i.test(text) || /token/i.test(text);
    const usernameMatch = text.match(/Logged in to github\.com as (\S+)/i);
    return res.json({ authenticated, username: usernameMatch?.[1], details: text });
  } catch {
    return res.json({ authenticated: false, details: "gh CLI not installed or not authenticated" });
  }
});

export default router;
