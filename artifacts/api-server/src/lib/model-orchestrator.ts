/**
 * MODEL ORCHESTRATOR — VRAM Guard + Supervisor-Aware Dynamic Router
 * ==================================================================
 * This is a sovereign file. Do NOT simplify, refactor, or delete this logic.
 * The VRAM Guard and Dynamic Routing are core value of the project.
 *
 * New in this revision:
 *   RoutingHint — lets the Supervisor Agent pre-classify intent so the
 *   orchestrator never duplicates the inference work.  When a hint is
 *   provided, `routeModelForMessages()` skips message scanning and uses
 *   the supervisor's already-computed intent + suggested model.
 */

import { exec } from "child_process";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import type { Response } from "express";
import {
  toolsRoot, fetchJson,
} from "./runtime.js";
import { logger } from "./logger.js";
import { thoughtLog } from "./thought-log.js";
import { taskQueue } from "./task-queue.js";
import { writeManagedJson } from "./snapshot-manager.js";
import {
  getActiveGatewayBaseUrl, buildDistributedProxyHeaders,
  getDistributedNodeConfig, getStreamingBufferProfile,
  LatencyOptimizedTokenBuffer,
} from "./network-proxy.js";

const execAsync = promisify(exec);

const MODEL_ROLES_FILE   = path.join(toolsRoot(), "model-roles.json");
const GATEWAY_STATE_FILE = path.join(toolsRoot(), "model-gateway.json");

// ── Catalog cache ─────────────────────────────────────────────────────────────
// Avoids hammering Ollama on every request. TTL: 30 s.

const CATALOG_CACHE_TTL_MS = 30_000;

interface CatalogCache {
  result: GatewayTagsResult;
  cachedAt: number;
}

let catalogCache: CatalogCache | null = null;

export function invalidateCatalogCache(): void {
  catalogCache = null;
}

export function getCatalogCacheAge(): number | null {
  return catalogCache ? Date.now() - catalogCache.cachedAt : null;
}

const SAFE_MODE_RESERVE_BYTES    = 1024 ** 3;
const SAFE_MODE_MIN_BUDGET_BYTES = 4 * 1024 ** 3;
const SAFE_MODE_MAX_BUDGET_BYTES = 8 * 1024 ** 3;
const HEALTHY_MODE_RESERVE_BYTES = 1536 * 1024 ** 2;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OllamaTag {
  name: string;
  size: number;
  modified_at: string;
  digest: string;
  details?: { parameter_size?: string; quantization_level?: string };
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

export interface GatewayTagsResult {
  models: GatewayModel[];
  ollamaReachable: boolean;
  totalSize: number;
  totalSizeFormatted: string;
  totalRunningVram: number;
  totalRunningVramFormatted: string;
  vramGuard: VramGuard;
}

export interface RouteDecision {
  intent: "code" | "vision" | "general";
  requestedModel?: string;
  selectedModel: string;
  selectedAffinity: string;
  switched: boolean;
  reason: string;
  admission: AdmissionResult;
}

interface AdmissionResult {
  allowed: boolean;
  mode: string;
  requiredBytes: number;
  availableBytes: number;
  reason: string;
}

/**
 * Hint from the Supervisor Agent — allows the orchestrator to skip
 * independent intent inference and reuse the supervisor's classification.
 */
export interface RoutingHint {
  /** Intent already classified by the Supervisor Agent. */
  supervisorIntent?: RouteDecision["intent"];
  /** Model already suggested by the Supervisor Agent — prepended to the
   *  candidate list before role-priority ordering. */
  supervisorSuggestedModel?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface StreamOptions {
  messages: ChatMessage[];
  requestedModel?: string;
  initialPayloads?: unknown[];
  /** Supervisor routing hint — skips independent intent inference. */
  routingHint?: RoutingHint;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024)      return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ── VRAM estimation ───────────────────────────────────────────────────────────

function parseParameterSizeToBytes(parameterSize?: string): number | undefined {
  if (!parameterSize) return undefined;
  const activeExpertMatch = parameterSize.match(/a(\d+(?:\.\d+)?)b/i);
  if (activeExpertMatch) return Math.round(Number(activeExpertMatch[1]) * 1024 ** 3);
  const match = parameterSize.match(/(\d+(?:\.\d+)?)\s*([bmk])/i);
  if (!match) return undefined;
  const value = Number(match[1]);
  const unit  = match[2].toLowerCase();
  if (unit === "b") return Math.round(value * 1024 ** 3);
  if (unit === "m") return Math.round(value * 1024 ** 2);
  return Math.round(value * 1024);
}

function quantizationMultiplier(quantizationLevel?: string): number {
  const normalized = (quantizationLevel ?? "").toLowerCase();
  if (!normalized)                                        return 1.2;
  if (normalized.includes("q2"))                         return 1.05;
  if (normalized.includes("q3"))                         return 1.1;
  if (normalized.includes("q4"))                         return 1.16;
  if (normalized.includes("q5"))                         return 1.22;
  if (normalized.includes("q6"))                         return 1.28;
  if (normalized.includes("q8"))                         return 1.38;
  if (normalized.includes("f16") || normalized.includes("fp16")) return 1.9;
  return 1.24;
}

function estimateRuntimeBytes(tag: OllamaTag): number {
  const sizeBytes      = tag.size ?? 0;
  const parameterBytes = parseParameterSizeToBytes(tag.details?.parameter_size);
  const baseBytes      = Math.max(sizeBytes, parameterBytes ?? 0);
  const quantized      = Math.round(baseBytes * quantizationMultiplier(tag.details?.quantization_level));
  return quantized + 768 * 1024 ** 2;
}

function classifyRuntimeSize(bytes: number): GatewayModel["runtimeClass"] {
  if (bytes <= 3  * 1024 ** 3) return "tiny";
  if (bytes <= 7  * 1024 ** 3) return "small";
  if (bytes <= 15 * 1024 ** 3) return "medium";
  return "large";
}

// ── Intent inference ──────────────────────────────────────────────────────────

function inferIntentFromModelName(modelName: string): GatewayModel["routeAffinity"] {
  const n = modelName.toLowerCase();
  if (n.includes("llava") || n.includes("-vl") || n.includes("vision") || n.includes("minicpm-v") || n.includes("moondream")) return "vision";
  if (n.includes("coder") || n.includes("codellama") || n.includes("codegemma") || n.includes("starcoder") || n.includes("deepseek")) return "code";
  return "general";
}

export function inferIntentFromMessages(messages: ChatMessage[]): RouteDecision["intent"] {
  const latestUser = [...messages].reverse().find(m => m.role === "user")?.content.toLowerCase() ?? "";
  if (/\b(image|photo|picture|screenshot|diagram|chart|vision|ocr|look at|analyze this image)\b/.test(latestUser)) return "vision";
  if (/```|`[^`]+`|\b(code|debug|fix|refactor|typescript|javascript|python|function|class|stack trace|compile|build error|sql|regex)\b/.test(latestUser)) return "code";
  return "general";
}

// ── Role assignments ──────────────────────────────────────────────────────────

export async function loadRoleAssignments(): Promise<Record<string, string>> {
  try {
    if (!existsSync(MODEL_ROLES_FILE)) return {};
    return JSON.parse(await readFile(MODEL_ROLES_FILE, "utf-8")) as Record<string, string>;
  } catch { return {}; }
}

async function loadGatewayState(): Promise<Record<string, unknown>> {
  try {
    if (!existsSync(GATEWAY_STATE_FILE)) return { updatedAt: new Date().toISOString() };
    return JSON.parse(await readFile(GATEWAY_STATE_FILE, "utf-8")) as Record<string, unknown>;
  } catch { return { updatedAt: new Date().toISOString() }; }
}

async function saveGatewayState(
  mutator: (c: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const current = await loadGatewayState();
  const normalized = { ...current, ...mutator(current), updatedAt: new Date().toISOString() };
  await writeManagedJson(GATEWAY_STATE_FILE, normalized);
  return normalized;
}

// ── Distributed fetch ─────────────────────────────────────────────────────────

function mergeHeaders(left?: RequestInit["headers"], right?: RequestInit["headers"]): Headers {
  const h = new Headers(left ?? {});
  new Headers(right ?? {}).forEach((v, k) => h.set(k, v));
  return h;
}

export async function distributedFetchJson<T = unknown>(
  relativePath: string, init?: RequestInit, timeoutMs?: number,
): Promise<T> {
  const [baseUrl, proxyHeaders, networkConfig] = await Promise.all([
    getActiveGatewayBaseUrl(), buildDistributedProxyHeaders(), getDistributedNodeConfig(),
  ]);
  return fetchJson<T>(
    `${baseUrl}${relativePath}`,
    { ...init, headers: mergeHeaders(proxyHeaders, init?.headers) },
    timeoutMs ?? networkConfig.remoteRequestTimeoutMs,
  );
}

async function distributedFetch(
  relativePath: string, init?: RequestInit, timeoutMs?: number,
): Promise<globalThis.Response> {
  const [baseUrl, proxyHeaders, networkConfig] = await Promise.all([
    getActiveGatewayBaseUrl(), buildDistributedProxyHeaders(), getDistributedNodeConfig(),
  ]);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? networkConfig.remoteRequestTimeoutMs);
  try {
    return await fetch(`${baseUrl}${relativePath}`, {
      ...init,
      headers: mergeHeaders(proxyHeaders, init?.headers),
      signal: controller.signal,
    });
  } finally { clearTimeout(timeout); }
}

// ── NVIDIA VRAM guard ─────────────────────────────────────────────────────────

export async function probeNvidiaVram(): Promise<VramGuard> {
  const detectedAt = new Date().toISOString();
  try {
    const { stdout, stderr } = await execAsync(
      "nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits",
      { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
    const candidates = output.split(/\r?\n/).map(row => {
      const [name, total, free] = row.split(",").map(v => v.trim());
      return { gpuName: name, totalBytes: Number(total) * 1024 ** 2, freeBytes: Number(free) * 1024 ** 2 };
    }).filter(e => Number.isFinite(e.totalBytes) && e.totalBytes > 0)
      .sort((a, b) => b.totalBytes - a.totalBytes);
    const primary = candidates[0];
    if (!primary) throw new Error(`nvidia-smi returned no usable GPU rows${output ? `: ${output}` : ""}`);
    return {
      mode: "nvidia-smi", status: "healthy", provider: "nvidia",
      reason: "Using live GPU telemetry from nvidia-smi",
      gpuName: primary.gpuName, totalBytes: primary.totalBytes, freeBytes: primary.freeBytes,
      safeBudgetBytes: Math.max(0, primary.freeBytes - HEALTHY_MODE_RESERVE_BYTES),
      reserveBytes: HEALTHY_MODE_RESERVE_BYTES, detectedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const safeBudgetBytes = clamp(Math.round(os.totalmem() * 0.2), SAFE_MODE_MIN_BUDGET_BYTES, SAFE_MODE_MAX_BUDGET_BYTES);
    const reason = message.includes("Unknown Error")
      ? 'NVML returned "Unknown Error"; switching VRAM guard to conservative safe mode'
      : `nvidia-smi unavailable; switching VRAM guard to conservative safe mode (${message})`;
    logger.warn({ err: error, safeBudgetBytes }, "Soft-fail VRAM guard engaged");
    thoughtLog.publish({ level: "warning", category: "system", title: "VRAM Guard Safe Mode", message: reason, metadata: { safeBudgetBytes } });
    return {
      mode: "safe-mode", status: "degraded", provider: "nvidia", reason,
      safeBudgetBytes: Math.max(0, safeBudgetBytes - SAFE_MODE_RESERVE_BYTES),
      reserveBytes: SAFE_MODE_RESERVE_BYTES, detectedAt,
    };
  }
}

// ── Universal gateway ─────────────────────────────────────────────────────────

async function fetchOllamaTagsRaw(): Promise<OllamaTag[]> {
  const r = await distributedFetchJson<{models?: OllamaTag[]}>("/api/tags", undefined, 10000);
  return r.models ?? [];
}

async function fetchOllamaRunningRaw(): Promise<Array<{name:string;size_vram?:number}>> {
  const r = await distributedFetchJson<{models?: Array<{name:string;size_vram?:number}>}>("/api/ps", undefined, 5000);
  return r.models ?? [];
}

function buildAssignedRolesMap(roles: Record<string, string>): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const [role, modelName] of Object.entries(roles)) {
    if (!modelName) continue;
    (map[modelName] ??= []).push(role);
  }
  return map;
}

export async function getUniversalGatewayTags(forceRefresh = false): Promise<GatewayTagsResult> {
  if (!forceRefresh && catalogCache && Date.now() - catalogCache.cachedAt < CATALOG_CACHE_TTL_MS) {
    return catalogCache.result;
  }
  try {
    const [tags, running, roles, vramGuard] = await Promise.all([
      fetchOllamaTagsRaw(),
      fetchOllamaRunningRaw().catch(() => []),
      loadRoleAssignments(),
      probeNvidiaVram(),
    ]);
    const runningMap    = new Map(running.map(e => [e.name, e]));
    const assignedRoles = buildAssignedRolesMap(roles);
    let totalSize = 0; let totalRunningVram = 0;
    const models: GatewayModel[] = tags.map(tag => {
      const estimatedRuntimeBytes = estimateRuntimeBytes(tag);
      const runningEntry = runningMap.get(tag.name);
      totalSize        += tag.size;
      totalRunningVram += runningEntry?.size_vram ?? 0;
      return {
        name: tag.name, size: tag.size, sizeFormatted: formatBytes(tag.size),
        estimatedRuntimeBytes, estimatedRuntimeFormatted: formatBytes(estimatedRuntimeBytes),
        modifiedAt: tag.modified_at, digest: tag.digest,
        parameterSize: tag.details?.parameter_size, quantizationLevel: tag.details?.quantization_level,
        isRunning: runningMap.has(tag.name),
        sizeVram: runningEntry?.size_vram ?? 0, sizeVramFormatted: formatBytes(runningEntry?.size_vram ?? 0),
        assignedRole: assignedRoles[tag.name]?.join(", "),
        routeAffinity: inferIntentFromModelName(tag.name),
        runtimeClass: classifyRuntimeSize(estimatedRuntimeBytes),
      };
    });
    await saveGatewayState(c => ({ ...c, lastTagsAt: new Date().toISOString(), lastVramGuard: vramGuard }));
    const result: GatewayTagsResult = {
      models, ollamaReachable: true, totalSize, totalSizeFormatted: formatBytes(totalSize),
      totalRunningVram, totalRunningVramFormatted: formatBytes(totalRunningVram), vramGuard,
    };
    catalogCache = { result, cachedAt: Date.now() };
    return result;
  } catch (error) {
    const vramGuard = await probeNvidiaVram();
    logger.error({ err: error }, "Failed to list Ollama tags through the universal gateway");
    const errorResult: GatewayTagsResult = { models: [], ollamaReachable: false, totalSize: 0, totalSizeFormatted: "0 B", totalRunningVram: 0, totalRunningVramFormatted: "0 B", vramGuard };
    return errorResult;
  }
}

export async function getRunningGatewayModels(): Promise<{models:Array<{name:string;sizeVram:number;sizeVramFormatted:string}>;ollamaReachable:boolean;totalVram:number;totalVramFormatted:string}> {
  try {
    const running    = await fetchOllamaRunningRaw();
    const totalVram  = running.reduce((s, e) => s + (e.size_vram ?? 0), 0);
    return {
      models: running.map(e => ({ name: e.name, sizeVram: e.size_vram ?? 0, sizeVramFormatted: formatBytes(e.size_vram ?? 0) })),
      ollamaReachable: true, totalVram, totalVramFormatted: formatBytes(totalVram),
    };
  } catch {
    return { models: [], ollamaReachable: false, totalVram: 0, totalVramFormatted: "0 B" };
  }
}

// ── Dynamic routing ───────────────────────────────────────────────────────────

function rolePriorityForIntent(intent: RouteDecision["intent"]): string[] {
  if (intent === "code")   return ["primary-coding","fast-coding","reasoning"];
  if (intent === "vision") return ["vision","chat"];
  return ["chat","reasoning"];
}

function canonicalPreferencesForIntent(intent: RouteDecision["intent"]): string[] {
  if (intent === "code")   return ["deepseek-coder","deepseek-r1","qwen3-coder","qwen2.5-coder","codellama"];
  if (intent === "vision") return ["llava","llava-phi3","qwen2.5-vl","minicpm-v","moondream"];
  return ["llama3.1","llama3.2","llama3","qwen3","mistral","gemma3"];
}

function matchesModel(candidate: GatewayModel, query: string): boolean {
  const q = query.toLowerCase(); const n = candidate.name.toLowerCase();
  return n === q || n.startsWith(`${q}:`) || n.startsWith(q);
}

function pickByQueries(models: GatewayModel[], queries: string[]): GatewayModel[] {
  const ordered: GatewayModel[] = []; const seen = new Set<string>();
  for (const query of queries) {
    const match = models.find(c => !seen.has(c.name) && matchesModel(c, query));
    if (!match) continue;
    ordered.push(match); seen.add(match.name);
  }
  for (const model of models) { if (!seen.has(model.name)) ordered.push(model); }
  return ordered;
}

function buildCandidateOrder(
  models: GatewayModel[],
  roles: Record<string, string>,
  intent: RouteDecision["intent"],
  requestedModel?: string,
  hint?: RoutingHint,
): GatewayModel[] {
  const queries: string[] = [];
  // 1. Explicit request from user (highest priority)
  if (requestedModel) queries.push(requestedModel);
  // 2. Supervisor's suggested model (second priority — avoids re-running inference)
  if (hint?.supervisorSuggestedModel) queries.push(hint.supervisorSuggestedModel);
  // 3. Assigned roles for the detected intent
  for (const role of rolePriorityForIntent(intent)) { const rm = roles[role]; if (rm) queries.push(rm); }
  // 4. Canonical preferences for the intent
  queries.push(...canonicalPreferencesForIntent(intent));
  return pickByQueries(models, queries);
}

function admissionForModel(model: GatewayModel, guard: VramGuard, runningModels: GatewayModel[]): AdmissionResult {
  const otherRunningBytes = runningModels
    .filter(r => r.name !== model.name)
    .reduce((s, r) => s + Math.max(r.sizeVram ?? 0, r.estimatedRuntimeBytes), 0);
  const requiredBytes  = model.estimatedRuntimeBytes;
  const availableBytes = Math.max(0, guard.safeBudgetBytes - otherRunningBytes);
  const allowed        = requiredBytes <= availableBytes;
  return {
    allowed, mode: guard.mode, requiredBytes, availableBytes,
    reason: allowed
      ? `${model.name} fits within the current ${guard.mode} budget`
      : `${model.name} needs ${formatBytes(requiredBytes)} but only ${formatBytes(availableBytes)} is available in ${guard.mode}`,
  };
}

/**
 * Select the best model for a set of messages.
 *
 * @param messages        The conversation so far.
 * @param requestedModel  Explicit model name from the user (optional).
 * @param hint            Supervisor routing hint — skips independent intent
 *                        inference and biases candidate ordering toward the
 *                        supervisor's suggested model.
 */
export async function routeModelForMessages(
  messages: ChatMessage[],
  requestedModel?: string,
  hint?: RoutingHint,
): Promise<RouteDecision> {
  const [tags, roles] = await Promise.all([getUniversalGatewayTags(), loadRoleAssignments()]);
  if (!tags.ollamaReachable || tags.models.length === 0) throw new Error("Ollama is not reachable or no models are installed.");

  // Use supervisor's pre-computed intent when available — avoids duplicate work.
  const intent = hint?.supervisorIntent ?? inferIntentFromMessages(messages);

  const candidates    = buildCandidateOrder(tags.models, roles, intent, requestedModel, hint);
  const runningModels = tags.models.filter(m => m.isRunning);
  const ordered       = [...candidates.filter(m => m.routeAffinity === intent), ...candidates.filter(m => m.routeAffinity !== intent)];
  let selected = ordered[0]!;
  let admission = admissionForModel(selected, tags.vramGuard, runningModels);
  for (const candidate of ordered) {
    const a = admissionForModel(candidate, tags.vramGuard, runningModels);
    if (a.allowed) { selected = candidate; admission = a; break; }
    if (candidate.estimatedRuntimeBytes < selected.estimatedRuntimeBytes) { selected = candidate; admission = a; }
  }
  if (!admission.allowed) throw new Error(`VRAM Guard blocked all installed candidates for ${intent}. Smallest available model is ${selected.name} but it still exceeds the ${tags.vramGuard.mode} budget.`);
  const switched = !!requestedModel && !matchesModel(selected, requestedModel);
  const hintNote = hint?.supervisorIntent ? ` (supervisor pre-classified as ${hint.supervisorIntent})` : "";
  const reason   = switched
    ? `Intent router switched from ${requestedModel} to ${selected.name} for ${intent} handling${hintNote}`
    : `Intent router selected ${selected.name} for ${intent} handling${hintNote}`;
  const decision: RouteDecision = { intent, requestedModel, selectedModel: selected.name, selectedAffinity: selected.routeAffinity, switched, reason, admission };
  await saveGatewayState(c => ({ ...c, lastRoute: decision, lastVramGuard: tags.vramGuard }));
  thoughtLog.publish({
    category: "system",
    title: "Dynamic Route",
    message: reason,
    metadata: {
      intent,
      supervisorHint: hint?.supervisorIntent,
      requestedModel,
      selectedModel: selected.name,
      guardMode: admission.mode,
      requiredBytes: admission.requiredBytes,
      availableBytes: admission.availableBytes,
    },
  });
  return decision;
}

// ── Streaming helpers ─────────────────────────────────────────────────────────

async function readStreamAsJsonLines(reader: ReadableStreamDefaultReader<Uint8Array>, onLine: (line: string) => Promise<void>): Promise<void> {
  const decoder = new TextDecoder(); let buffer = "";
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
    for (const line of lines) { const t = line.trim(); if (t) await onLine(t); }
  }
  const trailing = buffer.trim(); if (trailing) await onLine(trailing);
}

function flushResponse(response: Response): void {
  const maybeFlush = (response as unknown as { flush?: () => void }).flush;
  if (typeof maybeFlush === "function") maybeFlush.call(response);
}

function initializeSse(response: Response): void {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  (response as unknown as { flushHeaders?: () => void }).flushHeaders?.();
  flushResponse(response);
}

function writeSseData(response: Response, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`); flushResponse(response);
}
function writeSseDone(response: Response): void {
  response.write("data: [DONE]\n\n"); flushResponse(response);
}

export async function streamGatewayChatToSse(response: Response, options: StreamOptions): Promise<void> {
  initializeSse(response);
  const route = await routeModelForMessages(options.messages, options.requestedModel, options.routingHint);
  const upstreamController = new AbortController();
  let settled = false; let clientDisconnected = false; let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const tokenBuffer = new LatencyOptimizedTokenBuffer(
    chunk => writeSseData(response, { token: chunk, done: false, model: route.selectedModel }),
    getStreamingBufferProfile(),
  );
  const cleanup      = () => { response.off("close", abortFromClient); response.off("error", abortFromClient); };
  const abortFromClient = () => {
    if (settled) return; clientDisconnected = true; settled = true;
    upstreamController.abort(); void reader?.cancel().catch(() => undefined); cleanup();
  };
  const finishStream = () => {
    if (settled) return; settled = true; cleanup();
    if (!response.destroyed && !response.writableEnded) { tokenBuffer.close(); writeSseDone(response); response.end(); }
  };
  response.on("close", abortFromClient); response.on("error", abortFromClient);
  for (const payload of options.initialPayloads ?? []) writeSseData(response, payload);
  writeSseData(response, { route, model: route.selectedModel, switched: route.switched });
  const [baseUrl, proxyHeaders] = await Promise.all([getActiveGatewayBaseUrl(), buildDistributedProxyHeaders()]);
  const upstreamResponse = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: mergeHeaders(proxyHeaders, { "Content-Type": "application/json" }),
    body: JSON.stringify({ model: route.selectedModel, messages: options.messages, stream: true }),
    signal: upstreamController.signal,
  });
  if (!upstreamResponse.ok || !upstreamResponse.body) {
    const errorText = await upstreamResponse.text().catch(() => "");
    throw new Error(errorText || `Ollama stream failed with HTTP ${upstreamResponse.status}`);
  }
  reader = upstreamResponse.body.getReader(); let emittedDone = false;
  try {
    await readStreamAsJsonLines(reader, async line => {
      if (clientDisconnected) return;
      const parsed = JSON.parse(line) as { error?: string; message?: { content?: string }; done?: boolean };
      if (parsed.error) { writeSseData(response, { error: parsed.error, model: route.selectedModel, route }); throw new Error(parsed.error); }
      if (parsed.message?.content) tokenBuffer.enqueue(parsed.message.content);
      if (parsed.done && !emittedDone) { emittedDone = true; tokenBuffer.flush(); writeSseData(response, { done: true, model: route.selectedModel, route }); }
    });
  } finally { if (!clientDisconnected) finishStream(); else { tokenBuffer.close(); cleanup(); } }
}

export async function sendGatewayChat(
  messages: ChatMessage[],
  requestedModel?: string,
  hint?: RoutingHint,
): Promise<{model:string;message:string;route:RouteDecision}> {
  const route = await routeModelForMessages(messages, requestedModel, hint);
  const response = await distributedFetchJson<{message?:{content?:string}}>("/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: route.selectedModel, messages, stream: false }),
  }, 120000);
  return { model: route.selectedModel, message: response.message?.content ?? "", route };
}

// ── Model lifecycle ───────────────────────────────────────────────────────────

export async function pullModelFromOllama(modelName: string, onProgress: (p: number, m: string, meta?: Record<string,unknown>) => void): Promise<void> {
  const response = await distributedFetch("/api/pull", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelName, stream: true }),
  }, 120000);
  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => "");
    throw new Error(errorText || `Ollama pull failed with HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  await readStreamAsJsonLines(reader, async line => {
    const parsed = JSON.parse(line) as { error?: string; status?: string; total?: number; completed?: number; digest?: string };
    if (parsed.error) throw new Error(parsed.error);
    const progress = parsed.total && parsed.completed ? clamp(Math.round(parsed.completed / parsed.total * 100), 1, 100) : parsed.status?.toLowerCase().includes("success") ? 100 : 5;
    onProgress(progress, parsed.status ?? "Pulling model...", { digest: parsed.digest, completed: parsed.completed, total: parsed.total, modelName });
  });
}

export function queueUniversalModelPull(modelName: string) {
  const normalized = modelName.trim();
  return taskQueue.enqueue(`Pull ${normalized}`, "model-pull", async ({ updateProgress, publishThought, job }) => {
    publishThought("Gateway Pull Started", `Starting Ollama HTTP pull for ${normalized}`, { modelName: normalized });
    await pullModelFromOllama(normalized, updateProgress);
    updateProgress(100, "Model pull completed", { modelName: normalized });
    await saveGatewayState(c => ({ ...c, lastPull: { modelName: normalized, jobId: job.id, updatedAt: new Date().toISOString() } }));
    thoughtLog.publish({ category: "system", title: "Gateway Pull Complete", message: `${normalized} finished downloading via Ollama HTTP pull`, metadata: { modelName: normalized, jobId: job.id } });
    return { modelName: normalized };
  }, { capability: "sysadmin", metadata: { modelName: normalized } });
}

export async function loadOllamaModel(modelName: string): Promise<void> {
  await distributedFetchJson("/api/generate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName, prompt: "", keep_alive: "30m" }),
  }, 15000);
}

export async function unloadOllamaModel(modelName: string): Promise<void> {
  await distributedFetchJson("/api/generate", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName, prompt: "", keep_alive: 0 }),
  }, 10000);
}

export async function deleteOllamaModel(modelName: string): Promise<void> {
  const response = await distributedFetch("/api/delete", {
    method: "DELETE", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelName }),
  }, 30000);
  if (response.ok) return;
  const errorText = await response.text().catch(() => "");
  throw new Error(errorText || `Ollama delete failed with HTTP ${response.status}`);
}
