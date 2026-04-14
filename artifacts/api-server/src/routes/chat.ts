import { Router } from "express";
import { mkdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

import {
  getUniversalGatewayTags,
  streamGatewayChatToSse,
  sendGatewayChat,
  queueUniversalModelPull,
  unloadOllamaModel,
  getRunningGatewayModels,
} from "../lib/model-orchestrator.js";
import { workspaceContextService } from "../lib/code-context.js";
import { writeManagedJson } from "../lib/snapshot-manager.js";
import { thoughtLog } from "../lib/thought-log.js";
import { toolsRoot } from "../lib/runtime.js";
import {
  analyzeMessages,
  activateSupervisorPlan,
  agentDisplayName,
} from "../lib/supervisor-agent.js";

const router = Router();

const HISTORY_DIR = path.join(toolsRoot(), "chat-history");

async function ensureHistoryDir(): Promise<void> {
  if (!existsSync(HISTORY_DIR)) {
    await mkdir(HISTORY_DIR, { recursive: true });
  }
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function maybeBuildCodeContext(
  messages: ChatMessage[],
  workspacePath: string | undefined,
  useCodeContext: boolean | undefined
) {
  if (!useCodeContext) return null;
  const latestUserMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user")
    ?.content?.trim();
  if (!latestUserMessage) return null;
  try {
    return await workspaceContextService.search(latestUserMessage, workspacePath, 6, 12000);
  } catch {
    return null;
  }
}

function contextSystemPrompt(context: NonNullable<Awaited<ReturnType<typeof maybeBuildCodeContext>>>): string {
  return [
    `You are helping with the workspace "${context.workspace.workspaceName}" at ${context.workspace.rootPath}.`,
    "Use the provided indexed code context before making assumptions.",
    "If the answer depends on code not shown in the context window, say what additional file should be read next.",
    "",
    context.promptContext,
  ].join("\n");
}

function contextMetadata(context: NonNullable<Awaited<ReturnType<typeof maybeBuildCodeContext>>>) {
  return {
    workspaceName: context.workspace.workspaceName,
    workspacePath: context.workspace.rootPath,
    fileCount: context.files.length,
    sectionCount: context.sections.length,
    files: context.files.map((file) => ({
      path: file.path,
      relativePath: file.relativePath,
      score: file.score,
      matchedSymbols: file.matchedSymbols.map((symbol) => `${symbol.kind} ${symbol.name}`),
    })),
  };
}

// GET /chat/models
router.get("/chat/models", async (_req, res) => {
  const gateway = await getUniversalGatewayTags();
  return res.json({
    models: gateway.models.map((model) => ({
      name: model.name,
      paramSize: model.parameterSize,
    })),
    ollamaReachable: gateway.ollamaReachable,
    vramGuard: gateway.vramGuard,
  });
});

// POST /chat/send
router.post("/chat/send", async (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  const workspacePath = typeof body.workspacePath === "string" ? body.workspacePath : undefined;
  const useCodeContext = typeof body.useCodeContext === "boolean" ? body.useCodeContext : undefined;
  const messages: ChatMessage[] = Array.isArray(body.messages)
    ? (body.messages as unknown[]).filter(
        (message): message is ChatMessage =>
          !!message &&
          typeof message === "object" &&
          message !== null &&
          "role" in message &&
          ["system", "user", "assistant"].includes((message as Record<string, unknown>).role as string) &&
          "content" in message &&
          typeof (message as Record<string, unknown>).content === "string"
      )
    : [];

  if (!messages.length) {
    return res.status(400).json({ success: false, message: "messages required" });
  }

  try {
    // Supervisor analysis — determines task category, plan, and model routing
    const supervisorPlan = analyzeMessages(messages, model || undefined);
    await activateSupervisorPlan(supervisorPlan);
    // Use supervisor's suggested model when no manual override was provided
    const resolvedModel = model || supervisorPlan.suggestedModel;

    const codeContext = await maybeBuildCodeContext(messages, workspacePath, useCodeContext);
    const upstreamMessages: ChatMessage[] = codeContext
      ? [{ role: "system" as const, content: contextSystemPrompt(codeContext) }, ...messages]
      : messages;

    thoughtLog.publish({
      category: "chat",
      title: "Chat Request",
      message: `${agentDisplayName(supervisorPlan.category)} handling request${resolvedModel ? ` via ${resolvedModel}` : ""}`,
      metadata: {
        workspacePath,
        useCodeContext: !!useCodeContext,
        contextAttached: !!codeContext,
        supervisorCategory: supervisorPlan.category,
        supervisorConfidence: supervisorPlan.confidence,
        manualOverride: supervisorPlan.manualOverride,
      },
    });

    const result = await sendGatewayChat(upstreamMessages, resolvedModel || undefined);
    const assistantMsg: ChatMessage = { role: "assistant", content: result.message };
    const persistedModel = result.model;

    if (sessionId) {
      await ensureHistoryDir();
      const file = path.join(HISTORY_DIR, `${sessionId}.json`);
      const existing = existsSync(file)
        ? JSON.parse(await readFile(file, "utf-8"))
        : {
            id: sessionId,
            model: persistedModel,
            messages: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
      const session = {
        ...existing,
        model: persistedModel,
        messages: [...messages, assistantMsg],
        updatedAt: new Date().toISOString(),
      };
      await writeManagedJson(file, session);
    }

    return res.json({
      success: true,
      model: result.model,
      route: result.route,
      message: assistantMsg,
      sessionId: sessionId || undefined,
      context: codeContext ? contextMetadata(codeContext) : null,
      supervisor: {
        category:    supervisorPlan.category,
        agentName:   agentDisplayName(supervisorPlan.category),
        goal:        supervisorPlan.goal,
        steps:       supervisorPlan.steps,
        confidence:  supervisorPlan.confidence,
        manualOverride: supervisorPlan.manualOverride,
        toolset:     supervisorPlan.toolset,
      },
    });
  } catch (error) {
    return res
      .status(500)
      .json({ success: false, message: error instanceof Error ? error.message : String(error) });
  }
});

// POST /chat/stream
router.post("/chat/stream", async (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const workspacePath = typeof body.workspacePath === "string" ? body.workspacePath : undefined;
  const useCodeContext = typeof body.useCodeContext === "boolean" ? body.useCodeContext : undefined;
  const messages: ChatMessage[] = Array.isArray(body.messages)
    ? (body.messages as unknown[]).filter(
        (message): message is ChatMessage =>
          !!message &&
          typeof message === "object" &&
          message !== null &&
          "role" in message &&
          ["system", "user", "assistant"].includes((message as Record<string, unknown>).role as string) &&
          "content" in message &&
          typeof (message as Record<string, unknown>).content === "string"
      )
    : [];

  if (!messages.length) {
    return res.status(400).json({ success: false, message: "messages required" });
  }

  try {
    // Supervisor analysis
    const supervisorPlan = analyzeMessages(messages, model || undefined);
    await activateSupervisorPlan(supervisorPlan);
    const resolvedModel = model || supervisorPlan.suggestedModel;

    const codeContext = await maybeBuildCodeContext(messages, workspacePath, useCodeContext);
    const upstreamMessages: ChatMessage[] = codeContext
      ? [{ role: "system" as const, content: contextSystemPrompt(codeContext) }, ...messages]
      : messages;

    thoughtLog.publish({
      category: "chat",
      title: "Streaming Chat Request",
      message: `${agentDisplayName(supervisorPlan.category)} streaming via ${resolvedModel || "auto-routed model"}`,
      metadata: {
        workspacePath,
        useCodeContext: !!useCodeContext,
        contextAttached: !!codeContext,
        supervisorCategory: supervisorPlan.category,
        supervisorConfidence: supervisorPlan.confidence,
      },
    });

    const supervisorPayload = {
      supervisor: {
        category:   supervisorPlan.category,
        agentName:  agentDisplayName(supervisorPlan.category),
        goal:       supervisorPlan.goal,
        steps:      supervisorPlan.steps,
        confidence: supervisorPlan.confidence,
        toolset:    supervisorPlan.toolset,
      },
    };

    await streamGatewayChatToSse(res, {
      messages: upstreamMessages,
      requestedModel: resolvedModel || undefined,
      initialPayloads: [
        supervisorPayload,
        ...(codeContext ? [{ context: contextMetadata(codeContext) }] : []),
      ],
    });
  } catch (error) {
    if (res.writableEnded || res.destroyed) {
      return;
    }
    if (!res.headersSent) {
      return res
        .status(500)
        .json({ success: false, message: error instanceof Error ? error.message : String(error) });
    }
    res.write(`data: ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  }
  return;
});

// POST /chat/assistant
router.post("/chat/assistant", async (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const context = typeof body.context === "string" ? body.context : "";
  const workspacePath = typeof body.workspacePath === "string" ? body.workspacePath : undefined;
  const useCodeContext = typeof body.useCodeContext === "boolean" ? body.useCodeContext : undefined;

  if (!prompt) {
    return res.status(400).json({ success: false, message: "prompt required" });
  }

  try {
    const codeContext = await maybeBuildCodeContext(
      [{ role: "user", content: prompt }],
      workspacePath,
      useCodeContext
    );

    const systemPrompt = `You are a concise local AI assistant embedded in LocalAI Control Center.
Help manage configuration, write rules files, and answer questions about the local AI stack.
Be direct and actionable. Return JSON when asked to produce structured data.
${context ? `Current context:\n${context}` : ""}
${codeContext ? `Indexed workspace context:\n${codeContext.promptContext}` : ""}`;

    const result = await sendGatewayChat(
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt },
      ],
      undefined
    );

    return res.json({
      success: true,
      result: result.message,
      model: result.model,
      route: result.route,
      context: codeContext ? contextMetadata(codeContext) : null,
    });
  } catch (error) {
    return res.json({
      success: false,
      message: error instanceof Error ? error.message : String(error),
      result: null,
    });
  }
});

// POST /chat/command
router.post("/chat/command", async (req, res) => {
  const body = typeof req.body === "object" && req.body !== null ? req.body : {};
  const command = typeof body.command === "string" ? body.command.trim() : "";

  if (!command) {
    return res.status(400).json({ success: false, message: "command required" });
  }

  const cmd = command.toLowerCase();

  const installMatch = cmd.match(/^\/(install|pull)\s+(.+)/);
  if (installMatch) {
    const modelName = installMatch[2].trim();
    const job = queueUniversalModelPull(modelName);
    return res.json({
      success: true,
      action: "install",
      modelName,
      jobId: job.id,
      message: `Queued pull for ${modelName}. Check the Models page for progress.`,
    });
  }

  const stopMatch = cmd.match(/^\/stop\s+(.+)/);
  if (stopMatch) {
    const modelName = stopMatch[1].trim();
    try {
      await unloadOllamaModel(modelName);
      return res.json({ success: true, action: "stop", modelName, message: `${modelName} unloaded from VRAM.` });
    } catch (error) {
      return res.json({ success: false, message: error instanceof Error ? error.message : String(error) });
    }
  }

  if (cmd === "/models") {
    const gateway = await getUniversalGatewayTags();
    const names = gateway.models.map((model) => model.name);
    return res.json({
      success: true,
      action: "list",
      message: names.length
        ? `Installed models:\n${names.map((name) => `\u2022 ${name}`).join("\n")}`
        : "No models installed.",
    });
  }

  if (cmd === "/status") {
    const [gateway, running] = await Promise.all([getUniversalGatewayTags(), getRunningGatewayModels()]);
    return res.json({
      success: true,
      action: "status",
      message: `**System Status**\nOllama: ${gateway.ollamaReachable ? "running" : "offline"}\nVRAM Guard: ${gateway.vramGuard.mode} (${gateway.vramGuard.status})${
        running.models.length
          ? `\nActive models: ${running.models.map((model) => model.name).join(", ")}`
          : "\nNo models loaded in VRAM"
      }`,
    });
  }

  if (cmd === "/index") {
    const workspaces = await workspaceContextService.refreshKnownWorkspaces("manual");
    return res.json({
      success: true,
      action: "index",
      message: `Code context index refreshed for ${workspaces.length} workspace(s).`,
    });
  }

  if (cmd === "/help") {
    return res.json({
      success: true,
      action: "help",
      message: `**Chat Commands:**\n\u2022 \`/install <model>\` \u2014 queue a model pull\n\u2022 \`/stop <model>\` \u2014 unload a model from VRAM\n\u2022 \`/models\` \u2014 list installed models\n\u2022 \`/status\` \u2014 show system status\n\u2022 \`/index\` \u2014 refresh the code context index\n\u2022 \`/help\` \u2014 show this message`,
    });
  }

  return res.json({
    success: false,
    message: `Unknown command: ${command}. Type /help to see available commands.`,
  });
});

export default router;
