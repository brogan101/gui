import { Router } from "express";
import { taskQueue } from "../lib/task-queue.js";

const router = Router();

router.get("/tasks", async (_req, res) => {
  return res.json({ jobs: taskQueue.listJobs() });
});

router.get("/tasks/:jobId", async (req, res) => {
  const job = taskQueue.getJob(req.params["jobId"]!);
  if (!job) {
    return res.status(404).json({ success: false, message: "Job not found" });
  }
  return res.json({ job });
});

export default router;
