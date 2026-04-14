/**
 * LOCALAI CONTROL CENTER — API CLIENT
 * =====================================
 * Typed wrappers around every backend endpoint.
 * All requests are relative to /api so Vite's proxy works in dev
 * and the production build serves both from the same origin.
 */

const BASE = "/api";

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const get  = <T>(path: string)                   => req<T>("GET",    path);
const post = <T>(path: string, body?: unknown)   => req<T>("POST",   path, body);
const put  = <T>(path: string, body?: unknown)   => req<T>("PUT",    path, body);
const del  = <T>(path: string, body?: unknown)   => req<T>("DELETE", path, body);

// ── Types (mirroring backend) ─────────────────────────────────────────────────

export interface GatewayModel {
  name: string;
  size: number;
  sizeFormatted: string;
  estimatedRuntimeBytes: number;
  estimatedRuntimeFormatted: string;
  modifiedAt: string;
  digest: string;
  parameterSize?: string;
  quantizationLevel?: string;
  isRunning: boolean;
  sizeVram: number;
  sizeVramFormatted: string;
  assignedRole?: string;
  routeAffinity: "code" | "vision" | "general";
  runtimeClass: "tiny" | "small" | "medium" | "large";
}

export interface VramGuard {
  mode: "nvidia-smi" | "safe-mode";
  status: "healthy" | "degraded";
  provider: string;
  reason: string;
  gpuName?: string;
  totalBytes?: number;
  freeBytes?: number;
  safeBudgetBytes: number;
  reserveBytes: number;
  detectedAt: string;
}

export interface GatewayTagsResult {
  models: GatewayModel[];
  ollamaReachable: boolean;
  totalSize: number;
  totalSizeFormatted: string;
  totalRunningVram: number;
  totalRunningVramFormatted: string;
  vramGuard: VramGuard;
}

export interface SovereignState {
  activeGoal?: string;
  activeStep: number;
  totalSteps: number;
  executionPlan: string[];
  taskCategory?: "coding" | "sysadmin" | "hardware" | "general";
  lastCatalogSync?: string;
  catalogModelCount: number;
}

export interface CapabilityState {
  id: string;
  enabled: boolean;
  active: boolean;
  phase: string;
  detail?: string;
  assignedJobId?: string;
  lastUpdatedAt: string;
}

export interface KernelState {
  activeCapability?: string;
  lastUpdatedAt: string;
  capabilities: Record<string, CapabilityState>;
  sovereign: SovereignState;
}

export interface ThoughtEntry {
  id: string;
  timestamp: string;
  level: "debug" | "info" | "warning" | "error";
  category: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface AsyncJob {
  id: string;
  name: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  capability?: string;
  message: string;
  error?: string;
  result?: unknown;
  metadata?: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface SupervisorInfo {
  category: string;
  agentName: string;
  goal: string;
  steps: string[];
  confidence: number;
  manualOverride: boolean;
  toolset: string;
}

export interface ChatSendResult {
  success: boolean;
  model: string;
  route: unknown;
  message: ChatMessage;
  sessionId?: string;
  context: unknown;
  supervisor: SupervisorInfo;
}

export interface ModelListItem {
  name: string;
  size: number;
  sizeFormatted: string;
  modifiedAt: string;
  digest: string;
  parameterSize?: string;
  quantizationLevel?: string;
  isRunning: boolean;
  assignedRole?: string;
  vramWarning: boolean;
  sizeVram: number;
  sizeVramFormatted: string;
  lifecycle: string;
  updateAvailable: boolean;
  lastError?: string;
  routeAffinity: string;
  estimatedRuntimeFormatted: string;
}

export interface HeartbeatStatus {
  state: "local" | "online" | "degraded" | "offline";
  mode: string;
  provider: string;
  targetBaseUrl: string;
  authEnabled: boolean;
  connectedRemotely: boolean;
  latencyMs?: number;
  lastCheckedAt?: string;
  message: string;
}

export interface DiagnosticItem {
  category: string;
  label: string;
  status: "ok" | "warning" | "error" | "unknown";
  value: string;
  details?: string;
}

// ── Health ────────────────────────────────────────────────────────────────────

export const health = {
  ping: () => get<{ status: string }>("/healthz"),
};

// ── Kernel / State ────────────────────────────────────────────────────────────

export const kernel = {
  getState:   () => get<{ state: KernelState }>("/kernel/state"),
  setCapability: (id: string, body: Partial<CapabilityState>) =>
    put<{ success: boolean; state: KernelState }>(`/kernel/capabilities/${encodeURIComponent(id)}`, body),
};

// ── Models ────────────────────────────────────────────────────────────────────

export const models = {
  tags:          () => get<GatewayTagsResult>("/tags"),
  list:          () => get<{ models: ModelListItem[]; ollamaReachable: boolean; vramGuard: VramGuard; totalSizeFormatted: string }>("/models/list"),
  running:       () => get<{ models: Array<{ name: string; sizeVram: number; sizeVramFormatted: string }>; ollamaReachable: boolean; totalVramFormatted: string }>("/models/running"),
  refresh:       () => post<{ success: boolean; message: string; modelCount: number; syncedAt: string }>("/models/refresh"),
  catalogStatus: () => get<{ cacheAgeMs: number | null; isCached: boolean; lastCatalogSync?: string; catalogModelCount: number }>("/models/catalog/status"),
  pull:          (modelName: string) => post<{ success: boolean; jobId: string }>("/models/pull", { modelName }),
  load:          (modelName: string) => post<{ success: boolean; message: string }>("/models/load", { modelName }),
  stop:          (modelName: string) => post<{ success: boolean; message: string }>("/models/stop", { modelName }),
  delete:        (modelName: string) => del<{ success: boolean; message: string }>(`/models/${encodeURIComponent(modelName)}/delete`),
  pullStatus:    () => get<{ jobs: Array<{ modelName: string; status: string; progress: number; message: string; jobId: string }> }>("/models/pull-status"),
  roles:         () => get<{ roles: Array<{ role: string; label: string; description: string; assignedModel: string; isValid: boolean; warning?: string }>; installedModels: string[]; popularModels: unknown[] }>("/models/roles"),
  setRoles:      (roles: Array<{ role: string; model: string }>) => put("/models/roles", { roles }),
  catalog:       () => get<{ catalog: unknown[] }>("/models/catalog"),
};

// ── Chat ──────────────────────────────────────────────────────────────────────

export const chat = {
  send: (messages: ChatMessage[], model?: string, sessionId?: string, workspacePath?: string, useCodeContext?: boolean) =>
    post<ChatSendResult>("/chat/send", { messages, model, sessionId, workspacePath, useCodeContext }),

  assistant: (prompt: string, context?: string, workspacePath?: string) =>
    post<{ success: boolean; result: string; model: string; route: unknown }>("/chat/assistant", { prompt, context, workspacePath }),

  command: (command: string) =>
    post<{ success: boolean; action?: string; message: string }>("/chat/command", { command }),

  chatModels: () =>
    get<{ models: Array<{ name: string; paramSize?: string }>; ollamaReachable: boolean; vramGuard: VramGuard }>("/chat/models"),

  /** Open a streaming SSE connection for chat. Returns an EventSource. */
  stream: (messages: ChatMessage[], model?: string, workspacePath?: string, useCodeContext?: boolean) => {
    const body = JSON.stringify({ messages, model, workspacePath, useCodeContext });
    return fetch(`${BASE}/chat/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  },
};

// ── Observability ─────────────────────────────────────────────────────────────

export const observability = {
  thoughts:     (limit = 100) => get<{ entries: ThoughtEntry[] }>(`/observability/thoughts?limit=${limit}`),
  streamThoughts: () => new EventSource(`${BASE}/observability/thoughts/stream`),
};

// ── Tasks ─────────────────────────────────────────────────────────────────────

export const tasks = {
  list: () => get<{ jobs: AsyncJob[] }>("/tasks"),
  get:  (id: string) => get<{ job: AsyncJob }>(`/tasks/${encodeURIComponent(id)}`),
};

// ── System ────────────────────────────────────────────────────────────────────

export const system = {
  diagnostics:  () => get<{ items: DiagnosticItem[]; generatedAt: string; recommendations: string[] }>("/system/diagnostics"),
  heartbeat:    () => get<HeartbeatStatus>("/remote/heartbeat"),  // alias at /remote/heartbeat → /remote/network/status
  killSwitch:   () => post<{ success: boolean; message: string }>("/system/process/kill-switch"),
  cleanupScan:  () => get<{ artifacts: unknown[]; totalFound: number; spaceSavable: string }>("/system/cleanup/scan"),
  cleanupRun:   (artifactIds: string[]) => post<{ success: boolean; message: string; removedPaths: string[] }>("/system/cleanup/execute", { artifactIds }),
  activity:     () => get<{ entries: unknown[] }>("/system/activity"),
  restart:      (reason?: string) => post<{ success: boolean; message: string }>("/system/sovereign/restart", { reason }),
  sovereignEdit: (filePath: string, newContent: string) =>
    post<{ success: boolean; filePath: string; diff: string; message: string }>("/system/sovereign/edit", { filePath, newContent }),
  sovereignPreview: (filePath: string, newContent: string) =>
    post<{ success: boolean; proposal: { filePath: string; diff: string } }>("/system/sovereign/preview", { filePath, newContent }),
  macros:       () => get<{ macros: unknown[] }>("/system/macros"),
  runMacro:     (name: string) => post<{ success: boolean; stepsExecuted: number; error?: string }>(`/system/macros/${encodeURIComponent(name)}/run`),
  windows:      (pattern?: string) => get<{ windows: unknown[] }>(`/system/windows${pattern ? `?pattern=${encodeURIComponent(pattern)}` : ""}`),
};

// ── Workspace ─────────────────────────────────────────────────────────────────

export const workspace = {
  projects:    () => get<{ projects: unknown[]; recentCount: number; pinnedCount: number }>("/workspace/projects"),
  readiness:   () => get<{ overallStatus: string; items: unknown[]; recommendations: string[] }>("/workspace/readiness"),
  templates:   () => get<{ templates: unknown[] }>("/workspace/templates"),
};

// ── Studio pipeline types ─────────────────────────────────────────────────────

export interface CadScriptResult {
  type: "openscad" | "blender" | "gcode";
  script: string;
  description: string;
  savedPath?: string;
  generatedAt: string;
  model: string;
}

export interface GCodeOptimizeResult {
  originalLineCount: number;
  optimizedLineCount: number;
  optimizedGCode: string;
  changes: string[];
  savedPath?: string;
  optimizedAt: string;
}

export interface ImageGenStatus {
  comfyuiReachable: boolean;
  sdWebuiReachable: boolean;
  preferredBackend: "comfyui" | "sdwebui" | "none";
}

export interface PromptArchitectResult {
  originalPrompt: string;
  expandedPrompt: string;
  negativePrompt: string;
  style: string;
  model: string;
  expandedAt: string;
}

export interface ImageGenResult {
  success: boolean;
  backend: "comfyui" | "sdwebui";
  promptId?: string;
  images: string[];
  savedPaths: string[];
  prompt: string;
  expandedPrompt?: string;
  generatedAt: string;
  error?: string;
}

export interface VibeCodingTestResult {
  success: boolean;
  status?: number;
  body?: string;
  error?: string;
  endpointUrl: string;
  testedAt: string;
}

// ── Studios ───────────────────────────────────────────────────────────────────

export const studios = {
  templates:    () => get<{ templates: unknown[] }>("/studios/templates"),
  catalog:      () => get<{ workspaces: unknown[]; parameterBlocks: unknown[] }>("/studios/catalog"),
  plan:         (brief: string, templateId?: string) =>
    post<{ success: boolean; plan: unknown; generatedBy: string }>("/studios/plan", { brief, templateId }),
  build:        (name: string, brief: string, templateId: string, aiPlan?: unknown) =>
    post<{ success: boolean; jobId: string; studioPath: string }>("/studios/build", { name, brief, templateId, aiPlan }),
  buildStatus:  (jobId: string) =>
    get<{ success: boolean; job: unknown }>(`/studios/build/${encodeURIComponent(jobId)}`),
  integrations: () => get<{ repos: unknown[] }>("/studios/integrations"),

  // ── Vibe Coding ────────────────────────────────────────────────────────────
  vibeCheck: (studioPath: string, port?: number, endpointPath?: string, startCommand?: string) =>
    post<{ success: boolean; result: VibeCodingTestResult }>("/studios/vibecheck", {
      studioPath, port, endpointPath, startCommand,
    }),

  // ── CAD / Hardware ─────────────────────────────────────────────────────────
  cad: {
    openscad: (description: string, save = true) =>
      post<{ success: boolean; result: CadScriptResult }>("/studios/cad/openscad", { description, save }),
    blender: (description: string, save = true) =>
      post<{ success: boolean; result: CadScriptResult }>("/studios/cad/blender", { description, save }),
    gcode: (gcode: string, printerType: "fdm" | "laser" = "fdm", save = true) =>
      post<{ success: boolean; result: GCodeOptimizeResult }>("/studios/cad/gcode", { gcode, printerType, save }),
  },

  // ── Image Generation ───────────────────────────────────────────────────────
  imagegen: {
    status: () => get<ImageGenStatus>("/studios/imagegen/status"),
    expandPrompt: (prompt: string, style?: PromptArchitectResult["style"]) =>
      post<{ success: boolean; result: PromptArchitectResult }>("/studios/imagegen/expand-prompt", { prompt, style }),
    generate: (
      prompt: string,
      options?: {
        expandPrompt?: boolean;
        style?: PromptArchitectResult["style"];
        steps?: number;
        cfgScale?: number;
        width?: number;
        height?: number;
        seed?: number;
        saveImages?: boolean;
      },
    ) => post<{ success: boolean; result: ImageGenResult }>("/studios/imagegen/generate", { prompt, ...options }),
  },
};

export default { health, kernel, models, chat, observability, tasks, system, workspace, studios };
