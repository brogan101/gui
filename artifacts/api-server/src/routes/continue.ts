import { Router } from "express";
import { readFile, mkdir, readdir, stat, unlink } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import os from "os";
import { writeManagedFile } from "../lib/snapshot-manager.js";

const router = Router();
const HOME = os.homedir();
const CONTINUE_DIR = path.join(HOME, ".continue");
const RULES_DIR = path.join(CONTINUE_DIR, "rules");
const CONFIG_FILE = path.join(CONTINUE_DIR, "config.json");

router.get("/continue/config", async (req, res) => {
  if (!existsSync(CONFIG_FILE)) {
    return res.json({
      configExists: false,
      configPath: CONFIG_FILE,
      rawConfig: null,
      models: [],
      rulesDir: RULES_DIR,
    });
  }
  try {
    const rawConfig = await readFile(CONFIG_FILE, "utf-8");
    let models: any[] = [];
    try {
      const parsed = JSON.parse(rawConfig);
      models = (parsed.models || []).map((m: any) => ({
        title: m.title || m.model,
        provider: m.provider,
        model: m.model,
      }));
    } catch {}
    return res.json({
      configExists: true,
      configPath: CONFIG_FILE,
      rawConfig,
      models,
      rulesDir: RULES_DIR,
    });
  } catch (err) {
    (req as any).log?.error(err);
    return res.json({ configExists: false, configPath: CONFIG_FILE, models: [], rulesDir: RULES_DIR });
  }
});

router.get("/continue/rules", async (req, res) => {
  if (!existsSync(RULES_DIR)) {
    return res.json({ rules: [], rulesDir: RULES_DIR, count: 0 });
  }
  try {
    const files = await readdir(RULES_DIR);
    const mdFiles = files.filter((f) => f.endsWith(".md") || f.endsWith(".txt"));
    const rules = await Promise.all(
      mdFiles.map(async (filename) => {
        const filePath = path.join(RULES_DIR, filename);
        const content = await readFile(filePath, "utf-8");
        const stats = await stat(filePath);
        return {
          filename,
          content,
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        };
      })
    );
    return res.json({ rules, rulesDir: RULES_DIR, count: rules.length });
  } catch (err) {
    (req as any).log?.error(err);
    return res.json({ rules: [], rulesDir: RULES_DIR, count: 0 });
  }
});

router.post("/continue/rules", async (req, res) => {
  const { filename, content } = req.body;
  if (!filename || content === undefined) {
    return res.status(400).json({ success: false, message: "filename and content are required" });
  }
  try {
    if (!existsSync(RULES_DIR)) {
      await mkdir(RULES_DIR, { recursive: true });
    }
    const safeName = path.basename(filename);
    if (!safeName.endsWith(".md") && !safeName.endsWith(".txt")) {
      return res.status(400).json({ success: false, message: "Filename must end with .md or .txt" });
    }
    await writeManagedFile(path.join(RULES_DIR, safeName), content);
    return res.json({ success: true, message: `Rule '${safeName}' saved` });
  } catch (err) {
    const error = err as Error;
    return res.json({ success: false, message: "Failed to save rule", details: error.message });
  }
});

router.delete("/continue/rules/:filename", async (req, res) => {
  const { filename } = req.params;
  const safeName = path.basename(filename);
  const filePath = path.join(RULES_DIR, safeName);
  if (!existsSync(filePath)) {
    return res.status(404).json({ success: false, message: "Rule file not found" });
  }
  try {
    await unlink(filePath);
    return res.json({ success: true, message: `Rule '${safeName}' deleted` });
  } catch (err) {
    const error = err as Error;
    return res.json({ success: false, message: "Failed to delete rule", details: error.message });
  }
});

export default router;
