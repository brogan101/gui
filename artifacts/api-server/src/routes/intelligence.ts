import { Router } from "express";
import {
  createRefactorPlan,
  executeRefactorPlan,
  getRefactorPlan,
  getRefactorJob,
  listRefactorJobs,
} from "../lib/global-workspace-intelligence.js";

const router = Router();

router.post("/intelligence/refactors/plan", async (req, res) => {
  const body          = typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
  const request       = typeof body["request"]       === "string" ? (body["request"] as string).trim()       : "";
  const workspacePath = typeof body["workspacePath"] === "string" ? (body["workspacePath"] as string).trim() : undefined;
  if (!request) return res.status(400).json({ success: false, message: "request is required" });
  try {
    const plan = await createRefactorPlan(request, workspacePath);
    return res.json({ success: true, plan });
  } catch (err) { return res.status(400).json({ success: false, message: (err as Error).message }); }
});

router.get("/intelligence/refactors/plan/:planId", (req, res) => {
  const plan = getRefactorPlan(req.params["planId"]!);
  if (!plan) return res.status(404).json({ success: false, message: "Plan not found" });
  return res.json({ success: true, plan });
});

router.post("/intelligence/refactors/:planId/execute", async (req, res) => {
  const body  = typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
  const model = typeof body["model"] === "string" ? (body["model"] as string).trim() : undefined;
  try {
    const job = await executeRefactorPlan(req.params["planId"]!, model);
    return res.json({ success: true, job });
  } catch (err) { return res.status(400).json({ success: false, message: (err as Error).message }); }
});

router.get("/intelligence/refactors/jobs", (_req, res) => res.json({ success: true, jobs: listRefactorJobs() }));

router.get("/intelligence/refactors/jobs/:jobId", (req, res) => {
  const job = getRefactorJob(req.params["jobId"]!);
  if (!job) return res.status(404).json({ success: false, message: "Job not found" });
  return res.json({ success: true, job });
});

export default router;
