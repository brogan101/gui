import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Route, Switch, Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  MessageSquare,
  Cpu,
  Folder,
  Zap,
  Settings,
  Activity,
  Wrench,
  Radio,
  Plug,
  RefreshCw,
  Wifi,
  WifiOff,
  AlertTriangle,
  ChevronRight,
} from "lucide-react";
import api from "./api.js";

// ── Pages ─────────────────────────────────────────────────────────────────────
import Dashboard from "./pages/Dashboard.js";
import ChatPage from "./pages/Chat.js";
import ModelsPage from "./pages/Models.js";

function Placeholder({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
      <div className="w-12 h-12 rounded-full flex items-center justify-center"
        style={{ background: "color-mix(in srgb, var(--color-accent) 15%, transparent)" }}>
        <Zap size={20} style={{ color: "var(--color-accent)" }} />
      </div>
      <h2 className="text-lg font-semibold" style={{ color: "var(--color-foreground)" }}>{title}</h2>
      <p className="text-sm max-w-sm" style={{ color: "var(--color-muted)" }}>
        {description ?? "Sovereign Pending — this feature is coming soon."}
      </p>
    </div>
  );
}

// ── Nav config ────────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { path: "/",            label: "Dashboard",    icon: LayoutDashboard },
  { path: "/chat",        label: "Chat",         icon: MessageSquare },
  { path: "/models",      label: "Models",       icon: Cpu },
  { path: "/workspace",   label: "Workspace",    icon: Folder },
  { path: "/studios",     label: "Studios",      icon: Zap },
  { path: "/diagnostics", label: "Diagnostics",  icon: Activity },
  { path: "/logs",        label: "Logs",         icon: Activity },
  { path: "/cleanup",     label: "Cleanup",      icon: Wrench },
  { path: "/remote",      label: "Remote",       icon: Radio },
  { path: "/integrations",label: "Integrations", icon: Plug },
  { path: "/settings",    label: "Settings",     icon: Settings },
] as const;

// ── Status bar (top-right corner of sidebar) ──────────────────────────────────

function SidebarStatus() {
  const { data } = useQuery({
    queryKey: ["heartbeat"],
    queryFn: () => api.system.heartbeat(),
    refetchInterval: 15_000,
    retry: false,
  });

  const state = data?.state ?? "offline";
  const dot =
    state === "local"    ? "var(--color-success)" :
    state === "online"   ? "var(--color-info)"    :
    state === "degraded" ? "var(--color-warn)"    :
                           "var(--color-error)";

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
      style={{ background: "var(--color-elevated)", color: "var(--color-muted)" }}>
      {state === "offline"
        ? <WifiOff size={12} style={{ color: dot }} />
        : state === "degraded"
          ? <AlertTriangle size={12} style={{ color: dot }} />
          : <Wifi size={12} style={{ color: dot }} />
      }
      <span style={{ color: dot }} className="font-medium capitalize">{state}</span>
      {data?.latencyMs !== undefined && (
        <span className="ml-auto opacity-60">{data.latencyMs}ms</span>
      )}
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar() {
  const [location] = useLocation();

  return (
    <aside className="flex flex-col shrink-0 select-none"
      style={{
        width: 220,
        background: "var(--color-surface)",
        borderRight: "1px solid var(--color-border)",
        height: "100vh",
        position: "fixed",
        top: 0,
        left: 0,
        zIndex: 40,
      }}>
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 py-5"
        style={{ borderBottom: "1px solid var(--color-border)" }}>
        <div className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-sm"
          style={{ background: "var(--color-accent)", color: "#fff" }}>L</div>
        <div>
          <div className="font-bold text-sm tracking-wide" style={{ color: "var(--color-foreground)" }}>
            LOCAL<span style={{ color: "var(--color-accent)" }}>AI</span>
          </div>
          <div className="text-xs" style={{ color: "var(--color-muted)" }}>Control Center</div>
        </div>
      </div>

      {/* Nav links */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        {NAV_ITEMS.map(({ path, label, icon: Icon }) => {
          const active = path === "/" ? location === "/" : location.startsWith(path);
          return (
            <Link
              key={path}
              href={path}
              className="flex items-center gap-3 px-3 py-2 rounded-lg mb-0.5 text-sm transition-colors cursor-pointer"
              style={{
                display: "flex",
                background: active ? "color-mix(in srgb, var(--color-accent) 18%, transparent)" : "transparent",
                color: active ? "var(--color-foreground)" : "var(--color-muted)",
                fontWeight: active ? 500 : 400,
                textDecoration: "none",
              }}>
              <Icon size={16} style={{ color: active ? "var(--color-accent)" : "inherit", flexShrink: 0 }} />
              <span style={{ flex: 1 }}>{label}</span>
              {active && <ChevronRight size={12} style={{ color: "var(--color-accent)" }} />}
            </Link>
          );
        })}
      </nav>

      {/* Bottom status */}
      <div className="p-3" style={{ borderTop: "1px solid var(--color-border)" }}>
        <SidebarStatus />
      </div>
    </aside>
  );
}

// ── Query client ──────────────────────────────────────────────────────────────

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
});

// ── App shell ─────────────────────────────────────────────────────────────────

function AppShell() {
  return (
    <div className="flex" style={{ minHeight: "100vh" }}>
      <Sidebar />

      <main className="flex-1 flex flex-col min-h-screen overflow-hidden"
        style={{ marginLeft: 220, background: "var(--color-background)" }}>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/chat" component={ChatPage} />
          <Route path="/models" component={ModelsPage} />
          <Route path="/workspace">
            <Placeholder title="Workspace" description="Project index and code context. Sovereign Pending." />
          </Route>
          <Route path="/studios">
            <Placeholder title="Studios" description="Autonomous pipelines for code, CAD, and image generation. Sovereign Pending." />
          </Route>
          <Route path="/diagnostics">
            <Placeholder title="Diagnostics" description="System health checks and hardware diagnostics." />
          </Route>
          <Route path="/logs">
            <Placeholder title="Logs" description="Full thought log and activity history." />
          </Route>
          <Route path="/cleanup">
            <Placeholder title="Cleanup" description="Artifact scanner and disk space recovery." />
          </Route>
          <Route path="/remote">
            <Placeholder title="Remote Access" description="Secure remote gateway and tunnel management." />
          </Route>
          <Route path="/integrations">
            <Placeholder title="Integrations" description="Continue.dev, VS Code, and external tool bridges." />
          </Route>
          <Route path="/settings">
            <Placeholder title="Settings" description="Gateway configuration, API keys, and security settings." />
          </Route>
          <Route>
            <Placeholder title="404 — Page Not Found" description="This route does not exist." />
          </Route>
        </Switch>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>
  );
}
