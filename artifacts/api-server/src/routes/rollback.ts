import { Router } from "express";
import {
  getBackupMetadata,
  listBackupMetadata,
  rollbackFile,
} from "../lib/snapshot-manager.js";

const router = Router();

router.get("/rollback/backup", async (req, res) => {
  const filePath = String(req.query["filePath"] || "").trim();
  if (!filePath) {
    return res
      .status(400)
      .json({ success: false, message: "filePath query parameter required" });
  }
  return res.json({ backup: await getBackupMetadata(filePath) });
});

router.get("/rollback/backups", async (req, res) => {
  const directoryPath = String(req.query["directoryPath"] || "").trim();
  if (!directoryPath) {
    return res
      .status(400)
      .json({ success: false, message: "directoryPath query parameter required" });
  }
  return res.json({ backups: await listBackupMetadata(directoryPath) });
});

router.post("/rollback", async (req, res) => {
  const body =
    typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>)
      : {};
  const filePath =
    typeof body["filePath"] === "string" ? body["filePath"].trim() : "";
  if (!filePath) {
    return res.status(400).json({ success: false, message: "filePath required" });
  }
  const backup = await rollbackFile(filePath);
  return res.json({ success: true, backup });
});

export default router;
