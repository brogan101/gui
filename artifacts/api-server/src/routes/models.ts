import { Router } from "express";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";
import { toolsRoot } from "../lib/runtime.js";
import {
  getUniversalGatewayTags,
  queueUniversalModelPull,
  routeModelForMessages,
  loadOllamaModel,
  unloadOllamaModel,
  deleteOllamaModel,
  getRunningGatewayModels,
  invalidateCatalogCache,
  getCatalogCacheAge,
} from "../lib/model-orchestrator.js";
import { stateOrchestrator } from "../lib/state-orchestrator.js";
import { discoverVerifiedModels, verifyOllamaModelSpec } from "../lib/model-discovery.js";
import { writeManagedJson } from "../lib/snapshot-manager.js";
import { taskQueue } from "../lib/task-queue.js";

const router = Router();
const TOOLS_DIR = toolsRoot();
const ROLES_FILE = path.join(TOOLS_DIR, "model-roles.json");
const MODEL_STATES_FILE = path.join(TOOLS_DIR, "model-states.json");
const UPDATER_MANIFEST_FILE = path.join(TOOLS_DIR, "updater-manifest.json");

const ROLE_DEFINITIONS = [
  { role: "primary-coding", label: "Primary Coding", description: "Main model for code generation and complex edits" },
  { role: "fast-coding", label: "Fast Coding", description: "Smaller/faster model for quick edits and completions" },
  { role: "autocomplete", label: "Autocomplete", description: "Inline tab-complete — smallest fastest model" },
  { role: "reasoning", label: "Reasoning / Debugging", description: "Deep thinking model for complex debugging" },
  { role: "embeddings", label: "Embeddings", description: "Semantic search and indexing" },
  { role: "chat", label: "Chat / Research", description: "General purpose chat and research" },
  { role: "vision", label: "Vision (optional)", description: "Multimodal model for image understanding" },
];

const POPULAR_MODELS = [
  { name: "qwen2.5-coder", tags: ["1.5b", "7b", "14b", "32b"], category: "coding", vramGb: [2, 6, 10, 20], description: "Qwen coding series — strong across all languages and file types", bestFor: "Code generation, debugging, code review", tier: "recommended" },
  { name: "qwen3-coder", tags: ["8b", "30b"], category: "coding", vramGb: [6, 20], description: "Next-gen Qwen coder with extended context window", bestFor: "Large codebase navigation, complex multi-file edits", tier: "recommended" },
  { name: "deepseek-coder-v2", tags: ["16b"], category: "coding", vramGb: [12], description: "DeepSeek Coder v2 — excellent benchmark scores across languages", bestFor: "Competitive coding, algorithm design", tier: "standard" },
  { name: "codellama", tags: ["7b", "13b", "34b"], category: "coding", vramGb: [6, 10, 24], description: "Meta CodeLlama — solid baseline, wide language support", bestFor: "General coding, infill/completion", tier: "standard" },
  { name: "starcoder2", tags: ["3b", "7b", "15b"], category: "coding", vramGb: [3, 6, 12], description: "HuggingFace StarCoder2 — trained on 600+ languages", bestFor: "Polyglot projects, rare languages", tier: "standard" },
  { name: "codegemma", tags: ["2b", "7b"], category: "coding", vramGb: [2, 6], description: "Google CodeGemma — fast and efficient for inline completion", bestFor: "Autocomplete, quick edits", tier: "fast" },
  { name: "qwen3", tags: ["1.5b", "8b", "14b", "30b", "32b"], category: "general", vramGb: [2, 6, 10, 20, 22], description: "Qwen3 — top-tier general purpose, strong reasoning and instruction following", bestFor: "Research, writing, analysis, complex Q&A", tier: "recommended" },
  { name: "qwen2.5", tags: ["1.5b", "7b", "14b", "32b"], category: "general", vramGb: [2, 6, 10, 22], description: "Qwen2.5 — reliable general purpose with broad knowledge", bestFor: "Chat, summarization, translation", tier: "standard" },
  { name: "llama3.1", tags: ["8b", "70b"], category: "general", vramGb: [6, 48], description: "Meta Llama 3.1 — strong instruction following", bestFor: "General tasks, writing, research", tier: "standard" },
  { name: "llama3.2", tags: ["1b", "3b"], category: "general", vramGb: [1, 3], description: "Meta Llama 3.2 — very small and fast, works on CPU", bestFor: "Quick answers, resource-constrained systems", tier: "fast" },
  { name: "mistral", tags: ["7b"], category: "general", vramGb: [6], description: "Mistral 7B — efficient and capable, great instruction following", bestFor: "General chat, writing", tier: "standard" },
  { name: "gemma3", tags: ["1b", "4b", "12b", "27b"], category: "general", vramGb: [1, 4, 10, 18], description: "Google Gemma 3 — Google's efficient open models, April 2026 flagship on-device", bestFor: "Fast responses, multimodal tasks (4b+)", tier: "recommended" },
  { name: "phi4", tags: ["14b"], category: "general", vramGb: [10], description: "Microsoft Phi-4 — punches above its weight class for reasoning", bestFor: "Logic, math, reasoning", tier: "standard" },
  { name: "phi3.5", tags: ["mini"], category: "general", vramGb: [3], description: "Microsoft Phi-3.5 mini — very fast, solid for simple tasks", bestFor: "Quick lookups, lightweight tasks", tier: "fast" },
  { name: "kimi-k2", tags: ["latest"], category: "general", vramGb: [16], description: "Kimi K2.5 — strong general knowledge and agentic workflows, viral 2026 competitor", bestFor: "General knowledge, complex agentic workflows", tier: "recommended" },
  { name: "liquid-lfm", tags: ["latest"], category: "general", vramGb: [4], description: "Liquid LFM 2.5 — fastest local model, >350 tokens/sec, instantaneous response", bestFor: "Real-time interaction, quick Q&A", tier: "fast", tokenEfficiency: "very-high" },
  { name: "deepseek-r1", tags: ["1.5b", "7b", "8b", "14b", "32b"], category: "reasoning", vramGb: [2, 6, 6, 10, 22], description: "DeepSeek R1 — smartest local model for logic/math, shows chain of thought", bestFor: "Mathematical problems, logical reasoning, step-by-step analysis", tier: "recommended" },
  { name: "qwq", tags: ["32b"], category: "reasoning", vramGb: [22], description: "QwQ 32B — strong reasoning model with extended thinking", bestFor: "Complex reasoning, research synthesis", tier: "standard" },
  { name: "qwen3-moe", tags: ["30b-a3b"], category: "reasoning", vramGb: [4], description: "Qwen3-30B-A3B — MoE architecture, 30B params but only activates 3B — very efficient", bestFor: "Complex reasoning at low VRAM cost", tier: "recommended", tokenEfficiency: "high" },
  { name: "dolphin3", tags: ["latest"], category: "uncensored", vramGb: [16], description: "Dolphin 3.0 (Mistral-24B) — uncensored, heavily fine-tuned, zero-refusal", bestFor: "Creative writing, roleplay, unrestricted dialogue", tier: "standard" },
  { name: "neural-daredevil", tags: ["8b"], category: "uncensored", vramGb: [6], description: "NeuralDaredevil-8B — Llama 4-based, prevents \"brain damage\" in uncensored finetunes", bestFor: "Balanced uncensored performance", tier: "standard" },
  { name: "glm4", tags: ["9b"], category: "uncensored", vramGb: [8], description: "GLM-4 — strong general model; abliterated variant available for unrestricted storytelling", bestFor: "Storytelling, narrative generation", tier: "standard" },
  { name: "nomic-embed-text", tags: ["latest"], category: "embedding", vramGb: [1], description: "Nomic embeddings — best for semantic search and RAG", bestFor: "Document search, RAG pipelines", tier: "recommended" },
  { name: "mxbai-embed-large", tags: ["latest"], category: "embedding", vramGb: [1], description: "MixedBread large embeddings — high quality vectors", bestFor: "High-quality semantic search", tier: "standard" },
  { name: "all-minilm", tags: ["latest"], category: "embedding", vramGb: [1], description: "All-MiniLM — tiny fast embeddings, CPU-friendly", bestFor: "Resource-constrained embedding tasks", tier: "fast" },
  { name: "llava", tags: ["7b", "13b"], category: "vision", vramGb: [6, 10], description: "LLaVA — multimodal vision+language, analyze images and answer questions", bestFor: "Image analysis, visual Q&A", tier: "standard" },
  { name: "llava-phi3", tags: ["latest"], category: "vision", vramGb: [4], description: "LLaVA Phi-3 — small and fast vision model", bestFor: "Quick image description, lightweight multimodal", tier: "fast" },
  { name: "moondream", tags: ["latest"], category: "vision", vramGb: [2], description: "Moondream — tiny 1.8B vision model, works on CPU", bestFor: "Basic image description, edge devices", tier: "fast" },
  { name: "minicpm-v", tags: ["latest"], category: "vision", vramGb: [4], description: "MiniCPM-V — efficient vision, strong on documents and charts", bestFor: "Document understanding, chart analysis", tier: "standard" },
  { name: "qwen2.5-vl", tags: ["7b", "32b"], category: "vision", vramGb: [6, 22], description: "Qwen2.5-VL — strong multimodal with video and image support", bestFor: "Advanced vision tasks, video understanding", tier: "recommended" },
];

async function loadRoles(): Promise<Record<string, string>> {
  try {
    if (!existsSync(ROLES_FILE)) return {};
    return JSON.parse(await readFile(ROLES_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function saveRoles(roles: Record<string, string>): Promise<void> {
  await writeManagedJson(ROLES_FILE, roles);
}

async function loadModelStateHints(): Promise<Record<string, any>> {
  try {
    if (!existsSync(MODEL_STATES_FILE)) return {};
    return JSON.parse(await readFile(MODEL_STATES_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function loadUpdaterManifestModels(): Promise<Record<string, any>> {
  try {
    if (!existsSync(UPDATER_MANIFEST_FILE)) return {};
    const manifest = JSON.parse(await readFile(UPDATER_MANIFEST_FILE, "utf-8"));
    return manifest.models || {};
  } catch {
    return {};
  }
}

function mapPullJobStatus(status: string): string {
  if (status === "running") return "pulling";
  if (status === "completed") return "complete";
  if (status === "failed") return "error";
  return status;
}

router.get("/tags", async (_req, res) => {
  return res.json(await getUniversalGatewayTags());
});

// POST /models/refresh — manual catalog sync (bypasses TTL cache)
router.post("/models/refresh", async (_req, res) => {
  try {
    invalidateCatalogCache();
    const gateway = await getUniversalGatewayTags(true);
    // Update sovereign state catalog metadata
    stateOrchestrator.setSovereignState({
      lastCatalogSync: new Date().toISOString(),
      catalogModelCount: gateway.models.length,
    });
    return res.json({
      success: true,
      message: `Catalog synced — ${gateway.models.length} model(s) found`,
      modelCount: gateway.models.length,
      ollamaReachable: gateway.ollamaReachable,
      syncedAt: new Date().toISOString(),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

// GET /models/catalog/status — cache and sync metadata
router.get("/models/catalog/status", (_req, res) => {
  const ageMs = getCatalogCacheAge();
  const sovereign = stateOrchestrator.getSovereignState();
  return res.json({
    cacheAgeMs: ageMs,
    isCached: ageMs !== null,
    lastCatalogSync: sovereign.lastCatalogSync,
    catalogModelCount: sovereign.catalogModelCount,
  });
});

router.post("/pull", async (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const modelName =
    typeof body.modelName === "string"
      ? body.modelName.trim()
      : typeof body.name === "string"
      ? body.name.trim()
      : "";
  if (!modelName) {
    return res.status(400).json({ success: false, message: "modelName required" });
  }
  const job = queueUniversalModelPull(modelName);
  return res.json({ success: true, message: `Pull queued: ${modelName}`, jobId: job.id, modelName });
});

router.get("/models/list", async (_req, res) => {
  const [gateway, roles, stateHints, updaterHints] = await Promise.all([
    getUniversalGatewayTags(),
    loadRoles(),
    loadModelStateHints(),
    loadUpdaterManifestModels(),
  ]);
  const invertedRoles: Record<string, string[]> = {};
  for (const [role, modelName] of Object.entries(roles)) {
    if (!modelName) continue;
    (invertedRoles[modelName] ||= []).push(role);
  }
  const models = gateway.models.map((model: any) => {
    const pullJob = taskQueue.listJobs().find(
      (job) =>
        job.type === "model-pull" &&
        String(job.metadata?.modelName || "") === model.name &&
        job.status !== "completed"
    );
    const lifecycle = pullJob
      ? mapPullJobStatus(pullJob.status)
      : stateHints[model.name]?.lifecycle === "broken"
      ? "broken"
      : updaterHints[model.name]?.updateAvailable
      ? "update-available"
      : model.isRunning
      ? "running"
      : "installed";
    return {
      name: model.name,
      size: model.size,
      sizeFormatted: model.sizeFormatted,
      modifiedAt: model.modifiedAt,
      digest: model.digest,
      parameterSize: model.parameterSize,
      quantizationLevel: model.quantizationLevel,
      isRunning: model.isRunning,
      assignedRole: invertedRoles[model.name]?.join(", "),
      vramWarning: model.estimatedRuntimeBytes > 20 * 1024 ** 3,
      sizeVram: model.sizeVram,
      sizeVramFormatted: model.sizeVramFormatted,
      lifecycle,
      updateAvailable: updaterHints[model.name]?.updateAvailable || false,
      lastError: stateHints[model.name]?.lastError,
      routeAffinity: model.routeAffinity,
      estimatedRuntimeFormatted: model.estimatedRuntimeFormatted,
    };
  });
  return res.json({
    models,
    ollamaReachable: gateway.ollamaReachable,
    totalSize: gateway.totalSize,
    totalSizeFormatted: gateway.totalSizeFormatted,
    totalRunningVram: gateway.totalRunningVram,
    totalRunningVramFormatted: gateway.totalRunningVramFormatted,
    vramGuard: gateway.vramGuard,
  });
});

router.get("/models/running", async (_req, res) => {
  return res.json(await getRunningGatewayModels());
});

router.get("/models/roles", async (_req, res) => {
  const [roles, gateway] = await Promise.all([loadRoles(), getUniversalGatewayTags()]);
  const installedSet = new Set(gateway.models.map((entry: any) => entry.name));
  return res.json({
    roles: ROLE_DEFINITIONS.map((definition) => ({
      role: definition.role,
      label: definition.label,
      description: definition.description,
      assignedModel: roles[definition.role] || "",
      isValid: !!roles[definition.role] && installedSet.has(roles[definition.role]),
      warning:
        roles[definition.role] && !installedSet.has(roles[definition.role])
          ? `Not installed: ${roles[definition.role]}`
          : undefined,
    })),
    installedModels: gateway.models.map((entry: any) => entry.name),
    popularModels: POPULAR_MODELS,
  });
});

router.put("/models/roles", async (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const rolesPayload = Array.isArray(body.roles) ? body.roles : [];
  const current = await loadRoles();
  for (const candidate of rolesPayload) {
    if (!candidate || typeof candidate !== "object") continue;
    const role = typeof candidate.role === "string" ? candidate.role : "";
    const model = typeof candidate.model === "string" ? candidate.model : "";
    if (!role) continue;
    current[role] = model === "unassigned" ? "" : model;
  }
  await saveRoles(current);
  const gateway = await getUniversalGatewayTags();
  const installedSet = new Set(gateway.models.map((entry: any) => entry.name));
  return res.json({
    roles: ROLE_DEFINITIONS.map((definition) => ({
      role: definition.role,
      assignedModel: current[definition.role] || "",
      isValid: !!current[definition.role] && installedSet.has(current[definition.role]),
    })),
  });
});

router.get("/models/catalog", async (_req, res) => {
  const gateway = await getUniversalGatewayTags();
  const installedNames = new Set(gateway.models.map((entry: any) => entry.name));
  return res.json({
    catalog: POPULAR_MODELS.map((entry) => ({
      ...entry,
      installedTags: entry.tags.filter((tag) => installedNames.has(`${entry.name}:${tag}`)),
    })),
  });
});

router.get("/models/discover", async (_req, res) => {
  const gateway = await getUniversalGatewayTags();
  const cards = await discoverVerifiedModels({
    installedModels: gateway.models.map((entry: any) => entry.name),
    limit: 6,
  }).catch(() => []);
  return res.json({ cards, discoveredAt: new Date().toISOString() });
});

router.get("/models/verify", async (req, res) => {
  const modelName = String(req.query.modelName || "").trim();
  if (!modelName) {
    return res.status(400).json({ success: false, message: "modelName query parameter required" });
  }
  const verification = await verifyOllamaModelSpec(modelName);
  return res.json({ success: verification.exists, verification });
});

router.post("/models/recommend", async (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return res.status(400).json({ success: false, message: "prompt required" });
  }
  const recommendation = await routeModelForMessages([{ role: "user", content: prompt }]).catch(() => null);
  const gateway = await getUniversalGatewayTags();
  return res.json({ recommendation, installed: gateway.models.map((entry: any) => entry.name) });
});

router.post("/models/pull", async (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const modelName = typeof body.modelName === "string" ? body.modelName.trim() : "";
  if (!modelName) {
    return res.status(400).json({ success: false, message: "modelName required" });
  }
  const job = queueUniversalModelPull(modelName);
  return res.json({ success: true, message: `Pull queued: ${modelName}`, jobId: job.id });
});

router.post("/models/verify-install", async (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const modelName = typeof body.modelName === "string" ? body.modelName.trim() : "";
  if (!modelName) {
    return res.status(400).json({ success: false, message: "modelName required" });
  }
  const verification = await verifyOllamaModelSpec(modelName);
  if (!verification.exists) {
    return res.status(404).json({
      success: false,
      message: `Could not verify ${modelName} in the Ollama registry.`,
      verification,
    });
  }
  const verifiedModelName = verification.spec;
  const job = queueUniversalModelPull(verifiedModelName);
  return res.json({
    success: true,
    message: `Verification passed. Pull queued: ${verifiedModelName}`,
    verification,
    jobId: job.id,
  });
});

router.post("/models/load", async (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const modelName = typeof body.modelName === "string" ? body.modelName.trim() : "";
  if (!modelName) {
    return res.status(400).json({ success: false, message: "modelName required" });
  }
  try {
    await loadOllamaModel(modelName);
    return res.json({ success: true, message: `${modelName} loaded into VRAM` });
  } catch (error) {
    return res.json({ success: false, message: error instanceof Error ? error.message : String(error) });
  }
});

router.post("/models/stop", async (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const modelName = typeof body.modelName === "string" ? body.modelName.trim() : "";
  if (!modelName) {
    return res.status(400).json({ success: false, message: "modelName required" });
  }
  try {
    await unloadOllamaModel(modelName);
    return res.json({ success: true, message: `${modelName} unloaded from VRAM` });
  } catch (error) {
    return res.json({ success: false, message: error instanceof Error ? error.message : String(error) });
  }
});

router.get("/models/pull-status", async (_req, res) => {
  const jobs = taskQueue
    .listJobs()
    .filter((job) => job.type === "model-pull")
    .map((job) => ({
      modelName: String(job.metadata?.modelName || job.name),
      status: mapPullJobStatus(job.status),
      progress: job.progress,
      message: job.message,
      startedAt: job.startedAt || job.createdAt,
      jobId: job.id,
    }));
  return res.json({
    jobs,
    hasActive: jobs.some((job) => job.status === "queued" || job.status === "pulling"),
  });
});

router.delete("/models/:modelName/delete", async (req, res) => {
  const modelName = decodeURIComponent(req.params.modelName);
  try {
    await deleteOllamaModel(modelName);
    return res.json({ success: true, message: `Deleted: ${modelName}` });
  } catch (error) {
    return res.json({
      success: false,
      message: `Failed to delete ${modelName}`,
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

export default router;
