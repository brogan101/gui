import { useEffect, useRef, useState, type ElementType } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Cpu,
  MemoryStick,
  Target,
  RefreshCw,
  Zap,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Power,
  Activity,
  TrendingUp,
  ChevronRight,
} from "lucide-react";
import api, { type ThoughtEntry } from "../api.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(bytes: number): string {
  if (bytes === 0) return "0 B";
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 ** 2);
  return `${mb.toFixed(0)} MB`;
}

function levelColor(level: ThoughtEntry["level"]): string {
  switch (level) {
    case "error":   return "var(--color-error)";
    case "warning": return "var(--color-warn)";
    case "info":    return "var(--color-info)";
    default:        return "var(--color-muted)";
  }
}

function levelBg(level: ThoughtEntry["level"]): string {
  switch (level) {
    case "error":   return "color-mix(in srgb, var(--color-error) 12%, transparent)";
    case "warning": return "color-mix(in srgb, var(--color-warn) 12%, transparent)";
    case "info":    return "color-mix(in srgb, var(--color-info) 12%, transparent)";
    default:        return "transparent";
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: ElementType;
  accent?: string;
}) {
  const color = accent ?? "var(--color-accent)";
  return (
    <div className="rounded-xl p-4 flex gap-3 items-start"
      style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
      <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 mt-0.5"
        style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}>
        <Icon size={17} style={{ color }} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-xs mb-1" style={{ color: "var(--color-muted)" }}>{label}</div>
        <div className="font-semibold text-sm truncate" style={{ color: "var(--color-foreground)" }}>{value}</div>
        {sub && <div className="text-xs mt-0.5 truncate" style={{ color: "var(--color-muted)" }}>{sub}</div>}
      </div>
    </div>
  );
}

function VramBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const color =
    pct > 85 ? "var(--color-error)" :
    pct > 65 ? "var(--color-warn)"  :
               "var(--color-success)";
  return (
    <div className="mt-2">
      <div className="flex justify-between text-xs mb-1.5" style={{ color: "var(--color-muted)" }}>
        <span>{fmt(used)} used</span>
        <span>{pct.toFixed(0)}%</span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--color-border)" }}>
        <div className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="text-xs mt-1 text-right" style={{ color: "var(--color-muted)" }}>{fmt(total)} total</div>
    </div>
  );
}

function ExecutionPlan({ steps, activeStep }: { steps: string[]; activeStep: number }) {
  if (!steps.length) return null;
  return (
    <ol className="space-y-1.5 mt-3">
      {steps.map((step, i) => {
        const done = i < activeStep;
        const active = i === activeStep;
        return (
          <li key={i} className="flex items-start gap-2.5 text-sm">
            <div className="flex-shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold mt-0.5"
              style={{
                background: done
                  ? "var(--color-success)"
                  : active
                    ? "var(--color-accent)"
                    : "var(--color-border)",
                color: done || active ? "#fff" : "var(--color-muted)",
              }}>
              {done ? "✓" : i + 1}
            </div>
            <span style={{ color: done ? "var(--color-muted)" : active ? "var(--color-foreground)" : "var(--color-muted)" }}>
              {step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ── Thought log (SSE) ─────────────────────────────────────────────────────────

function ThoughtLog() {
  const [entries, setEntries] = useState<ThoughtEntry[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Initial fetch
  const { data } = useQuery({
    queryKey: ["thoughts"],
    queryFn: () => api.observability.thoughts(50),
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (data?.entries) {
      setEntries(data.entries.slice(-50));
    }
  }, [data]);

  // SSE stream
  useEffect(() => {
    const es = api.observability.streamThoughts();
    es.onmessage = (e) => {
      try {
        const entry = JSON.parse(e.data) as ThoughtEntry;
        setEntries(prev => {
          const next = [...prev, entry];
          return next.length > 200 ? next.slice(-200) : next;
        });
      } catch { /* ignore malformed */ }
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 mb-3">
        <Activity size={15} style={{ color: "var(--color-accent)" }} />
        <span className="text-sm font-medium" style={{ color: "var(--color-foreground)" }}>Thought Log</span>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full pulse-dot" style={{ background: "var(--color-success)" }} />
          <span className="text-xs" style={{ color: "var(--color-muted)" }}>live</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto space-y-1 pr-1 text-xs font-mono"
        style={{ maxHeight: 320 }}>
        {entries.length === 0 && (
          <div className="py-6 text-center" style={{ color: "var(--color-muted)" }}>
            No log entries yet
          </div>
        )}
        {entries.map((entry, idx) => (
          <div key={entry.id ?? idx}
            className="flex gap-2 p-1.5 rounded slide-in"
            style={{ background: levelBg(entry.level) }}>
            <span style={{ color: levelColor(entry.level), flexShrink: 0 }}>
              [{entry.level.toUpperCase().slice(0, 4)}]
            </span>
            <span style={{ color: "var(--color-muted)", flexShrink: 0 }}>
              {entry.category}
            </span>
            <span className="flex-1 truncate" style={{ color: "var(--color-foreground)" }}>
              {entry.title}: {entry.message}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ── Running models strip ───────────────────────────────────────────────────────

function RunningModels() {
  const { data } = useQuery({
    queryKey: ["running"],
    queryFn: () => api.models.running(),
    refetchInterval: 10_000,
  });

  const models = data?.models ?? [];
  if (!models.length) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {models.map(m => (
        <div key={m.name}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium"
          style={{ background: "color-mix(in srgb, var(--color-success) 12%, transparent)", color: "var(--color-success)", border: "1px solid color-mix(in srgb, var(--color-success) 25%, transparent)" }}>
          <div className="w-1.5 h-1.5 rounded-full pulse-dot" style={{ background: "var(--color-success)" }} />
          {m.name}
          <span className="opacity-60">· {m.sizeVramFormatted}</span>
        </div>
      ))}
    </div>
  );
}

// ── Capability badges ─────────────────────────────────────────────────────────

function CapabilityBadges({ capabilities }: { capabilities: Record<string, { enabled: boolean; active: boolean; phase: string }> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {Object.entries(capabilities).map(([id, cap]) => (
        <div key={id}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-xs"
          style={{
            background: cap.active
              ? "color-mix(in srgb, var(--color-accent) 15%, transparent)"
              : cap.enabled
                ? "var(--color-elevated)"
                : "var(--color-border)",
            color: cap.active ? "var(--color-accent)" : cap.enabled ? "var(--color-foreground)" : "var(--color-muted)",
            border: `1px solid ${cap.active ? "color-mix(in srgb, var(--color-accent) 30%, transparent)" : "var(--color-border)"}`,
          }}>
          {cap.active && <div className="w-1 h-1 rounded-full pulse-dot" style={{ background: "var(--color-accent)" }} />}
          {id}
        </div>
      ))}
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const qc = useQueryClient();

  const { data: kernel } = useQuery({
    queryKey: ["kernel"],
    queryFn: () => api.kernel.getState(),
    refetchInterval: 8_000,
  });

  const { data: tags } = useQuery({
    queryKey: ["tags"],
    queryFn: () => api.models.tags(),
    refetchInterval: 15_000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => api.models.refresh(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["kernel"] });
      void qc.invalidateQueries({ queryKey: ["tags"] });
      void qc.invalidateQueries({ queryKey: ["running"] });
    },
  });

  const killMutation = useMutation({
    mutationFn: () => api.system.killSwitch(),
  });

  const state = kernel?.state;
  const sovereign = state?.sovereign;
  const vramGuard = tags?.vramGuard;

  const categoryColor =
    sovereign?.taskCategory === "coding"   ? "var(--color-info)"    :
    sovereign?.taskCategory === "sysadmin" ? "var(--color-warn)"    :
    sovereign?.taskCategory === "hardware" ? "var(--color-success)"  :
                                             "var(--color-accent)";

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 shrink-0"
        style={{ borderBottom: "1px solid var(--color-border)" }}>
        <div>
          <h1 className="font-bold text-lg" style={{ color: "var(--color-foreground)" }}>
            Sovereign Dashboard
          </h1>
          <p className="text-xs mt-0.5" style={{ color: "var(--color-muted)" }}>
            Local AI control center — {sovereign?.catalogModelCount ?? 0} models indexed
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-opacity disabled:opacity-50"
            style={{ background: "var(--color-elevated)", color: "var(--color-foreground)", border: "1px solid var(--color-border)" }}>
            <RefreshCw size={13} className={refreshMutation.isPending ? "animate-spin" : ""} />
            Sync Catalog
          </button>
          <button
            onClick={() => {
              if (window.confirm("Invoke kill-switch? This will terminate all AI processes.")) {
                killMutation.mutate();
              }
            }}
            disabled={killMutation.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-opacity disabled:opacity-50"
            style={{ background: "color-mix(in srgb, var(--color-error) 15%, transparent)", color: "var(--color-error)", border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)" }}>
            <Power size={13} />
            Kill Switch
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-3 mb-6" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
          <StatCard
            label="Active Capability"
            value={state?.activeCapability ?? "Idle"}
            sub={`${Object.values(state?.capabilities ?? {}).filter(c => c.active).length} active`}
            icon={Zap}
          />
          <StatCard
            label="VRAM Guard"
            value={vramGuard ? `${vramGuard.mode}` : "—"}
            sub={vramGuard?.status === "healthy" ? "Healthy" : vramGuard?.status ?? "—"}
            icon={MemoryStick}
            accent={vramGuard?.status === "healthy" ? "var(--color-success)" : "var(--color-warn)"}
          />
          <StatCard
            label="Catalog"
            value={`${sovereign?.catalogModelCount ?? 0} models`}
            sub={sovereign?.lastCatalogSync ? `Synced ${new Date(sovereign.lastCatalogSync).toLocaleTimeString()}` : "Not synced"}
            icon={Cpu}
          />
          <StatCard
            label="Task Category"
            value={sovereign?.taskCategory ? sovereign.taskCategory.charAt(0).toUpperCase() + sovereign.taskCategory.slice(1) : "Idle"}
            sub={sovereign?.activeGoal ? `${sovereign.activeStep + 1}/${sovereign.totalSteps} steps` : "No active goal"}
            icon={Target}
            accent={categoryColor}
          />
        </div>

        {/* Two-column layout: left = VRAM + running + capabilities; right = agent goal + thought log */}
        <div className="grid gap-4" style={{ gridTemplateColumns: "1fr 1.5fr" }}>
          {/* Left column */}
          <div className="space-y-4">
            {/* VRAM Panel */}
            <div className="rounded-xl p-4"
              style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
              <div className="flex items-center gap-2 mb-1">
                <MemoryStick size={14} style={{ color: "var(--color-accent)" }} />
                <span className="text-sm font-medium" style={{ color: "var(--color-foreground)" }}>VRAM Budget</span>
                <span className="ml-auto text-xs px-1.5 py-0.5 rounded"
                  style={{
                    background: vramGuard?.status === "healthy"
                      ? "color-mix(in srgb, var(--color-success) 15%, transparent)"
                      : "color-mix(in srgb, var(--color-warn) 15%, transparent)",
                    color: vramGuard?.status === "healthy" ? "var(--color-success)" : "var(--color-warn)",
                  }}>
                  {vramGuard?.mode ?? "safe-mode"}
                </span>
              </div>
              {vramGuard?.gpuName && (
                <div className="text-xs mb-2" style={{ color: "var(--color-muted)" }}>{vramGuard.gpuName}</div>
              )}
              {vramGuard && (
                <VramBar
                  used={(vramGuard.totalBytes ?? 0) - (vramGuard.freeBytes ?? 0)}
                  total={vramGuard.totalBytes ?? 0}
                />
              )}
              <div className="mt-3 pt-3 flex gap-4 text-xs" style={{ borderTop: "1px solid var(--color-border)", color: "var(--color-muted)" }}>
                <div>
                  <div>Safe Budget</div>
                  <div style={{ color: "var(--color-foreground)" }}>{fmt(vramGuard?.safeBudgetBytes ?? 0)}</div>
                </div>
                <div>
                  <div>Reserve</div>
                  <div style={{ color: "var(--color-foreground)" }}>{fmt(vramGuard?.reserveBytes ?? 0)}</div>
                </div>
              </div>
            </div>

            {/* Running models */}
            <div className="rounded-xl p-4"
              style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp size={14} style={{ color: "var(--color-success)" }} />
                <span className="text-sm font-medium" style={{ color: "var(--color-foreground)" }}>Running Models</span>
              </div>
              <RunningModels />
            </div>

            {/* Capabilities */}
            {state?.capabilities && Object.keys(state.capabilities).length > 0 && (
              <div className="rounded-xl p-4"
                style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
                <div className="flex items-center gap-2 mb-3">
                  <Zap size={14} style={{ color: "var(--color-accent)" }} />
                  <span className="text-sm font-medium" style={{ color: "var(--color-foreground)" }}>Capabilities</span>
                </div>
                <CapabilityBadges capabilities={state.capabilities} />
              </div>
            )}
          </div>

          {/* Right column */}
          <div className="space-y-4">
            {/* Agent Goal */}
            <div className="rounded-xl p-4"
              style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
              <div className="flex items-center gap-2 mb-1">
                <Target size={14} style={{ color: categoryColor }} />
                <span className="text-sm font-medium" style={{ color: "var(--color-foreground)" }}>Agent Goal</span>
                {sovereign?.taskCategory && (
                  <span className="ml-auto text-xs px-1.5 py-0.5 rounded capitalize"
                    style={{
                      background: `color-mix(in srgb, ${categoryColor} 15%, transparent)`,
                      color: categoryColor,
                    }}>
                    {sovereign.taskCategory}
                  </span>
                )}
              </div>

              {sovereign?.activeGoal ? (
                <>
                  <p className="text-sm mt-2" style={{ color: "var(--color-foreground)" }}>
                    {sovereign.activeGoal}
                  </p>
                  <ExecutionPlan steps={sovereign.executionPlan} activeStep={sovereign.activeStep} />
                </>
              ) : (
                <p className="text-sm mt-2" style={{ color: "var(--color-muted)" }}>
                  No active goal. Send a message in Chat to activate the Supervisor Agent.
                </p>
              )}
            </div>

            {/* Thought Log */}
            <div className="rounded-xl p-4 flex-1"
              style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
              <ThoughtLog />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
