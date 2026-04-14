import { Router } from "express";
import { exec } from "child_process";
import { promisify } from "util";

const router = Router();
const execAsync = promisify(exec);

interface ManagedItem {
  id: string; name: string; category: "winget" | "pip";
  wingetId?: string; pipName?: string; versionCmd: string;
}

const MANAGED_ITEMS: ManagedItem[] = [
  { id: "pwsh",   name: "PowerShell 7",     category: "winget", wingetId: "Microsoft.PowerShell",       versionCmd: "pwsh --version" },
  { id: "wt",     name: "Windows Terminal", category: "winget", wingetId: "Microsoft.WindowsTerminal",  versionCmd: "wt --version" },
  { id: "git",    name: "Git",              category: "winget", wingetId: "Git.Git",                    versionCmd: "git --version" },
  { id: "gh",     name: "GitHub CLI",       category: "winget", wingetId: "GitHub.cli",                 versionCmd: "gh --version" },
  { id: "python", name: "Python 3.12",      category: "winget", wingetId: "Python.Python.3.12",         versionCmd: "python --version" },
  { id: "node",   name: "Node.js LTS",      category: "winget", wingetId: "OpenJS.NodeJS.LTS",          versionCmd: "node --version" },
  { id: "dotnet", name: ".NET 9 SDK",       category: "winget", wingetId: "Microsoft.DotNet.SDK.9",     versionCmd: "dotnet --version" },
  { id: "code",   name: "VS Code",          category: "winget", wingetId: "Microsoft.VisualStudioCode", versionCmd: "code --version" },
  { id: "ollama", name: "Ollama",           category: "winget", wingetId: "Ollama.Ollama",              versionCmd: "ollama --version" },
  { id: "nvitop", name: "nvitop",           category: "pip",    pipName:  "nvitop",                     versionCmd: "nvitop --version" },
  { id: "aider",  name: "Aider",            category: "pip",    pipName:  "aider-chat",                 versionCmd: "aider --version" },
];

async function getVersion(cmd: string): Promise<string | undefined> {
  try { const { stdout } = await execAsync(cmd, { timeout: 5000 }); return stdout.trim().split("\n")[0]; }
  catch { return undefined; }
}

router.get("/system/updates/check", async (_req, res) => {
  const results = await Promise.all(MANAGED_ITEMS.map(async item => {
    const currentVersion = await getVersion(item.versionCmd);
    return {
      id: item.id, name: item.name, category: item.category,
      currentVersion, availableVersion: undefined, updateAvailable: false,
      status: !currentVersion ? "unknown" : "ok",
    };
  }));
  return res.json({ items: results, checkedAt: new Date().toISOString(), updatesAvailable: 0 });
});

router.post("/system/updates/run", async (req, res) => {
  const body      = typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
  const itemIds   = Array.isArray(body["itemIds"]) ? body["itemIds"] as string[] : [];
  const updateAll = body["updateAll"] === true;
  const toUpdate  = updateAll ? MANAGED_ITEMS : MANAGED_ITEMS.filter(i => itemIds.includes(i.id));
  const wingetIds = toUpdate.filter(i => i.category === "winget" && i.wingetId).map(i => i.wingetId!);
  const pipNames  = toUpdate.filter(i => i.category === "pip" && i.pipName).map(i => i.pipName!);
  const cmds: string[] = [];
  if (wingetIds.length > 0) cmds.push(`winget upgrade --id ${wingetIds.join(" --id ")} --silent --accept-package-agreements --accept-source-agreements`);
  if (pipNames.length  > 0) cmds.push(`python -m pip install --upgrade ${pipNames.join(" ")}`);
  if (cmds.length > 0) {
    exec(cmds.join(" && "), { timeout: 300000 });
    return res.json({ success: true, message: `Update started for ${toUpdate.map(i => i.name).join(", ")}. This may take several minutes.` });
  }
  return res.json({ success: false, message: "No updatable items selected" });
});

export default router;
