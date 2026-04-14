import { randomBytes, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";
import { thoughtLog } from "./thought-log.js";
import {
  loadDistributedNodeConfig,
  saveDistributedNodeConfig,
  defaultDistributedNodeConfig,
  type DistributedNodeConfig,
} from "./secure-config.js";

const AUTH_COOKIE_NAME = "localai_remote_token";

export interface HeartbeatStatus {
  state: "local" | "online" | "degraded" | "offline";
  mode: string;
  provider: string;
  targetBaseUrl: string;
  heartbeatPath: string;
  authEnabled: boolean;
  connectedRemotely: boolean;
  latencyMs?: number;
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  message: string;
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatRunning = false;
let heartbeatIntervalMs =
  defaultDistributedNodeConfig().heartbeatIntervalSeconds * 1000;
let distributedConfigCache: DistributedNodeConfig | null = null;
let distributedConfigLoadPromise: Promise<DistributedNodeConfig> | null = null;

let lastHeartbeat: HeartbeatStatus = {
  state: "local",
  mode: "local",
  provider: defaultDistributedNodeConfig().provider,
  targetBaseUrl: defaultDistributedNodeConfig().localBaseUrl,
  heartbeatPath: defaultDistributedNodeConfig().heartbeatPath,
  authEnabled: defaultDistributedNodeConfig().authEnabled,
  connectedRemotely: false,
  message: "Local node routing is active",
};

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.replace(/^::ffff:/, "");
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost"
  );
}

function tokenBuffersMatch(expected: string, presented: string): boolean {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const presentedBuffer = Buffer.from(presented, "utf8");
  if (expectedBuffer.length !== presentedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, presentedBuffer);
}

function buildTargetBaseUrl(config: DistributedNodeConfig): string {
  if (config.mode === "remote" && config.remoteHost.trim()) {
    return `${config.remoteProtocol}://${config.remoteHost.trim()}:${config.remotePort}`;
  }
  return normalizeBaseUrl(config.localBaseUrl);
}

function authorizationHeader(
  config: DistributedNodeConfig,
): Record<string, string> | undefined {
  if (!config.authEnabled || !config.authToken) return undefined;
  return { Authorization: `Bearer ${config.authToken}` };
}

function readPresentedToken(request: Request): string {
  const authorization = request.header("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  const directHeader = request.header("x-localai-token");
  if (directHeader) return directHeader.trim();
  const cookieValue =
    typeof (request.cookies as Record<string, unknown>)?.[AUTH_COOKIE_NAME] ===
    "string"
      ? String(
          (request.cookies as Record<string, unknown>)[AUTH_COOKIE_NAME],
        ).trim()
      : "";
  if (cookieValue) return cookieValue;
  const queryValue =
    typeof request.query["localai_token"] === "string"
      ? (request.query["localai_token"] as string).trim()
      : "";
  return queryValue;
}

function setAuthorizedCookie(response: Response, token: string): void {
  response.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
}

async function hydrateDistributedNodeConfig(): Promise<DistributedNodeConfig> {
  if (distributedConfigCache) return distributedConfigCache;
  if (!distributedConfigLoadPromise) {
    distributedConfigLoadPromise = loadDistributedNodeConfig()
      .then((config) => {
        distributedConfigCache = config;
        heartbeatIntervalMs = Math.max(
          1000,
          config.heartbeatIntervalSeconds * 1000,
        );
        return config;
      })
      .finally(() => {
        distributedConfigLoadPromise = null;
      });
  }
  return distributedConfigLoadPromise;
}

function scheduleHeartbeatTimer(intervalMs: number): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatIntervalMs = Math.max(1000, intervalMs);
  heartbeatTimer = setInterval(() => {
    void runDistributedNodeHeartbeat().catch(() => undefined);
  }, heartbeatIntervalMs);
  (heartbeatTimer as unknown as { unref?: () => void }).unref?.();
}

export async function getDistributedNodeConfig(): Promise<DistributedNodeConfig> {
  return hydrateDistributedNodeConfig();
}

export async function updateDistributedNodeConfig(
  input: Partial<DistributedNodeConfig>,
): Promise<DistributedNodeConfig> {
  const normalized = {
    ...input,
    localBaseUrl: input.localBaseUrl
      ? normalizeBaseUrl(input.localBaseUrl)
      : input.localBaseUrl,
    remoteHost: input.remoteHost?.trim(),
    authToken: input.authToken?.trim(),
  };
  const next = await saveDistributedNodeConfig(normalized);
  distributedConfigCache = next;
  distributedConfigLoadPromise = null;
  const nextMs = Math.max(1000, next.heartbeatIntervalSeconds * 1000);
  if (heartbeatTimer && nextMs !== heartbeatIntervalMs) {
    scheduleHeartbeatTimer(nextMs);
  } else {
    heartbeatIntervalMs = nextMs;
  }
  void runDistributedNodeHeartbeat().catch(() => undefined);
  return next;
}

export async function rotateDistributedAuthToken(): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await updateDistributedNodeConfig({ authToken: token });
  thoughtLog.publish({
    category: "system",
    title: "Distributed Auth Token Rotated",
    message:
      "A new sovereign handshake token was generated for distributed node access",
  });
  return token;
}

export async function getActiveGatewayBaseUrl(): Promise<string> {
  const config = await getDistributedNodeConfig();
  return buildTargetBaseUrl(config);
}

export async function buildDistributedProxyHeaders(): Promise<
  Record<string, string> | undefined
> {
  const config = await getDistributedNodeConfig();
  return authorizationHeader(config);
}

export async function validateDistributedToken(token: string): Promise<boolean> {
  const config = await getDistributedNodeConfig();
  if (!config.authEnabled) return true;
  if (!config.authToken) return false;
  return tokenBuffersMatch(config.authToken, token.trim());
}

export async function authorizeDistributedRequest(
  response: Response,
  token: string,
): Promise<boolean> {
  const valid = await validateDistributedToken(token);
  if (valid) setAuthorizedCookie(response, token.trim());
  return valid;
}

export async function distributedNodeAuthMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const config = await getDistributedNodeConfig();
  const exemptPaths = new Set([
    "/api/remote/auth/authorize",
    "/api/remote/auth/status",
    "/api/healthz",
  ]);
  if (!config.authEnabled || exemptPaths.has(request.path)) {
    next();
    return;
  }
  const remoteAddress = request.ip || request.socket.remoteAddress;
  if (isLoopbackAddress(remoteAddress)) {
    next();
    return;
  }
  const presentedToken = readPresentedToken(request);
  if (
    presentedToken &&
    config.authToken &&
    tokenBuffersMatch(config.authToken, presentedToken)
  ) {
    setAuthorizedCookie(response, presentedToken);
    next();
    return;
  }
  logger.warn(
    { path: request.path, remoteAddress },
    "Distributed auth rejected request",
  );
  response
    .status(401)
    .json({ success: false, message: "Distributed node authorization failed" });
}

export async function runDistributedNodeHeartbeat(): Promise<HeartbeatStatus> {
  if (heartbeatRunning) return lastHeartbeat;
  heartbeatRunning = true;
  try {
    const config = await getDistributedNodeConfig();
    const targetBaseUrl = buildTargetBaseUrl(config);
    const connectedRemotely =
      config.mode === "remote" && !!config.remoteHost.trim();
    const checkedAt = new Date().toISOString();
    if (!connectedRemotely) {
      lastHeartbeat = {
        state: "local",
        mode: config.mode,
        provider: config.provider,
        targetBaseUrl,
        heartbeatPath: config.heartbeatPath,
        authEnabled: config.authEnabled,
        connectedRemotely: false,
        lastCheckedAt: checkedAt,
        lastSuccessAt: checkedAt,
        message: "Local node routing is active",
      };
      return lastHeartbeat;
    }
    const startedAt = Date.now();
    const headers = authorizationHeader(config);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      config.remoteRequestTimeoutMs,
    );
    try {
      const response = await fetch(
        `${targetBaseUrl}${config.heartbeatPath}`,
        { method: "GET", headers, signal: controller.signal },
      );
      const latencyMs = Date.now() - startedAt;
      const ok = response.ok;
      lastHeartbeat = {
        state: ok ? "online" : "degraded",
        mode: config.mode,
        provider: config.provider,
        targetBaseUrl,
        heartbeatPath: config.heartbeatPath,
        authEnabled: config.authEnabled,
        connectedRemotely: true,
        latencyMs,
        lastCheckedAt: checkedAt,
        lastSuccessAt: ok ? checkedAt : lastHeartbeat.lastSuccessAt,
        message: ok
          ? `Remote node reachable in ${latencyMs} ms`
          : `Remote node responded with HTTP ${response.status}`,
      };
      if (!ok) {
        thoughtLog.publish({
          level: "warning",
          category: "system",
          title: "Remote Node Degraded",
          message: lastHeartbeat.message,
          metadata: { targetBaseUrl, latencyMs },
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      lastHeartbeat = {
        state: "offline",
        mode: config.mode,
        provider: config.provider,
        targetBaseUrl,
        heartbeatPath: config.heartbeatPath,
        authEnabled: config.authEnabled,
        connectedRemotely: true,
        lastCheckedAt: checkedAt,
        lastSuccessAt: lastHeartbeat.lastSuccessAt,
        message: `Remote node unreachable: ${message}`,
      };
      logger.warn({ err: error, targetBaseUrl }, "Distributed node heartbeat failed");
    } finally {
      clearTimeout(timeout);
    }
    return lastHeartbeat;
  } finally {
    heartbeatRunning = false;
  }
}

export function startDistributedNodeHeartbeat(): void {
  if (heartbeatTimer) return;
  void runDistributedNodeHeartbeat().catch(() => undefined);
  void hydrateDistributedNodeConfig()
    .then((config) =>
      scheduleHeartbeatTimer(config.heartbeatIntervalSeconds * 1000),
    )
    .catch(() =>
      scheduleHeartbeatTimer(
        defaultDistributedNodeConfig().heartbeatIntervalSeconds * 1000,
      ),
    );
}

export function getLastHeartbeat(): HeartbeatStatus {
  return lastHeartbeat;
}

export interface StreamingBufferProfile {
  enabled: boolean;
  flushIntervalMs: number;
  maxChunkChars: number;
}

export function getStreamingBufferProfile(): StreamingBufferProfile {
  const latencyMs = lastHeartbeat.latencyMs || 0;
  if (lastHeartbeat.state === "local") {
    return { enabled: false, flushIntervalMs: 0, maxChunkChars: 1 };
  }
  if (lastHeartbeat.state === "offline") {
    return { enabled: true, flushIntervalMs: 140, maxChunkChars: 192 };
  }
  if (latencyMs >= 250) {
    return { enabled: true, flushIntervalMs: 140, maxChunkChars: 192 };
  }
  if (latencyMs >= 120) {
    return { enabled: true, flushIntervalMs: 90, maxChunkChars: 144 };
  }
  if (lastHeartbeat.connectedRemotely) {
    return { enabled: true, flushIntervalMs: 48, maxChunkChars: 96 };
  }
  return { enabled: false, flushIntervalMs: 0, maxChunkChars: 1 };
}

export class LatencyOptimizedTokenBuffer {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onFlush: (chunk: string) => void,
    private readonly profile: StreamingBufferProfile,
  ) {}

  enqueue(token: string): void {
    if (!this.profile.enabled) {
      this.onFlush(token);
      return;
    }
    this.buffer += token;
    if (this.buffer.length >= this.profile.maxChunkChars) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.profile.flushIntervalMs);
    }
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer) return;
    const chunk = this.buffer;
    this.buffer = "";
    this.onFlush(chunk);
  }

  close(): void {
    this.flush();
  }
}
