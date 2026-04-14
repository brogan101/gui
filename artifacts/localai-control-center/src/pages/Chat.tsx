import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Send,
  Bot,
  User,
  Cpu,
  Code2,
  Wrench,
  Eye,
  Sparkles,
  ChevronDown,
  AlertCircle,
} from "lucide-react";
import api, { type ChatMessage, type SupervisorInfo } from "../api.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface StreamChunk {
  delta?: string;
  done?: boolean;
  model?: string;
  supervisor?: SupervisorInfo;
  error?: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  supervisor?: SupervisorInfo;
  model?: string;
  streaming?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function agentIcon(category?: string) {
  switch (category) {
    case "coding":   return <Code2 size={13} />;
    case "hardware": return <Cpu size={13} />;
    case "sysadmin": return <Wrench size={13} />;
    case "vision":   return <Eye size={13} />;
    default:         return <Sparkles size={13} />;
  }
}

function agentColor(category?: string): string {
  switch (category) {
    case "coding":   return "var(--color-info)";
    case "hardware": return "var(--color-success)";
    case "sysadmin": return "var(--color-warn)";
    case "vision":   return "#a855f7";
    default:         return "var(--color-accent)";
  }
}

function agentName(category?: string): string {
  switch (category) {
    case "coding":   return "Sovereign Coder";
    case "hardware": return "Sovereign Hardware";
    case "sysadmin": return "Sovereign SysAdmin";
    case "vision":   return "Sovereign Vision";
    default:         return "Sovereign";
  }
}

// ── Thinking indicator ────────────────────────────────────────────────────────

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 1, 2].map(i => (
        <div key={i} className="w-1.5 h-1.5 rounded-full thinking-dot"
          style={{ background: "var(--color-muted)", animationDelay: `${i * 0.2}s` }} />
      ))}
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  const color = agentColor(msg.supervisor?.category);

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : "flex-row"} mb-4`}>
      {/* Avatar */}
      <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5"
        style={{
          background: isUser
            ? "color-mix(in srgb, var(--color-accent) 20%, transparent)"
            : `color-mix(in srgb, ${color} 20%, transparent)`,
        }}>
        {isUser
          ? <User size={15} style={{ color: "var(--color-accent)" }} />
          : <Bot size={15} style={{ color }} />
        }
      </div>

      {/* Content */}
      <div className={`flex flex-col max-w-[75%] ${isUser ? "items-end" : "items-start"}`}>
        {/* Agent label */}
        {!isUser && msg.supervisor && (
          <div className="flex items-center gap-1.5 mb-1 text-xs"
            style={{ color }}>
            {agentIcon(msg.supervisor.category)}
            <span className="font-medium">{agentName(msg.supervisor.category)}</span>
            {msg.supervisor.toolset && (
              <span className="opacity-60">· {msg.supervisor.toolset}</span>
            )}
            {msg.model && (
              <span className="ml-1 px-1.5 py-0 rounded text-xs"
                style={{ background: `color-mix(in srgb, ${color} 12%, transparent)` }}>
                {msg.model}
              </span>
            )}
          </div>
        )}

        {/* Bubble */}
        <div className="rounded-xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words"
          style={{
            background: isUser
              ? "color-mix(in srgb, var(--color-accent) 20%, transparent)"
              : "var(--color-surface)",
            color: "var(--color-foreground)",
            border: `1px solid ${isUser
              ? "color-mix(in srgb, var(--color-accent) 30%, transparent)"
              : "var(--color-border)"}`,
            borderRadius: isUser ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
          }}>
          {msg.streaming && !msg.content ? <ThinkingDots /> : msg.content}
          {msg.streaming && msg.content && (
            <span className="inline-block w-0.5 h-4 ml-0.5 animate-pulse align-middle"
              style={{ background: "var(--color-accent)" }} />
          )}
        </div>

        {/* Execution plan summary */}
        {!isUser && msg.supervisor?.steps && msg.supervisor.steps.length > 0 && !msg.streaming && (
          <div className="mt-2 text-xs rounded-lg px-3 py-2"
            style={{ background: "var(--color-elevated)", color: "var(--color-muted)", maxWidth: "100%" }}>
            <div className="flex items-center gap-1.5 mb-1" style={{ color: "var(--color-foreground)" }}>
              <Sparkles size={10} />
              <span className="font-medium">Execution Plan</span>
            </div>
            {msg.supervisor.steps.map((step, i) => (
              <div key={i} className="flex items-start gap-1.5 mb-0.5">
                <span className="opacity-50">{i + 1}.</span>
                <span>{step}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Model selector ────────────────────────────────────────────────────────────

function ModelSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["chatModels"],
    queryFn: () => api.chat.chatModels(),
    staleTime: 30_000,
  });

  const models = data?.models ?? [];
  const label = value || "Auto-route";

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-colors"
        style={{
          background: "var(--color-elevated)",
          color: "var(--color-foreground)",
          border: "1px solid var(--color-border)",
        }}>
        <Cpu size={11} />
        <span>{label}</span>
        <ChevronDown size={10} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute bottom-full mb-1 left-0 z-50 rounded-lg overflow-hidden shadow-xl"
          style={{ background: "var(--color-elevated)", border: "1px solid var(--color-border)", minWidth: 180 }}>
          <button
            onClick={() => { onChange(""); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-xs transition-colors hover:opacity-80"
            style={{
              background: !value ? "color-mix(in srgb, var(--color-accent) 15%, transparent)" : "transparent",
              color: "var(--color-foreground)",
            }}>
            Auto-route (Supervisor)
          </button>
          {models.map(m => (
            <button
              key={m.name}
              onClick={() => { onChange(m.name); setOpen(false); }}
              className="w-full text-left px-3 py-2 text-xs transition-colors hover:opacity-80"
              style={{
                background: value === m.name ? "color-mix(in srgb, var(--color-accent) 15%, transparent)" : "transparent",
                color: "var(--color-foreground)",
              }}>
              <span>{m.name}</span>
              {m.paramSize && <span className="ml-1 opacity-50">{m.paramSize}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Chat page ─────────────────────────────────────────────────────────────────

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("");
  const [sessionId] = useState(() => `session-${Date.now()}`);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setError(null);
    setInput("");

    const userMsg: Message = { role: "user", content: text };
    const assistantMsg: Message = { role: "assistant", content: "", streaming: true };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setStreaming(true);

    // Build upstream message list (exclude streaming placeholder)
    const chatHistory: ChatMessage[] = [
      ...messages.map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user", content: text },
    ];

    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: chatHistory, model: model || undefined, sessionId }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let collectedText = "";
      let supervisor: SupervisorInfo | undefined;
      let responseModel = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") continue;
          try {
            const chunk = JSON.parse(raw) as StreamChunk;
            if (chunk.error) throw new Error(chunk.error);
            if (chunk.supervisor) supervisor = chunk.supervisor;
            if (chunk.model) responseModel = chunk.model;
            if (chunk.delta) {
              collectedText += chunk.delta;
              setMessages(prev => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last?.role === "assistant") {
                  next[next.length - 1] = { ...last, content: collectedText, supervisor, model: responseModel };
                }
                return next;
              });
            }
          } catch (parseErr) {
            // ignore malformed SSE
          }
        }
      }

      // Finalize
      setMessages(prev => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant") {
          next[next.length - 1] = { ...last, content: collectedText, streaming: false, supervisor, model: responseModel };
        }
        return next;
      });
    } catch (err: unknown) {
      if ((err as Error).name === "AbortError") return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      // Remove streaming placeholder
      setMessages(prev => prev.filter(m => !m.streaming));
    } finally {
      setStreaming(false);
    }
  }, [input, messages, model, sessionId, streaming]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 shrink-0"
        style={{ borderBottom: "1px solid var(--color-border)" }}>
        <div>
          <h1 className="font-bold text-lg" style={{ color: "var(--color-foreground)" }}>Omni-Chat</h1>
          <p className="text-xs mt-0.5" style={{ color: "var(--color-muted)" }}>
            Supervisor Agent · auto-routes to the best model for each task
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setMessages([]);
              setError(null);
            }}
            className="text-xs px-3 py-1.5 rounded-lg"
            style={{ background: "var(--color-elevated)", color: "var(--color-muted)", border: "1px solid var(--color-border)" }}>
            Clear
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
            <div className="w-14 h-14 rounded-full flex items-center justify-center"
              style={{ background: "color-mix(in srgb, var(--color-accent) 15%, transparent)" }}>
              <Bot size={24} style={{ color: "var(--color-accent)" }} />
            </div>
            <div>
              <div className="font-semibold text-base" style={{ color: "var(--color-foreground)" }}>
                Sovereign AI ready
              </div>
              <div className="text-sm mt-1" style={{ color: "var(--color-muted)" }}>
                Ask anything — coding, sysadmin, hardware, or general tasks.<br />
                The Supervisor Agent will route to the best model automatically.
              </div>
            </div>
            <div className="flex flex-wrap gap-2 justify-center mt-2">
              {[
                "Write a TypeScript API endpoint",
                "List running Docker containers",
                "Generate OpenSCAD for a bracket",
                "Explain VRAM guard modes",
              ].map(hint => (
                <button
                  key={hint}
                  onClick={() => { setInput(hint); textareaRef.current?.focus(); }}
                  className="text-xs px-3 py-1.5 rounded-lg transition-colors"
                  style={{ background: "var(--color-elevated)", color: "var(--color-muted)", border: "1px solid var(--color-border)" }}>
                  {hint}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} />
        ))}

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg mb-4 text-sm"
            style={{ background: "color-mix(in srgb, var(--color-error) 10%, transparent)", color: "var(--color-error)", border: "1px solid color-mix(in srgb, var(--color-error) 25%, transparent)" }}>
            <AlertCircle size={15} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="shrink-0 px-6 pb-6 pt-3" style={{ borderTop: "1px solid var(--color-border)" }}>
        <div className="rounded-xl overflow-hidden"
          style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={streaming}
            placeholder="Ask anything... (Shift+Enter for newline)"
            rows={1}
            className="w-full px-4 pt-3 pb-2 text-sm resize-none outline-none bg-transparent"
            style={{
              color: "var(--color-foreground)",
              minHeight: 44,
              maxHeight: 160,
              lineHeight: 1.5,
            }}
          />
          <div className="flex items-center justify-between px-3 pb-2.5">
            <ModelSelector value={model} onChange={setModel} />
            <button
              onClick={() => void send()}
              disabled={!input.trim() || streaming}
              className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-opacity disabled:opacity-40"
              style={{ background: "var(--color-accent)", color: "#fff" }}>
              {streaming ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Thinking
                </>
              ) : (
                <>
                  <Send size={13} />
                  Send
                </>
              )}
            </button>
          </div>
        </div>
        <div className="text-xs mt-2 text-center" style={{ color: "var(--color-muted)" }}>
          Press Enter to send · Shift+Enter for newline · model auto-routed by Supervisor Agent
        </div>
      </div>
    </div>
  );
}
