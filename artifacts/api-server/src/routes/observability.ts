import { Router } from "express";
import { thoughtLog, type ThoughtLevel, type ThoughtCategory } from "../lib/thought-log.js";

const router = Router();

const THOUGHT_LEVELS: ThoughtLevel[] = ["debug", "info", "warning", "error"];
const THOUGHT_CATEGORIES: ThoughtCategory[] = [
  "kernel",
  "queue",
  "rollback",
  "config",
  "chat",
  "workspace",
  "system",
];

router.get("/observability/thoughts", async (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query["limit"]) || 100, 500));
  return res.json({ entries: thoughtLog.history(limit) });
});

router.get("/observability/thoughts/stream", async (_req, res) => {
  thoughtLog.stream(res);
});

router.post("/observability/thoughts", async (req, res) => {
  const body =
    typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>)
      : {};
  const level =
    typeof body["level"] === "string" &&
    THOUGHT_LEVELS.includes(body["level"] as ThoughtLevel)
      ? (body["level"] as ThoughtLevel)
      : undefined;
  const category =
    typeof body["category"] === "string" &&
    THOUGHT_CATEGORIES.includes(body["category"] as ThoughtCategory)
      ? (body["category"] as ThoughtCategory)
      : undefined;
  const title = typeof body["title"] === "string" ? body["title"] : "";
  const message = typeof body["message"] === "string" ? body["message"] : "";
  const metadata =
    typeof body["metadata"] === "object" &&
    body["metadata"] !== null &&
    !Array.isArray(body["metadata"])
      ? (body["metadata"] as Record<string, unknown>)
      : undefined;

  if (!category || !title || !message) {
    return res
      .status(400)
      .json({ success: false, message: "category, title, and message are required" });
  }
  if (body["level"] !== undefined && level === undefined) {
    return res.status(400).json({
      success: false,
      message: `Invalid thought level: ${String(body["level"])}`,
    });
  }

  const entry = thoughtLog.publish({ level, category, title, message, metadata });
  return res.json({ success: true, entry });
});

export default router;
