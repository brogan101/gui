/**
 * SUPERVISOR AGENT — Real-Time Agentic Routing & Task Planning
 * =============================================================
 * Analyses incoming chat messages, classifies the task category,
 * generates a step-by-step execution plan, and recommends the
 * optimal model + toolset.  Every sub-step of the analysis is
 * narrated in real-time to the Thought Log so the UI can show
 * live "what the brain is doing" observability.
 *
 * Routing matrix:
 *   Coding    → DeepSeek-Coder / Qwen-Coder   + Execution toolset
 *   SysAdmin  → DeepSeek-R1 / Qwen3           + Execution toolset
 *   Hardware  → LLaVA / Qwen-VL               + Vision toolset
 *   General   → Llama / Qwen3 / Mistral        + RAG toolset
 *
 * Public API:
 *   runSupervisorPipeline()  — full async pipeline with real-time narration
 *   analyzeMessages()        — synchronous plan generation (no I/O)
 *   activateSupervisorPlan() — apply a plan to GlobalState + publish thought
 *   advanceSupervisorStep()  — tick the active step counter
 *   clearSupervisorState()   — wipe sovereign state on conversation end
 *   agentDisplayName()       — human-readable agent label per category
 */

import { thoughtLog } from "./thought-log.js";
import { stateOrchestrator } from "./state-orchestrator.js";
import type { TaskCategory } from "./secure-config.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ToolsetType = "execution" | "rag" | "vision";

export interface AgentExecutionPlan {
  category: TaskCategory;
  goal: string;
  steps: string[];
  suggestedModel: string;
  toolset: ToolsetType;
  confidence: number;
  manualOverride: boolean;
  overrideModel?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ── Pattern-matching classification ──────────────────────────────────────────

const CATEGORY_PATTERNS: Record<TaskCategory, RegExp[]> = {
  coding: [
    /```[\s\S]*```/,
    /`[^`]+`/,
    /\b(code|debug|fix|refactor|typescript|javascript|python|function|class|stack ?trace|compile|build ?error|sql|regex|api|endpoint|component|hook|module|import|export|unit ?test|jest|vitest|eslint|prettier|git|commit|branch|merge|pull ?request|dockerfile|ci\/cd)\b/i,
  ],
  sysadmin: [
    /\b(server|deploy|nginx|docker|kubernetes|k8s|service|daemon|process|port|firewall|ssl|certificate|cron|systemd|pm2|bash|shell|script|install|upgrade|dependency|npm|pip|brew|apt|yum|winget|configure|environment|env|variable|restart|reload|permission|chmod|sudo|admin|ssh|vpn|network|dns)\b/i,
  ],
  hardware: [
    /\b(cad|3d|openscad|blender|fusion\s*360|solidworks|stl|g[-_]?code|printer|filament|pla|abs|petg|nozzle|slicer|freecad|mesh|render|brim|support|infill|layer|circuit|pcb|arduino|raspberry|gpio|sensor|actuator|motor|servo|cnc|milling|extrude)\b/i,
  ],
  general: [
    /\b(explain|what|how|why|help|write|create|summarize|translate|analyze|review|compare|list|describe|tell me|give me|show me)\b/i,
  ],
};

const VISION_PATTERN =
  /\b(image|photo|picture|screenshot|diagram|chart|vision|ocr|look at|analyze this image|what do you see)\b/i;

// Model preference lists per category (first match in installed models wins).
const MODEL_PREFERENCES: Record<TaskCategory, string[]> = {
  coding:   ["deepseek-coder-v2", "deepseek-r1", "qwen3-coder", "qwen2.5-coder", "codellama", "starcoder2"],
  sysadmin: ["deepseek-r1", "qwen3", "llama3.1", "mistral", "phi4"],
  hardware: ["llava", "qwen2.5-vl", "minicpm-v", "moondream", "deepseek-r1", "qwen3"],
  general:  ["llama3.1", "llama3.2", "qwen3", "mistral", "gemma3", "phi4"],
};

const TOOLSET_MAP: Record<TaskCategory, ToolsetType> = {
  coding:   "execution",
  sysadmin: "execution",
  hardware: "vision",
  general:  "rag",
};

// ── Classification (pure — no side effects) ───────────────────────────────────

interface ClassificationResult {
  category: TaskCategory;
  confidence: number;
  scores: Record<TaskCategory, number>;
}

function classifyCategory(messages: ChatMessage[]): ClassificationResult {
  const latestUser =
    [...messages].reverse().find(m => m.role === "user")?.content ?? "";
  const allUserContent = messages
    .filter(m => m.role === "user")
    .map(m => m.content)
    .join(" ");

  const scores: Record<TaskCategory, number> = {
    coding: 0,
    sysadmin: 0,
    hardware: 0,
    general: 0,
  };

  for (const [cat, patterns] of Object.entries(CATEGORY_PATTERNS) as [TaskCategory, RegExp[]][]) {
    for (const re of patterns) {
      scores[cat] += (latestUser.match(re) ?? []).length * 3;
      scores[cat] += (allUserContent.match(re) ?? []).length;
    }
  }

  if (VISION_PATTERN.test(latestUser)) {
    scores.hardware += 5;
    scores.general  += 2;
  }

  const entries = Object.entries(scores) as [TaskCategory, number][];
  entries.sort((a, b) => b[1] - a[1]);
  const [topEntry] = entries;
  const total = entries.reduce((s, [, v]) => s + v, 0);

  if (topEntry[1] === 0) {
    return { category: "general", confidence: 0.25, scores };
  }
  return {
    category:   topEntry[0],
    confidence: Math.min(0.99, total > 0 ? topEntry[1] / total : 0.25),
    scores,
  };
}

// ── Plan generation (pure — no side effects) ──────────────────────────────────

function generateExecutionPlan(category: TaskCategory, goal: string): string[] {
  const truncatedGoal =
    goal.length > 100 ? `${goal.slice(0, 100)}…` : goal;

  const templates: Record<TaskCategory, string[]> = {
    coding: [
      "Analyze the code context and identify the affected files",
      "Understand the existing patterns, types, and conventions",
      `Implement: ${truncatedGoal}`,
      "Verify correctness and check for edge cases",
      "Summarize changes and suggest follow-up tests",
    ],
    sysadmin: [
      "Check current system state and installed dependencies",
      "Identify required configuration or package changes",
      `Execute: ${truncatedGoal}`,
      "Verify the change is effective and no regressions occurred",
      "Log the operation and suggest monitoring steps",
    ],
    hardware: [
      "Analyze hardware specifications or design requirements",
      "Determine the appropriate tool (OpenSCAD / G-code / Blender)",
      `Design/generate: ${truncatedGoal}`,
      "Validate parameters and material compatibility",
      "Output the final file, script, or instructions",
    ],
    general: [
      "Understand the full context of the request",
      "Gather relevant information from available knowledge",
      `Respond to: ${truncatedGoal}`,
      "Check completeness and accuracy of the response",
    ],
  };
  return templates[category];
}

// ── Public sync API ───────────────────────────────────────────────────────────

/** Synchronously analyse messages and return an execution plan.
 *  Does NOT publish any thought-log entries — use runSupervisorPipeline()
 *  for real-time narrated analysis. */
export function analyzeMessages(
  messages: ChatMessage[],
  manualOverrideModel?: string,
): AgentExecutionPlan {
  const lastUserMsg =
    [...messages].reverse().find(m => m.role === "user")?.content?.trim() ?? "";
  const goal =
    lastUserMsg.length > 120 ? `${lastUserMsg.slice(0, 120)}…` : lastUserMsg;

  const { category, confidence } = classifyCategory(messages);
  const steps = generateExecutionPlan(category, goal);
  const suggestedModel = MODEL_PREFERENCES[category][0] ?? "llama3.1";
  const toolset = TOOLSET_MAP[category];

  return {
    category,
    goal,
    steps,
    suggestedModel,
    toolset,
    confidence,
    manualOverride: !!manualOverrideModel,
    overrideModel:  manualOverrideModel,
  };
}

/** Apply a supervisor plan to the global sovereign state and publish a
 *  single summary thought-log entry.  Non-fatal on failure.
 *  For granular real-time narration, use runSupervisorPipeline() instead. */
export async function activateSupervisorPlan(
  plan: AgentExecutionPlan,
): Promise<void> {
  try {
    const agentName = agentDisplayName(plan.category);
    stateOrchestrator.setSovereignState({
      activeGoal:            plan.goal,
      activeAgentName:       agentName,
      activeStep:            0,
      currentStepDescription: plan.steps[0],
      totalSteps:            plan.steps.length,
      executionPlan:         plan.steps,
      taskCategory:          plan.category,
    });

    thoughtLog.publish({
      category: "system",
      title:    "Supervisor Agent Active",
      message:  `Task classified as '${plan.category}' (${Math.round(plan.confidence * 100)}% confidence). ` +
                `${plan.manualOverride
                  ? `Manual override: ${plan.overrideModel}`
                  : `Suggested model: ${plan.suggestedModel}`}`,
      metadata: {
        category:       plan.category,
        agentName,
        confidence:     plan.confidence,
        goal:           plan.goal,
        steps:          plan.steps.length,
        suggestedModel: plan.suggestedModel,
        manualOverride: plan.manualOverride,
        toolset:        plan.toolset,
      },
    });
  } catch {
    // Non-fatal — supervisor state update must never block chat
  }
}

// ── Real-time pipeline (narrated) ─────────────────────────────────────────────

/**
 * Full supervisor pipeline with real-time Thought Log narration.
 *
 * Publishes one thought entry per sub-step so the UI receives a live
 * stream of the brain's internal reasoning:
 *   1. "Scanning message history for task signals…"
 *   2. Scoring breakdown per category
 *   3. Classification result + confidence
 *   4. Execution plan construction (one entry listing all steps)
 *   5. Model selection reasoning
 *   6. "Pipeline complete"
 *
 * Returns the same AgentExecutionPlan as analyzeMessages() but as a
 * Promise so callers can await the full narration before streaming.
 */
export async function runSupervisorPipeline(
  messages: ChatMessage[],
  manualOverrideModel?: string,
): Promise<AgentExecutionPlan> {
  const lastUserMsg =
    [...messages].reverse().find(m => m.role === "user")?.content?.trim() ?? "";
  const goal =
    lastUserMsg.length > 120 ? `${lastUserMsg.slice(0, 120)}…` : lastUserMsg;

  // ── Step 1: announce ─────────────────────────────────────────────────────
  thoughtLog.publish({
    category: "system",
    title:    "Supervisor: Scanning",
    message:  "Scanning message history for task signals…",
    metadata: { messageCount: messages.length, goalPreview: goal.slice(0, 80) },
  });

  // ── Step 2: classify ─────────────────────────────────────────────────────
  const { category, confidence, scores } = classifyCategory(messages);

  thoughtLog.publish({
    category: "system",
    title:    "Supervisor: Scores",
    message:  `Scoring — coding:${scores.coding} sysadmin:${scores.sysadmin} hardware:${scores.hardware} general:${scores.general}`,
    metadata: { scores },
  });

  thoughtLog.publish({
    category: "system",
    title:    "Supervisor: Classification",
    message:  `Classified as '${category}' at ${Math.round(confidence * 100)}% confidence`,
    metadata: { category, confidence, topScore: scores[category] },
  });

  // ── Step 3: plan generation ───────────────────────────────────────────────
  const steps = generateExecutionPlan(category, goal);

  thoughtLog.publish({
    category: "system",
    title:    "Supervisor: Plan",
    message:  `Constructing ${steps.length}-step execution plan for: ${goal.slice(0, 80)}`,
    metadata: { steps },
  });

  // ── Step 4: model selection ───────────────────────────────────────────────
  const suggestedModel = manualOverrideModel ?? (MODEL_PREFERENCES[category][0] ?? "llama3.1");
  const toolset        = TOOLSET_MAP[category];
  const agentName      = agentDisplayName(category);

  thoughtLog.publish({
    category: "system",
    title:    "Supervisor: Routing",
    message:  manualOverrideModel
      ? `Manual override — routing to ${manualOverrideModel} via ${toolset} toolset`
      : `Model selected — ${suggestedModel} via ${toolset} toolset`,
    metadata: {
      suggestedModel,
      toolset,
      agentName,
      manualOverride: !!manualOverrideModel,
    },
  });

  // ── Step 5: update GlobalState ────────────────────────────────────────────
  try {
    stateOrchestrator.setSovereignState({
      activeGoal:             goal,
      activeAgentName:        agentName,
      activeStep:             0,
      currentStepDescription: steps[0],
      totalSteps:             steps.length,
      executionPlan:          steps,
      taskCategory:           category,
    });
  } catch {
    // Non-fatal — state update must never block the pipeline
  }

  // ── Step 6: complete ─────────────────────────────────────────────────────
  thoughtLog.publish({
    category: "system",
    title:    "Supervisor: Ready",
    message:  `Pipeline complete — ${agentName} active, ${steps.length} steps queued`,
    metadata: {
      category,
      agentName,
      suggestedModel,
      toolset,
      confidence,
      steps: steps.length,
    },
  });

  return {
    category,
    goal,
    steps,
    suggestedModel,
    toolset,
    confidence,
    manualOverride: !!manualOverrideModel,
    overrideModel:  manualOverrideModel,
  };
}

// ── Step advancement ──────────────────────────────────────────────────────────

/** Advance the step counter and update the current step description.
 *  Call after completing each step in the execution plan. */
export function advanceSupervisorStep(step: number, plan?: AgentExecutionPlan): void {
  try {
    const currentStepDescription = plan?.steps[step];
    stateOrchestrator.setSovereignState({
      activeStep: step,
      ...(currentStepDescription ? { currentStepDescription } : {}),
    });

    if (currentStepDescription) {
      thoughtLog.publish({
        category: "system",
        title:    `Supervisor: Step ${step + 1}`,
        message:  currentStepDescription,
        metadata: { step, totalSteps: plan?.steps.length },
      });
    }
  } catch { /* non-fatal */ }
}

/** Clear sovereign state when a conversation ends. */
export function clearSupervisorState(): void {
  try {
    stateOrchestrator.setSovereignState({
      activeGoal:             undefined,
      activeAgentName:        undefined,
      activeStep:             0,
      currentStepDescription: undefined,
      totalSteps:             0,
      executionPlan:          [],
      taskCategory:           undefined,
    });
  } catch { /* non-fatal */ }
}

/** Return the display name for the active agent based on the task category. */
export function agentDisplayName(category?: TaskCategory): string {
  const names: Record<TaskCategory, string> = {
    coding:   "Sovereign Coder",
    sysadmin: "Sovereign SysAdmin",
    hardware: "Sovereign CAD/Vision",
    general:  "Sovereign Assistant",
  };
  return category ? (names[category] ?? "Sovereign Assistant") : "Sovereign Assistant";
}
