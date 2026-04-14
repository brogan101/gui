import { Router } from "express";
import path from "path";
import { readFile, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import os from "os";

const router = Router();
const HOME = os.homedir();

interface FsEntry {
  name: string; path: string; type: "file" | "directory"; size?: number; modified?: string;
}

async function listDir(dirPath: string): Promise<FsEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const out: FsEntry[] = [];
  for (const e of entries) {
    const fp = path.join(dirPath, e.name);
    try {
      const s = await stat(fp);
      out.push({ name: e.name, path: fp, type: e.isDirectory() ? "directory" : "file", size: e.isFile() ? s.size : undefined, modified: s.mtime.toISOString() });
    } catch { /* skip inaccessible */ }
  }
  return out;
}

router.get("/filebrowser/list", async (req, res) => {
  const dirPath = typeof req.query["path"] === "string" ? req.query["path"] as string : HOME;
  if (!existsSync(dirPath)) return res.status(404).json({ success: false, message: "Path not found" });
  try {
    return res.json({ success: true, path: dirPath, entries: await listDir(dirPath) });
  } catch (err) { return res.status(500).json({ success: false, message: (err as Error).message }); }
});

router.get("/filebrowser/read", async (req, res) => {
  const filePath = typeof req.query["path"] === "string" ? req.query["path"] as string : "";
  if (!filePath || !existsSync(filePath)) return res.status(404).json({ success: false, message: "File not found" });
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) return res.status(400).json({ success: false, message: "Path is a directory" });
    if (s.size > 10 * 1024 * 1024) return res.status(413).json({ success: false, message: "File too large (max 10 MB)" });
    const content = await readFile(filePath, "utf-8");
    return res.json({ success: true, path: filePath, content, size: s.size, modified: s.mtime.toISOString() });
  } catch (err) { return res.status(500).json({ success: false, message: (err as Error).message }); }
});

export default router;
