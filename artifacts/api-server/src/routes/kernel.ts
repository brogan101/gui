import { Router } from "express";
import { stateOrchestrator } from "../lib/state-orchestrator.js";
import { CAPABILITY_IDS, CAPABILITY_PHASES, type CapabilityPhase } from "../lib/secure-config.js";

const router = Router();

router.get("/kernel/state", async (_req, res) => {
  return res.json({ state: await stateOrchestrator.getState() });
});

router.put("/kernel/capabilities/:capabilityId", async (req, res) => {
  const { capabilityId } = req.params;
  if (!capabilityId || !(CAPABILITY_IDS as readonly string[]).includes(capabilityId)) {
    return res
      .status(400)
      .json({ success: false, message: `Unknown capability: ${req.params["capabilityId"]}` });
  }
  const body =
    typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>)
      : {};
  const active =
    typeof body["active"] === "boolean" ? body["active"] : undefined;
  const enabled =
    typeof body["enabled"] === "boolean" ? body["enabled"] : undefined;
  const phase =
    typeof body["phase"] === "string" &&
    (CAPABILITY_PHASES as readonly string[]).includes(body["phase"])
      ? (body["phase"] as CapabilityPhase)
      : undefined;
  const detail =
    typeof body["detail"] === "string" ? body["detail"] : undefined;
  const assignedJobId =
    typeof body["assignedJobId"] === "string"
      ? body["assignedJobId"]
      : undefined;

  if (body["phase"] !== undefined && phase === undefined) {
    return res.status(400).json({
      success: false,
      message: `Invalid capability phase: ${String(body["phase"])}`,
    });
  }

  const state = await stateOrchestrator.setCapability(capabilityId, {
    active,
    enabled,
    phase,
    detail,
    assignedJobId,
  });
  return res.json({ success: true, state });
});

export default router;
