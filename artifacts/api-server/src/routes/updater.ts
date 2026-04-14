import { Router } from "express";
import { readFile, copyFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { ollamaReachable, fetchJson, isWindows, toolsRoot, ensureDir } from "../lib/runtime.js";
import { writeManagedJson } from "../lib/snapshot-manager.js";

const execAsync = promisify(exec);
const router = Router();
const TOOLS_DIR = toolsRoot();
const MANIFEST_FILE = path.join(TOOLS_DIR, "updater-manifest.json");
const MODEL_STATES_FILE = path.join(TOOLS_DIR, "model-states.json");
const SNAPSHOTS_DIR = path.join(TOOLS_DIR, "snapshots");

async function loadManifest(): Promise<any> {
  if (existsSync(MANIFEST_FILE)) {
    try {
      return JSON.parse(await readFile(MANIFEST_FILE, "utf-8"));
    } catch {}
  }
  return {
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    core: { installedVersion: "1.0.0", updateAvailable: false },
    repoPacks: {},
    models: {},
    systemTools: {},
    schedule: {
      checkIntervalSeconds: 86400,
      autoInstallPatches: false,
      requireApprovalForMinor: true,
      requireApprovalForMajor: true,
    },
  };
}

async function saveManifest(m: any): Promise<void> {
  await ensureDir(TOOLS_DIR);
  m.generatedAt = new Date().toISOString();
  await writeManagedJson(MANIFEST_FILE, m);
}

async function loadModelStates(): Promise<Record<string, any>> {
  if (existsSync(MODEL_STATES_FILE)) {
    try {
      return JSON.parse(await readFile(MODEL_STATES_FILE, "utf-8"));
    } catch {}
  }
  return {};
}

async function saveModelStates(states: Record<string, any>): Promise<void> {
  await ensureDir(TOOLS_DIR);
  await writeManagedJson(MODEL_STATES_FILE, states);
}

async function getPipLatestVersion(packageName: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execAsync(`pip index versions ${packageName}`, { timeout: 15000 });
    const text = `${stdout}\n${stderr}`;
    const latestMatch = text.match(/LATEST:\s*([^\s\n]+)/i);
    if (latestMatch) return latestMatch[1];
    const versionsMatch = text.match(/Available versions:\s*([^\n]+)/);
    if (versionsMatch) return versionsMatch[1].split(",")[0].trim();
    return null;
  } catch {
    return null;
  }
}

async function getPipInstalledVersion(packageName: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`pip show ${packageName}`, { timeout: 8000 });
    const match = stdout.match(/^Version:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

async function getWingetInstalledVersion(wingetId: string): Promise<string | null> {
  if (!isWindows) return null;
  try {
    const { stdout } = await execAsync(`winget show --id ${wingetId} --exact`, { timeout: 20000 });
    const match = stdout.match(/Version:\s*([^\r\n]+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

async function getWingetAvailableVersion(wingetId: string): Promise<{ available: string | null; updateAvailable: boolean }> {
  if (!isWindows) return { available: null, updateAvailable: false };
  try {
    const { stdout } = await execAsync(`winget upgrade --id ${wingetId} --exact 2>&1`, { timeout: 30000 });
    if (stdout.toLowerCase().includes("no applicable update") || stdout.toLowerCase().includes("already installed")) {
      return { available: null, updateAvailable: false };
    }
    const versionMatch = stdout.match(/[\d]+\.[\d]+\.[\d]+[\.\d]*/);
    return { available: versionMatch ? versionMatch[0] : null, updateAvailable: !!versionMatch };
  } catch {
    return { available: null, updateAvailable: false };
  }
}

async function checkOllamaModelUpdate(modelName: string, installedDigest: string): Promise<{ updateAvailable: boolean; latestDigest?: string }> {
  const [name, tag] = modelName.includes(":") ? modelName.split(":") : [modelName, "latest"];
  try {
    const data = await fetchJson<{ digest?: string }>(
      `https://registry.ollama.ai/v2/library/${name}/manifests/${tag}`,
      { headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" } },
      10000
    );
    const latestDigest = data?.digest?.slice(0, 12) || "";
    if (!latestDigest) return { updateAvailable: false };
    const updateAvailable = latestDigest !== installedDigest && !!installedDigest;
    return { updateAvailable, latestDigest };
  } catch {
    return { updateAvailable: false };
  }
}

async function snapshotModel(modelName: string, digest: string): Promise<string> {
  const snapshotId = `${modelName.replace(/[:/]/g, "-")}-${digest}-${Date.now()}`;
  await ensureDir(SNAPSHOTS_DIR);
  const snapFile = path.join(SNAPSHOTS_DIR, `${snapshotId}.json`);
  await writeManagedJson(snapFile, { modelName, digest, createdAt: new Date().toISOString() });
  return snapshotId;
}

router.get("/updater/manifest", async (_req, res) => {
  const manifest = await loadManifest();
  return res.json({ manifest });
});

router.post("/updater/check", async (req, res) => {
  const { scope = "all" } = req.body;
  const manifest = await loadManifest();
  const results: any[] = [];
  if (scope === "all" || scope === "tools") {
    const SYSTEM_TOOLS = [
      { id: "pwsh", name: "PowerShell 7", wingetId: "Microsoft.PowerShell" },
      { id: "git", name: "Git", wingetId: "Git.Git" },
      { id: "node", name: "Node.js LTS", wingetId: "OpenJS.NodeJS.LTS" },
      { id: "python", name: "Python 3.12", wingetId: "Python.Python.3.12" },
      { id: "code", name: "VS Code", wingetId: "Microsoft.VisualStudioCode" },
      { id: "ollama", name: "Ollama", wingetId: "Ollama.Ollama" },
      { id: "aider", name: "Aider", pip: "aider-chat" },
      { id: "litellm", name: "LiteLLM", pip: "litellm" },
      { id: "fabric", name: "Fabric", pip: "fabric-ai" },
      { id: "open-webui", name: "Open WebUI", pip: "open-webui" },
      { id: "langflow", name: "Langflow", pip: "langflow" },
    ];
    for (const tool of SYSTEM_TOOLS) {
      let installed: string | null = null;
      let available: string | null = null;
      let updateAvailable = false;
      if ((tool as any).wingetId) {
        installed = await getWingetInstalledVersion((tool as any).wingetId);
        if (installed) {
          const check = await getWingetAvailableVersion((tool as any).wingetId);
          available = check.available;
          updateAvailable = check.updateAvailable;
        }
      } else if ((tool as any).pip) {
        installed = await getPipInstalledVersion((tool as any).pip);
        if (installed) {
          available = await getPipLatestVersion((tool as any).pip);
          updateAvailable = !!available && available !== installed;
        }
      }
      manifest.systemTools[tool.id] = {
        installedVersion: installed || undefined,
        checkedAt: new Date().toISOString(),
        latestVersion: available || undefined,
        updateAvailable,
        wingetId: (tool as any).wingetId,
        pipName: (tool as any).pip,
      };
      results.push({ id: tool.id, type: "tool", name: tool.name, installed: installed || undefined, available: available || undefined, updateAvailable });
    }
  }
  if (scope === "all" || scope === "models") {
    const states = await loadModelStates();
    if (await ollamaReachable()) {
      const data = await fetchJson<{ models?: Array<{ name: string; digest?: string; size?: number }> }>("http://127.0.0.1:11434/api/tags", undefined, 10000).catch(() => ({ models: [] as Array<{ name: string; digest?: string; size?: number }> }));
      for (const m of data.models || []) {
        const shortDigest = m.digest?.slice(0, 12) || "";
        const check = await checkOllamaModelUpdate(m.name, shortDigest);
        manifest.models[m.name] = {
          installedDigest: shortDigest,
          checkedAt: new Date().toISOString(),
          latestDigest: check.latestDigest,
          updateAvailable: check.updateAvailable,
          sizeBytes: m.size,
          snapshotDigest: manifest.models[m.name]?.snapshotDigest,
        };
        if (!states[m.name]) {
          states[m.name] = { name: m.name, lifecycle: "installed", installedDigest: shortDigest, sizeBytes: m.size };
        }
        if (check.updateAvailable) {
          states[m.name].lifecycle = "update-available";
          states[m.name].availableDigest = check.latestDigest;
        }
        results.push({ id: m.name, type: "model", name: m.name, installed: shortDigest, available: check.latestDigest, updateAvailable: check.updateAvailable });
      }
      await saveModelStates(states);
    }
  }
  manifest.schedule.lastFullCheckAt = new Date().toISOString();
  manifest.schedule.nextFullCheckAt = new Date(Date.now() + manifest.schedule.checkIntervalSeconds * 1000).toISOString();
  await saveManifest(manifest);
  const totalUpdates = results.filter((r) => r.updateAvailable).length;
  return res.json({ success: true, results, totalUpdates, checkedAt: manifest.generatedAt });
});

router.post("/updater/update", async (req, res) => {
  const { ids, type } = req.body;
  if (!ids?.length) return res.status(400).json({ success: false, message: "ids required" });
  const manifest = await loadManifest();
  const states = await loadModelStates();
  const launched: string[] = [];
  for (const id of ids) {
    const tool = manifest.systemTools[id];
    if (tool) {
      if (tool.wingetId) {
        exec(`${isWindows ? `start "Updating ${id}" cmd /k "` : ""}winget upgrade --id ${tool.wingetId} --silent --accept-package-agreements --accept-source-agreements${isWindows ? '"' : " &"}`);
        launched.push(id);
      } else if (tool.pipName) {
        exec(`${isWindows ? `start "Updating ${id}" cmd /k "` : ""}pip install --upgrade ${tool.pipName}${isWindows ? '"' : " &"}`);
        launched.push(id);
      }
    }
    const modelEntry = manifest.models[id];
    if (modelEntry && states[id]) {
      const snapshotId = modelEntry.installedDigest ? await snapshotModel(id, modelEntry.installedDigest) : undefined;
      if (snapshotId) {
        modelEntry.snapshotDigest = snapshotId;
        states[id].snapshotDigest = snapshotId;
        states[id].lifecycle = "updating";
      }
      exec(`ollama pull ${id}`);
      launched.push(id);
    }
  }
  await saveManifest(manifest);
  await saveModelStates(states);
  return res.json({ success: true, launched, message: `Update started for: ${launched.join(", ")}` });
});

router.post("/updater/rollback/:modelName", async (req, res) => {
  const modelName = decodeURIComponent(req.params.modelName);
  const manifest = await loadManifest();
  const states = await loadModelStates();
  const entry = manifest.models[modelName];
  const state = states[modelName];
  if (!entry?.snapshotDigest) return res.status(400).json({ success: false, message: "No snapshot available for rollback" });
  const snapFile = path.join(SNAPSHOTS_DIR, `${entry.snapshotDigest}.json`);
  if (!existsSync(snapFile)) return res.status(404).json({ success: false, message: "Snapshot file missing" });
  const snap = JSON.parse(await readFile(snapFile, "utf-8"));
  if (state) state.lifecycle = "rollback-available";
  await saveModelStates(states);
  return res.json({
    success: true,
    snapshotDigest: snap.digest,
    message: `Rollback snapshot found (digest: ${snap.digest}). To restore, re-pull the model with the specific tag or use: ollama pull ${modelName}`,
    rollbackCmd: `ollama pull ${modelName}`,
  });
});

router.get("/updater/model-states", async (_req, res) => {
  const states = await loadModelStates();
  if (await ollamaReachable()) {
    const running = await fetchJson<{ models?: Array<{ name: string }> }>("http://127.0.0.1:11434/api/ps", undefined, 5000).catch(() => ({ models: [] as Array<{ name: string }> }));
    const runningSet = new Set((running.models || []).map((m) => m.name));
    for (const [name, state] of Object.entries(states)) {
      if (runningSet.has(name) && (state as any).lifecycle !== "running") {
        (state as any).lifecycle = "running";
      } else if (!runningSet.has(name) && (state as any).lifecycle === "running") {
        (state as any).lifecycle = "stopped";
      }
    }
    await saveModelStates(states);
  }
  return res.json({ states });
});

router.patch("/updater/model-states/:modelName", async (req, res) => {
  const modelName = decodeURIComponent(req.params.modelName);
  const { lifecycle, lastError } = req.body;
  const states = await loadModelStates();
  if (!states[modelName]) states[modelName] = { name: modelName, lifecycle: "not-installed" };
  states[modelName].lifecycle = lifecycle;
  if (lastError) states[modelName].lastError = lastError;
  await saveModelStates(states);
  return res.json({ success: true, state: states[modelName] });
});

router.post("/updater/backup-settings", async (_req, res) => {
  const backupId = `backup-${Date.now()}`;
  const backupDir = path.join(SNAPSHOTS_DIR, backupId);
  await ensureDir(backupDir);
  const filesToBackup = [
    path.join(TOOLS_DIR, "config.json"),
    path.join(TOOLS_DIR, "model-roles.json"),
    path.join(TOOLS_DIR, "projects.json"),
    path.join(TOOLS_DIR, "integrations-state.json"),
    path.join(TOOLS_DIR, "updater-manifest.json"),
  ];
  const backed: string[] = [];
  for (const f of filesToBackup) {
    if (existsSync(f)) {
      await copyFile(f, path.join(backupDir, path.basename(f)));
      backed.push(path.basename(f));
    }
  }
  return res.json({ success: true, backupId, backupDir, files: backed });
});

router.get("/updater/schedule", async (_req, res) => {
  const manifest = await loadManifest();
  return res.json({ schedule: manifest.schedule });
});

router.put("/updater/schedule", async (req, res) => {
  const manifest = await loadManifest();
  manifest.schedule = { ...manifest.schedule, ...req.body };
  await saveManifest(manifest);
  return res.json({ success: true, schedule: manifest.schedule });
});

export default router;
