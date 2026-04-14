import { Router } from "express";
import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { toolsRoot, ensureDir } from "../lib/runtime.js";
import { writeManagedJson } from "../lib/snapshot-manager.js";
import { loadSettings, saveSettings } from "../lib/secure-config.js";

const router = Router();
const USAGE_DIR = path.join(toolsRoot(), "usage");

const DEFAULT_SETTINGS = {
  tokenWarningThreshold: 50000,
  dailyTokenLimit: 200000,
  defaultChatModel: "",
  defaultCodingModel: "",
  autoStartOllama: true,
  showTokenCounts: true,
  chatHistoryDays: 30,
  theme: "dark",
  notificationsEnabled: true,
  modelDownloadPath: "",
  preferredInstallMethod: "pip",
};

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function usageFile(d: string): string {
  return path.join(USAGE_DIR, `${d}.json`);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function loadDay(date: string): Promise<any> {
  if (existsSync(usageFile(date))) {
    try {
      return JSON.parse(await readFile(usageFile(date), "utf-8"));
    } catch {}
  }
  return { date, totalTokens: 0, totalRequests: 0, byModel: {}, sessions: [] };
}

async function saveDay(day: any): Promise<void> {
  await ensureDir(USAGE_DIR);
  await writeManagedJson(usageFile(day.date), day);
}

async function loadAppSettings(): Promise<any> {
  try {
    return await loadSettings();
  } catch {}
  return DEFAULT_SETTINGS;
}

router.post("/usage/record", async (req, res) => {
  const { model, inputText, outputText, inputTokens: rawIn, outputTokens: rawOut, durationMs = 0, sessionId } = req.body;
  if (!model) return res.status(400).json({ success: false, message: "model required" });
  const inputTokens = rawIn ?? (inputText ? estimateTokens(inputText) : 0);
  const outputTokens = rawOut ?? (outputText ? estimateTokens(outputText) : 0);
  const totalTokens = inputTokens + outputTokens;
  const today = todayKey();
  const day = await loadDay(today);
  day.totalTokens += totalTokens;
  day.totalRequests += 1;
  if (!day.byModel[model]) {
    day.byModel[model] = { tokens: 0, requests: 0, avgMs: 0, inputTokens: 0, outputTokens: 0 };
  }
  const m = day.byModel[model];
  m.tokens += totalTokens;
  m.inputTokens = (m.inputTokens || 0) + inputTokens;
  m.outputTokens = (m.outputTokens || 0) + outputTokens;
  m.requests += 1;
  m.avgMs = Math.round((m.avgMs * (m.requests - 1) + durationMs) / m.requests);
  if (sessionId) {
    const existing = day.sessions.find((s: any) => s.sessionId === sessionId);
    if (existing) {
      existing.tokens += totalTokens;
      existing.inputTokens = (existing.inputTokens || 0) + inputTokens;
      existing.outputTokens = (existing.outputTokens || 0) + outputTokens;
      existing.messageCount = (existing.messageCount || 0) + 1;
      existing.endedAt = new Date().toISOString();
    } else {
      day.sessions.push({ sessionId, model, tokens: totalTokens, inputTokens, outputTokens, messageCount: 1, startedAt: new Date().toISOString() });
    }
  }
  await saveDay(day);
  const settings = await loadAppSettings();
  const limitHit = settings.dailyTokenLimit > 0 && day.totalTokens >= settings.dailyTokenLimit;
  const warnHit = settings.tokenWarningThreshold > 0 && day.totalTokens >= settings.tokenWarningThreshold;
  return res.json({
    success: true,
    inputTokens,
    outputTokens,
    totalTokens,
    todayTotal: day.totalTokens,
    limitHit,
    warnHit,
    remainingToday: Math.max(0, settings.dailyTokenLimit - day.totalTokens),
  });
});

router.get("/usage/today", async (_req, res) => {
  const settings = await loadAppSettings();
  const day = await loadDay(todayKey());
  const topModels = Object.entries(day.byModel)
    .sort((a: any, b: any) => b[1].tokens - a[1].tokens)
    .slice(0, 5)
    .map(([name, stats]) => ({ name, ...(stats as any) }));
  return res.json({
    ...day,
    topModels,
    limitHit: settings.dailyTokenLimit > 0 && day.totalTokens >= settings.dailyTokenLimit,
    warnHit: settings.tokenWarningThreshold > 0 && day.totalTokens >= settings.tokenWarningThreshold,
    dailyLimit: settings.dailyTokenLimit,
    warningThreshold: settings.tokenWarningThreshold,
    remaining: Math.max(0, settings.dailyTokenLimit - day.totalTokens),
    utilizationPct: settings.dailyTokenLimit > 0 ? Math.min(100, Math.round((day.totalTokens / settings.dailyTokenLimit) * 100)) : 0,
  });
});

router.get("/usage/history", async (req, res) => {
  const days = Math.min(Number(req.query.days) || 7, 30);
  const history: any[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    history.push(await loadDay(d.toISOString().slice(0, 10)));
  }
  const totalTokens = history.reduce((s, d) => s + d.totalTokens, 0);
  const totalRequests = history.reduce((s, d) => s + d.totalRequests, 0);
  const nonZero = history.filter((d) => d.totalTokens > 0);
  const peakDay = nonZero.length ? nonZero.reduce((a, b) => (a.totalTokens > b.totalTokens ? a : b)) : null;
  const allModels: Record<string, number> = {};
  for (const day of history) {
    for (const [name, stats] of Object.entries(day.byModel)) {
      allModels[name] = (allModels[name] || 0) + (stats as any).tokens;
    }
  }
  const topModel = Object.entries(allModels).sort((a, b) => b[1] - a[1])[0];
  return res.json({
    history,
    days,
    totalTokens,
    totalRequests,
    averageDailyTokens: days > 0 ? Math.round(totalTokens / days) : 0,
    peakDay: peakDay ? { date: peakDay.date, tokens: peakDay.totalTokens } : null,
    topModel: topModel ? { name: topModel[0], tokens: topModel[1] } : null,
  });
});

router.get("/usage/estimate", async (req, res) => {
  const text = String(req.query.text || "");
  return res.json({ estimatedTokens: estimateTokens(text), chars: text.length });
});

router.delete("/usage/purge", async (req, res) => {
  const settings = await loadAppSettings();
  const olderThanDays = Number(req.query.olderThanDays) || settings.chatHistoryDays || 30;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - olderThanDays);
  if (!existsSync(USAGE_DIR)) return res.json({ success: true, removed: 0 });
  const files = await readdir(USAGE_DIR);
  let removed = 0;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const date = file.replace(".json", "");
    if (new Date(date) < cutoff) {
      const { unlink } = await import("fs/promises");
      await unlink(path.join(USAGE_DIR, file)).catch(() => {});
      removed++;
    }
  }
  return res.json({ success: true, removed, cutoffDate: cutoff.toISOString().slice(0, 10) });
});

router.get("/settings", async (_req, res) => {
  return res.json({ settings: await loadAppSettings() });
});

router.put("/settings", async (req, res) => {
  const current = await loadAppSettings();
  const updated = { ...current, ...req.body };
  const saved = await saveSettings(updated);
  return res.json({ success: true, settings: saved });
});

export default router;
