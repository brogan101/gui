/**
 * GLOBAL WORKSPACE INTELLIGENCE
 * Autonomous multi-file refactor agent with project-graph-aware planning,
 * topological execution ordering, and Read-Write-Verify loop per step.
 */

import { randomUUID } from "crypto";
import { fetchJson, ollamaReachable } from "./runtime.js";
import { loadSettings } from "./secure-config.js";
import { workspaceContextService } from "./code-context.js";
import { logger } from "./logger.js";
import type { WorkspaceIndex, IndexedFile } from "./code-context.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RefactorStep {
  id: string;
  filePath: string;
  relativePath: string;
  status: "pending" | "running" | "completed" | "failed";
  reason: string;
  diff?: string;
  verificationMessage?: string;
  error?: string;
}

export interface ImpactedFileEntry {
  path: string;
  relativePath: string;
  score: number;
  reason: string;
  matchedSymbols: string[];
  relatedFiles: string[];
}

export interface RefactorPlan {
  id: string;
  workspacePath: string;
  workspaceName: string;
  request: string;
  createdAt: string;
  impactedFiles: ImpactedFileEntry[];
  steps: RefactorStep[];
  summary: string;
}

export interface RefactorJob {
  id: string;
  planId: string;
  workspacePath: string;
  request: string;
  model: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  steps: RefactorStep[];
  error?: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const plans = new Map<string, RefactorPlan>();
const jobs  = new Map<string, RefactorJob>();

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return [...new Set(
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9_.:/-]+/)
      .filter(token => token.length >= 2),
  )];
}

// ---------------------------------------------------------------------------
// Preferred coding model
// ---------------------------------------------------------------------------

async function loadPreferredCodingModel(): Promise<string> {
  const fallback = "qwen2.5-coder:7b";
  try {
    const settings = await loadSettings();
    const s = settings as unknown as Record<string, unknown>;
    if (s["defaultCodingModel"] && typeof s["defaultCodingModel"] === "string") {
      const model = (s["defaultCodingModel"] as string).trim();
      if (model) return model;
    }
  } catch { /* ignore */ }
  try {
    const response = await fetchJson<{ models?: Array<{ name: string }> }>(
      "http://127.0.0.1:11434/api/tags", undefined, 4000,
    );
    const installed = (response.models ?? []).map(m => m.name);
    return (
      installed.find(name => name.startsWith("qwen3-coder"))    ||
      installed.find(name => name.startsWith("qwen2.5-coder")) ||
      installed[0]                                               ||
      fallback
    );
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

function createGraphMaps(index: WorkspaceIndex): {
  outbound: Map<string, Set<string>>;
  inbound:  Map<string, Set<string>>;
} {
  const outbound = new Map<string, Set<string>>();
  const inbound  = new Map<string, Set<string>>();
  for (const edge of index.edges) {
    if (!outbound.has(edge.from)) outbound.set(edge.from, new Set());
    if (!inbound.has(edge.to))    inbound.set(edge.to,    new Set());
    outbound.get(edge.from)!.add(edge.to);
    inbound.get(edge.to)!.add(edge.from);
  }
  return { outbound, inbound };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface ScoreResult {
  score: number;
  matchedSymbols: Array<{ kind: string; name: string; lineStart: number }>;
}

function symbolMatchesQuery(
  symbol: { name: string },
  queryTokens: string[],
): boolean {
  const lower = symbol.name.toLowerCase();
  return queryTokens.some(token => lower.includes(token));
}

function scoreFile(file: IndexedFile, queryTokens: string[]): ScoreResult {
  let score = 0;
  const matchedSymbols: Array<{ kind: string; name: string; lineStart: number }> = [];
  const lowerPath = file.relativePath.toLowerCase();

  for (const token of queryTokens) {
    if (lowerPath.includes(token))            score += 12;
    if (file.preview.toLowerCase().includes(token)) score += 2;
    if (file.searchText.includes(token))      score += 3;
    for (const symbol of file.symbols) {
      if (symbolMatchesQuery(symbol, [token])) {
        matchedSymbols.push(symbol);
        score += symbol.name.toLowerCase() === token ? 18 : 10;
      }
    }
  }

  if (/\bauth|login|session|token|permission|role\b/.test(queryTokens.join(" "))) {
    if (/(auth|login|session|token|permission|role)/.test(lowerPath)) score += 15;
  }

  return {
    score,
    matchedSymbols: [
      ...new Map(
        matchedSymbols.map(s => [`${s.kind}:${s.name}:${s.lineStart}`, s]),
      ).values(),
    ],
  };
}

// ---------------------------------------------------------------------------
// Topological ordering
// ---------------------------------------------------------------------------

function topologicallyOrderFiles(
  files: ImpactedFileEntry[],
  index: WorkspaceIndex,
): ImpactedFileEntry[] {
  const selected  = new Set(files.map(f => f.path));
  const outbound  = new Map<string, string[]>();
  const indegree  = new Map<string, number>();

  for (const file of files) {
    outbound.set(file.path, []);
    indegree.set(file.path, 0);
  }
  for (const edge of index.edges) {
    if (!selected.has(edge.from) || !selected.has(edge.to)) continue;
    outbound.get(edge.to)!.push(edge.from);
    indegree.set(edge.from, (indegree.get(edge.from) ?? 0) + 1);
  }

  const queue = files
    .filter(f => (indegree.get(f.path) ?? 0) === 0)
    .sort((a, b) => b.score - a.score);

  const ordered: ImpactedFileEntry[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    ordered.push(current);
    for (const dep of outbound.get(current.path) ?? []) {
      indegree.set(dep, (indegree.get(dep) ?? 0) - 1);
      if ((indegree.get(dep) ?? 0) === 0) {
        const match = files.find(f => f.path === dep);
        if (match) queue.push(match);
      }
    }
  }

  if (ordered.length === files.length) return ordered;
  return [...files].sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Plan creation
// ---------------------------------------------------------------------------

export async function createRefactorPlan(
  request: string,
  workspacePath?: string,
): Promise<RefactorPlan> {
  const summaries      = await workspaceContextService.getWorkspaceSummaries();
  const selectedWorkspace = workspacePath ?? summaries[0]?.rootPath;
  if (!selectedWorkspace) throw new Error("No indexed workspace is available.");

  const index       = await workspaceContextService.indexWorkspace(selectedWorkspace);
  const queryTokens = tokenize(request);
  const { outbound, inbound } = createGraphMaps(index);

  const baseMatches = index.files
    .map(file => ({ file, ...scoreFile(file, queryTokens) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);

  const expanded = new Map<string, ImpactedFileEntry>();

  for (const match of baseMatches) {
    const related = new Set([
      ...(outbound.get(match.file.path) ?? []),
      ...(inbound.get(match.file.path)  ?? []),
    ]);

    expanded.set(match.file.path, {
      path:         match.file.path,
      relativePath: match.file.relativePath,
      score:        match.score,
      reason:
        match.matchedSymbols.length > 0
          ? `Directly matches ${match.matchedSymbols.map(s => s.name).join(", ")}`
          : "Direct query/path match in the project graph",
      matchedSymbols: match.matchedSymbols.map(s => `${s.kind} ${s.name}`),
      relatedFiles:   [...related]
        .map(rp => index.files.find(f => f.path === rp)?.relativePath)
        .filter((v): v is string => !!v)
        .slice(0, 6),
    });

    for (const neighborPath of related) {
      if (expanded.has(neighborPath)) continue;
      const neighbor = index.files.find(f => f.path === neighborPath);
      if (!neighbor) continue;
      expanded.set(neighborPath, {
        path:           neighbor.path,
        relativePath:   neighbor.relativePath,
        score:          Math.max(1, match.score - 4),
        reason:         `Included via project graph relationship with ${match.file.relativePath}`,
        matchedSymbols: [],
        relatedFiles:   [match.file.relativePath],
      });
    }
  }

  const impactedFiles = topologicallyOrderFiles([...expanded.values()].slice(0, 16), index);

  const steps: RefactorStep[] = impactedFiles.map(file => ({
    id:           randomUUID(),
    filePath:     file.path,
    relativePath: file.relativePath,
    status:       "pending",
    reason:       file.reason,
  }));

  const plan: RefactorPlan = {
    id:            randomUUID(),
    workspacePath: index.rootPath,
    workspaceName: index.workspaceName,
    request,
    createdAt:     new Date().toISOString(),
    impactedFiles,
    steps,
    summary:
      impactedFiles.length === 0
        ? "No likely impacted files were found in the current project graph."
        : `Found ${impactedFiles.length} impacted files and built a sequential execution plan.`,
  };

  plans.set(plan.id, plan);
  return plan;
}

// ---------------------------------------------------------------------------
// Content generation
// ---------------------------------------------------------------------------

function sanitizeModelOutput(raw: string): string {
  const trimmed     = raw.trim();
  const fencedMatch = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  return fencedMatch ? fencedMatch[1] : trimmed;
}

async function generateUpdatedFileContent(
  plan: RefactorPlan,
  step: RefactorStep,
  model: string,
): Promise<string> {
  const target = await workspaceContextService.readWorkspaceFile(step.filePath, plan.workspacePath);
  const neighborContext = await workspaceContextService.search(
    `${plan.request} ${step.relativePath} ${target.symbols.map(s => s.name).join(" ")}`,
    plan.workspacePath,
    5,
    8000,
  );

  const systemPrompt = [
    "You are an autonomous refactor agent working on one file at a time.",
    "You are part of a larger multi-file execution plan for one workspace.",
    "Preserve formatting style and imports unless the refactor requires changes.",
    "Return only the full updated file content. Do not wrap it in Markdown fences.",
  ].join("\n");

  const userPrompt = [
    `Workspace: ${plan.workspaceName}`,
    `Refactor request: ${plan.request}`,
    "",
    "Execution plan:",
    ...plan.steps.map((s, i) => `${i + 1}. ${s.relativePath} — ${s.reason}`),
    "",
    `Current target file: ${step.relativePath}`,
    `Target file symbols: ${target.symbols.map(s => `${s.kind} ${s.name}`).join(", ") || "none detected"}`,
    "",
    "Related project context:",
    neighborContext.promptContext || "No additional related excerpts were found.",
    "",
    `Current contents of ${step.relativePath}:`,
    target.content,
  ].join("\n");

  const response = await fetchJson<{ message?: { content?: string } }>(
    "http://127.0.0.1:11434/api/chat",
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        model,
        stream:   false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userPrompt   },
        ],
      }),
    },
    180000,
  );

  return sanitizeModelOutput(response.message?.content ?? target.content);
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

async function runRefactorJob(jobId: string): Promise<void> {
  const job  = jobs.get(jobId);
  if (!job) return;
  const plan = plans.get(job.planId);
  if (!plan) {
    job.status     = "failed";
    job.error      = "Execution plan not found.";
    job.finishedAt = new Date().toISOString();
    return;
  }

  job.status     = "running";
  job.startedAt  = new Date().toISOString();

  for (const step of job.steps) {
    step.status = "running";
    try {
      const updatedContent = await generateUpdatedFileContent(plan, step, job.model);
      const result         = await workspaceContextService.applyReadWriteVerify(
        step.filePath, updatedContent, plan.workspacePath,
      );
      if (!result.success) {
        step.status              = "failed";
        step.diff                = result.diff;
        step.verificationMessage = result.message;
        step.error               = result.verification.diagnostics.join("\n") || result.message;
        job.status               = "failed";
        job.error                = `Execution stopped at ${step.relativePath}`;
        job.finishedAt           = new Date().toISOString();
        return;
      }
      step.status              = "completed";
      step.diff                = result.diff;
      step.verificationMessage = result.message;
    } catch (err) {
      const error      = err as Error;
      step.status      = "failed";
      step.error       = error.message;
      job.status       = "failed";
      job.error        = `Execution stopped at ${step.relativePath}`;
      job.finishedAt   = new Date().toISOString();
      logger.error({ err: error, planId: plan.id, filePath: step.filePath }, "Global workspace execution failed");
      return;
    }
  }

  job.status     = "completed";
  job.finishedAt = new Date().toISOString();
}

export async function executeRefactorPlan(
  planId: string,
  model?: string,
): Promise<RefactorJob> {
  const plan = plans.get(planId);
  if (!plan) throw new Error("Execution plan not found.");
  if (!await ollamaReachable()) throw new Error("Ollama is not running.");

  const job: RefactorJob = {
    id:            randomUUID(),
    planId,
    workspacePath: plan.workspacePath,
    request:       plan.request,
    model:         model ?? await loadPreferredCodingModel(),
    status:        "queued",
    createdAt:     new Date().toISOString(),
    steps:         plan.steps.map(s => ({ ...s })),
  };

  jobs.set(job.id, job);
  void runRefactorJob(job.id);
  return job;
}

export function getRefactorPlan(planId: string): RefactorPlan | null {
  return plans.get(planId) ?? null;
}

export function getRefactorJob(jobId: string): RefactorJob | null {
  return jobs.get(jobId) ?? null;
}

export function listRefactorJobs(): RefactorJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
