import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  Play,
  Square,
  Trash2,
  RefreshCw,
  Search,
  Cpu,
  CheckCircle,
  AlertTriangle,
  Loader2,
  X,
} from "lucide-react";
import api, { type ModelListItem } from "../api.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function statusColor(m: ModelListItem): string {
  if (m.isRunning) return "var(--color-success)";
  if (m.vramWarning) return "var(--color-warn)";
  if (m.lastError) return "var(--color-error)";
  return "var(--color-muted)";
}

function lifecycleBadge(lifecycle: string) {
  const map: Record<string, { bg: string; color: string }> = {
    stable:      { bg: "color-mix(in srgb, var(--color-success) 12%, transparent)", color: "var(--color-success)" },
    running:     { bg: "color-mix(in srgb, var(--color-success) 20%, transparent)", color: "var(--color-success)" },
    downloading: { bg: "color-mix(in srgb, var(--color-info) 12%, transparent)", color: "var(--color-info)" },
    error:       { bg: "color-mix(in srgb, var(--color-error) 12%, transparent)", color: "var(--color-error)" },
    warning:     { bg: "color-mix(in srgb, var(--color-warn) 12%, transparent)", color: "var(--color-warn)" },
  };
  const style = map[lifecycle] ?? { bg: "var(--color-elevated)", color: "var(--color-muted)" };
  return (
    <span className="px-1.5 py-0.5 rounded text-xs font-medium capitalize"
      style={{ background: style.bg, color: style.color }}>
      {lifecycle}
    </span>
  );
}

// ── Pull progress overlay ─────────────────────────────────────────────────────

function PullProgress({ onClose }: { onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ["pullStatus"],
    queryFn: () => api.models.pullStatus(),
    refetchInterval: 2_000,
  });

  const jobs = data?.jobs ?? [];
  const active = jobs.filter(j => j.status === "running" || j.status === "queued");

  if (!active.length) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-72 rounded-xl shadow-xl overflow-hidden"
      style={{ background: "var(--color-elevated)", border: "1px solid var(--color-border)" }}>
      <div className="flex items-center justify-between px-3 py-2.5"
        style={{ borderBottom: "1px solid var(--color-border)" }}>
        <div className="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--color-foreground)" }}>
          <Download size={13} style={{ color: "var(--color-info)" }} />
          Pulling models
        </div>
        <button onClick={onClose} style={{ color: "var(--color-muted)" }}>
          <X size={13} />
        </button>
      </div>
      <div className="p-3 space-y-3">
        {active.map(job => (
          <div key={job.jobId}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="truncate font-medium" style={{ color: "var(--color-foreground)" }}>{job.modelName}</span>
              <span style={{ color: "var(--color-muted)" }}>{job.progress}%</span>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--color-border)" }}>
              <div className="h-full rounded-full transition-all"
                style={{ width: `${job.progress}%`, background: "var(--color-info)" }} />
            </div>
            <div className="text-xs mt-0.5" style={{ color: "var(--color-muted)" }}>{job.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Model row ─────────────────────────────────────────────────────────────────

function ModelRow({ model }: { model: ModelListItem }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["modelList"] });
    void qc.invalidateQueries({ queryKey: ["running"] });
    void qc.invalidateQueries({ queryKey: ["pullStatus"] });
  };

  const loadMut = useMutation({ mutationFn: () => api.models.load(model.name), onSuccess: refresh });
  const stopMut = useMutation({ mutationFn: () => api.models.stop(model.name), onSuccess: refresh });
  const delMut  = useMutation({
    mutationFn: () => api.models.delete(model.name),
    onSuccess: () => { refresh(); setConfirm(false); },
  });

  const busy = loadMut.isPending || stopMut.isPending || delMut.isPending;

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg transition-colors"
      style={{
        background: model.isRunning
          ? "color-mix(in srgb, var(--color-success) 6%, var(--color-surface))"
          : "var(--color-surface)",
        border: `1px solid ${model.isRunning ? "color-mix(in srgb, var(--color-success) 20%, var(--color-border))" : "var(--color-border)"}`,
      }}>

      {/* Status dot */}
      <div className="w-2 h-2 rounded-full shrink-0"
        style={{
          background: statusColor(model),
          boxShadow: model.isRunning ? `0 0 6px ${statusColor(model)}` : "none",
        }} />

      {/* Name + meta */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm truncate" style={{ color: "var(--color-foreground)" }}>
            {model.name}
          </span>
          {lifecycleBadge(model.isRunning ? "running" : model.lifecycle)}
          {model.vramWarning && (
            <span className="text-xs" style={{ color: "var(--color-warn)" }}>
              <AlertTriangle size={11} className="inline mr-0.5" />VRAM
            </span>
          )}
          {model.updateAvailable && (
            <span className="text-xs px-1.5 py-0.5 rounded"
              style={{ background: "color-mix(in srgb, var(--color-info) 12%, transparent)", color: "var(--color-info)" }}>
              update
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs" style={{ color: "var(--color-muted)" }}>
          <span>{model.sizeFormatted}</span>
          {model.parameterSize && <span>{model.parameterSize}</span>}
          {model.quantizationLevel && <span>{model.quantizationLevel}</span>}
          {model.routeAffinity && <span className="capitalize">{model.routeAffinity}</span>}
          {model.isRunning && (
            <span style={{ color: "var(--color-success)" }}>VRAM: {model.sizeVramFormatted}</span>
          )}
        </div>
        {model.lastError && (
          <div className="text-xs mt-0.5 truncate" style={{ color: "var(--color-error)" }}>{model.lastError}</div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 shrink-0">
        {model.isRunning ? (
          <button
            onClick={() => stopMut.mutate()}
            disabled={busy}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-xs transition-opacity disabled:opacity-40"
            style={{ background: "color-mix(in srgb, var(--color-warn) 12%, transparent)", color: "var(--color-warn)", border: "1px solid color-mix(in srgb, var(--color-warn) 25%, transparent)" }}>
            {stopMut.isPending ? <Loader2 size={11} className="animate-spin" /> : <Square size={11} />}
            Unload
          </button>
        ) : (
          <button
            onClick={() => loadMut.mutate()}
            disabled={busy}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-xs transition-opacity disabled:opacity-40"
            style={{ background: "color-mix(in srgb, var(--color-success) 12%, transparent)", color: "var(--color-success)", border: "1px solid color-mix(in srgb, var(--color-success) 25%, transparent)" }}>
            {loadMut.isPending ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
            Load
          </button>
        )}

        {confirm ? (
          <div className="flex items-center gap-1">
            <button
              onClick={() => delMut.mutate()}
              disabled={busy}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs"
              style={{ background: "var(--color-error)", color: "#fff" }}>
              {delMut.isPending ? <Loader2 size={11} className="animate-spin" /> : "Confirm"}
            </button>
            <button onClick={() => setConfirm(false)} className="px-2 py-1 rounded text-xs"
              style={{ background: "var(--color-elevated)", color: "var(--color-muted)" }}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirm(true)}
            disabled={busy}
            className="p-1.5 rounded transition-opacity disabled:opacity-40"
            style={{ color: "var(--color-muted)" }}
            title="Delete model">
            <Trash2 size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Pull modal ────────────────────────────────────────────────────────────────

function PullModal({ onClose }: { onClose: () => void }) {
  const [modelName, setModelName] = useState("");
  const qc = useQueryClient();

  const pullMut = useMutation({
    mutationFn: () => api.models.pull(modelName.trim()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pullStatus"] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-md rounded-xl p-6"
        style={{ background: "var(--color-elevated)", border: "1px solid var(--color-border)" }}>
        <h2 className="font-bold text-base mb-4" style={{ color: "var(--color-foreground)" }}>
          Pull a model from Ollama
        </h2>
        <p className="text-sm mb-4" style={{ color: "var(--color-muted)" }}>
          Enter an Ollama model name (e.g. <code className="px-1 rounded text-xs"
            style={{ background: "var(--color-border)" }}>llama3.2:3b</code>,
          <code className="px-1 rounded text-xs ml-1"
            style={{ background: "var(--color-border)" }}>deepseek-coder-v2:16b</code>)
        </p>
        <input
          value={modelName}
          onChange={e => setModelName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && modelName.trim()) pullMut.mutate(); }}
          placeholder="model:tag"
          className="w-full px-3 py-2 rounded-lg text-sm outline-none mb-4"
          style={{
            background: "var(--color-surface)",
            color: "var(--color-foreground)",
            border: "1px solid var(--color-border)",
          }}
          autoFocus
        />

        {/* Popular suggestions */}
        <div className="flex flex-wrap gap-1.5 mb-4">
          {["llama3.2:3b", "deepseek-coder-v2:16b", "llava:13b", "mistral:7b", "gemma3:4b"].map(name => (
            <button key={name} onClick={() => setModelName(name)}
              className="text-xs px-2 py-1 rounded"
              style={{ background: "var(--color-border)", color: "var(--color-muted)" }}>
              {name}
            </button>
          ))}
        </div>

        <div className="flex gap-2">
          <button onClick={onClose}
            className="flex-1 py-2 rounded-lg text-sm"
            style={{ background: "var(--color-border)", color: "var(--color-muted)" }}>
            Cancel
          </button>
          <button
            onClick={() => pullMut.mutate()}
            disabled={!modelName.trim() || pullMut.isPending}
            className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium disabled:opacity-40"
            style={{ background: "var(--color-accent)", color: "#fff" }}>
            {pullMut.isPending ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            Pull
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Models page ───────────────────────────────────────────────────────────────

export default function ModelsPage() {
  const [search, setSearch] = useState("");
  const [showPull, setShowPull] = useState(false);
  const [showProgress, setShowProgress] = useState(true);
  const qc = useQueryClient();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["modelList"],
    queryFn: () => api.models.list(),
    refetchInterval: 20_000,
  });

  const refreshMut = useMutation({
    mutationFn: () => api.models.refresh(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["modelList"] }),
  });

  const models = (data?.models ?? []).filter(m =>
    !search || m.name.toLowerCase().includes(search.toLowerCase())
  );

  const running = models.filter(m => m.isRunning);
  const idle    = models.filter(m => !m.isRunning);

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 shrink-0"
        style={{ borderBottom: "1px solid var(--color-border)" }}>
        <div>
          <h1 className="font-bold text-lg" style={{ color: "var(--color-foreground)" }}>Models</h1>
          <p className="text-xs mt-0.5" style={{ color: "var(--color-muted)" }}>
            {data ? `${data.models.length} models · ${data.totalSizeFormatted} on disk` : "Loading…"}
            {data && !data.ollamaReachable && (
              <span className="ml-2" style={{ color: "var(--color-error)" }}>· Ollama offline</span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => refreshMut.mutate()}
            disabled={refreshMut.isPending}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm disabled:opacity-50"
            style={{ background: "var(--color-elevated)", color: "var(--color-foreground)", border: "1px solid var(--color-border)" }}>
            <RefreshCw size={13} className={refreshMut.isPending ? "animate-spin" : ""} />
            Sync
          </button>
          <button
            onClick={() => setShowPull(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium"
            style={{ background: "var(--color-accent)", color: "#fff" }}>
            <Download size={13} />
            Pull Model
          </button>
        </div>
      </div>

      {/* VRAM guard status */}
      {data?.vramGuard && (
        <div className="px-6 py-2.5 flex items-center gap-2 text-xs shrink-0"
          style={{
            background: data.vramGuard.status === "healthy"
              ? "color-mix(in srgb, var(--color-success) 8%, var(--color-surface))"
              : "color-mix(in srgb, var(--color-warn) 8%, var(--color-surface))",
            borderBottom: "1px solid var(--color-border)",
          }}>
          {data.vramGuard.status === "healthy"
            ? <CheckCircle size={13} style={{ color: "var(--color-success)" }} />
            : <AlertTriangle size={13} style={{ color: "var(--color-warn)" }} />
          }
          <span style={{ color: "var(--color-muted)" }}>
            VRAM Guard: <strong style={{ color: "var(--color-foreground)" }}>{data.vramGuard.mode}</strong>
            {data.vramGuard.gpuName && <> · {data.vramGuard.gpuName}</>}
            {data.vramGuard.totalBytes && (
              <> · {(data.vramGuard.totalBytes / 1024 ** 3).toFixed(1)} GB total</>
            )}
          </span>
          <span className="ml-auto" style={{ color: "var(--color-muted)" }}>{data.vramGuard.reason}</span>
        </div>
      )}

      {/* Search */}
      <div className="px-6 py-3 shrink-0" style={{ borderBottom: "1px solid var(--color-border)" }}>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2"
            style={{ color: "var(--color-muted)" }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search models…"
            className="w-full pl-9 pr-4 py-2 rounded-lg text-sm outline-none"
            style={{
              background: "var(--color-elevated)",
              color: "var(--color-foreground)",
              border: "1px solid var(--color-border)",
            }}
          />
        </div>
      </div>

      {/* Model list */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {isLoading && (
          <div className="flex items-center justify-center py-16" style={{ color: "var(--color-muted)" }}>
            <Loader2 size={20} className="animate-spin mr-2" />
            Loading models…
          </div>
        )}
        {isError && (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <AlertTriangle size={24} style={{ color: "var(--color-error)" }} />
            <span className="text-sm" style={{ color: "var(--color-muted)" }}>
              Failed to load models
            </span>
            <button onClick={() => void refetch()}
              className="text-sm px-4 py-2 rounded-lg"
              style={{ background: "var(--color-elevated)", color: "var(--color-foreground)", border: "1px solid var(--color-border)" }}>
              Retry
            </button>
          </div>
        )}

        {!isLoading && !isError && models.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Cpu size={24} style={{ color: "var(--color-muted)" }} />
            <span className="text-sm" style={{ color: "var(--color-muted)" }}>
              {search ? "No models match your search" : "No models installed. Pull one to get started."}
            </span>
          </div>
        )}

        {running.length > 0 && (
          <section className="mb-5">
            <div className="flex items-center gap-2 mb-2.5 text-xs font-medium"
              style={{ color: "var(--color-success)" }}>
              <div className="w-1.5 h-1.5 rounded-full pulse-dot" style={{ background: "var(--color-success)" }} />
              RUNNING ({running.length})
            </div>
            <div className="space-y-2">
              {running.map(m => <ModelRow key={m.name} model={m} />)}
            </div>
          </section>
        )}

        {idle.length > 0 && (
          <section>
            {running.length > 0 && (
              <div className="text-xs font-medium mb-2.5" style={{ color: "var(--color-muted)" }}>
                INSTALLED ({idle.length})
              </div>
            )}
            <div className="space-y-2">
              {idle.map(m => <ModelRow key={m.name} model={m} />)}
            </div>
          </section>
        )}
      </div>

      {/* Pull modal */}
      {showPull && <PullModal onClose={() => setShowPull(false)} />}

      {/* Pull progress */}
      {showProgress && <PullProgress onClose={() => setShowProgress(false)} />}
    </div>
  );
}
