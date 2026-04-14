import { Router } from "express";
import { workspaceContextService } from "../lib/code-context.js";

const router = Router();

router.get("/context/status", async (_req, res) => {
  const status = await workspaceContextService.getStatus();
  return res.json(status);
});

router.get("/context/workspaces", async (_req, res) => {
  const workspaces = await workspaceContextService.getWorkspaceSummaries();
  return res.json({ workspaces });
});

router.post("/context/index", async (req, res) => {
  const { workspacePath, force } = req.body;
  try {
    if (workspacePath) {
      const index = await workspaceContextService.indexWorkspace(workspacePath, !!force);
      return res.json({ success: true, workspace: index.rootPath, fileCount: index.fileCount, symbolCount: index.symbolCount });
    }
    const workspaces = await workspaceContextService.refreshKnownWorkspaces("manual");
    return res.json({ success: true, workspaces });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/context/search", async (req, res) => {
  const { query, workspacePath, maxFiles, maxChars } = req.body;
  if (!query?.trim()) {
    return res.status(400).json({ success: false, message: "query required" });
  }
  try {
    const result = await workspaceContextService.search(query, workspacePath, maxFiles, maxChars);
    return res.json({ success: true, ...result });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.get("/context/file", async (req, res) => {
  const filePath = String(req.query.path || "");
  const workspacePath = req.query.workspacePath ? String(req.query.workspacePath) : undefined;
  if (!filePath) {
    return res.status(400).json({ success: false, message: "path query parameter required" });
  }
  try {
    const result = await workspaceContextService.readWorkspaceFile(filePath, workspacePath);
    return res.json({ success: true, ...result });
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/context/read-write-verify", async (req, res) => {
  const { filePath, updatedContent, workspacePath } = req.body;
  if (!filePath || typeof updatedContent !== "string") {
    return res.status(400).json({ success: false, message: "filePath and updatedContent are required" });
  }
  try {
    const result = await workspaceContextService.applyReadWriteVerify(filePath, updatedContent, workspacePath);
    return res.status(result.success ? 200 : 400).json(result);
  } catch (error: any) {
    return res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
