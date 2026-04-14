import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "crypto";
import { existsSync } from "fs";
import { mkdir, readFile } from "fs/promises";
import os from "os";
import path from "path";
import { toolsRoot } from "./runtime.js";
import { logger } from "./logger.js";
import { thoughtLog } from "./thought-log.js";
import { writeManagedFile, writeManagedJson, readJsonIfExists } from "./snapshot-manager.js";

// ── Capability registry ──────────────────────────────────────────────────────

export const CAPABILITY_IDS = ["coding", "sysadmin", "cad", "imagegen"] as const;
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export const CAPABILITY_PHASES = [
  "idle",
  "active",
  "blocked",
  "error",
  "disabled",
] as const;
export type CapabilityPhase = (typeof CAPABILITY_PHASES)[number];

export type TaskCategory = "coding" | "sysadmin" | "hardware" | "general";

export interface CapabilityState {
  id: string;
  enabled: boolean;
  active: boolean;
  phase: CapabilityPhase;
  detail?: string;
  assignedJobId?: string;
  lastUpdatedAt: string;
}

/** In-memory sovereign session state — tracks the active agent goal and
 *  step within the current execution plan.  Not persisted to encrypted
 *  config; lives only in the running process. */
export interface SovereignState {
  activeGoal?: string;
  /** Display name of the currently executing agent ("Sovereign Coder", etc.) */
  activeAgentName?: string;
  activeStep: number;
  /** Human-readable description of the step currently in progress */
  currentStepDescription?: string;
  totalSteps: number;
  executionPlan: string[];
  taskCategory?: TaskCategory;
  /** ISO timestamp of the last successful Ollama catalog sync */
  lastCatalogSync?: string;
  /** Number of models seen in the last catalog sync */
  catalogModelCount: number;
}

export function defaultSovereignState(): SovereignState {
  return {
    activeGoal: undefined,
    activeAgentName: undefined,
    activeStep: 0,
    currentStepDescription: undefined,
    totalSteps: 0,
    executionPlan: [],
    taskCategory: undefined,
    lastCatalogSync: undefined,
    catalogModelCount: 0,
  };
}

export interface CapabilityRegistry {
  activeCapability?: string;
  lastUpdatedAt: string;
  capabilities: Record<string, CapabilityState>;
  /** Sovereign in-memory state — merged in at read time, never written to disk */
  sovereign: SovereignState;
}

// ── Distributed node config ──────────────────────────────────────────────────

export interface DistributedNodeConfig {
  mode: "local" | "remote";
  provider: string;
  localBaseUrl: string;
  remoteHost: string;
  remotePort: number;
  remoteProtocol: "http" | "https";
  heartbeatPath: string;
  heartbeatIntervalSeconds: number;
  remoteRequestTimeoutMs: number;
  latencyBufferMinMs: number;
  latencyBufferMaxMs: number;
  authEnabled: boolean;
  authToken: string;
}

// ── App settings ─────────────────────────────────────────────────────────────

export interface AppSettings {
  tokenWarningThreshold: number;
  dailyTokenLimit: number;
  defaultChatModel: string;
  defaultCodingModel: string;
  autoStartOllama: boolean;
  showTokenCounts: boolean;
  chatHistoryDays: number;
  theme: string;
  notificationsEnabled: boolean;
  modelDownloadPath: string;
  preferredInstallMethod: string;
  autoUpdateCheck: boolean;
  updateCheckInterval: number;
  backupBeforeUpdate: boolean;
  maxConcurrentModels: number;
  vramAlertThreshold: number;
  sidebarCollapsed: boolean;
}

export interface AppConfig {
  version: number;
  updatedAt: string;
  settings: AppSettings;
  capabilityRegistry: CapabilityRegistry;
  distributedNode: DistributedNodeConfig;
}

// ── Encrypted envelope ───────────────────────────────────────────────────────

interface ConfigEnvelope {
  version: number;
  algorithm: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  updatedAt: string;
}

// ── Paths ─────────────────────────────────────────────────────────────────────

const CONFIG_DIR = path.join(toolsRoot(), "vault");
const CONFIG_FILE = path.join(toolsRoot(), "config.json");
const CONFIG_SALT_FILE = path.join(CONFIG_DIR, "config.salt.bin");
const LEGACY_SETTINGS_FILE = path.join(toolsRoot(), "settings.json");

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: AppSettings = {
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
  autoUpdateCheck: true,
  updateCheckInterval: 86400,
  backupBeforeUpdate: true,
  maxConcurrentModels: 1,
  vramAlertThreshold: 90,
  sidebarCollapsed: false,
};

function nowIso(): string {
  return new Date().toISOString();
}

export function defaultCapabilityState(id: string): CapabilityState {
  return { id, enabled: true, active: false, phase: "idle", lastUpdatedAt: nowIso() };
}

export function defaultCapabilityRegistry(): CapabilityRegistry {
  return {
    activeCapability: undefined,
    lastUpdatedAt: nowIso(),
    capabilities: Object.fromEntries(
      CAPABILITY_IDS.map((id) => [id, defaultCapabilityState(id)]),
    ),
    sovereign: defaultSovereignState(),
  };
}

export function defaultDistributedNodeConfig(): DistributedNodeConfig {
  return {
    mode: "local",
    provider: "tailscale",
    localBaseUrl: "http://127.0.0.1:11434",
    remoteHost: "",
    remotePort: 11434,
    remoteProtocol: "http",
    heartbeatPath: "/api/tags",
    heartbeatIntervalSeconds: 10,
    remoteRequestTimeoutMs: 15000,
    latencyBufferMinMs: 24,
    latencyBufferMaxMs: 140,
    authEnabled: true,
    authToken: "",
  };
}

function defaultAppConfig(): AppConfig {
  return {
    version: 1,
    updatedAt: nowIso(),
    settings: { ...DEFAULT_SETTINGS },
    capabilityRegistry: defaultCapabilityRegistry(),
    distributedNode: defaultDistributedNodeConfig(),
  };
}

// ── Crypto ────────────────────────────────────────────────────────────────────

async function ensureConfigDirectory(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
}

async function getConfigKey(): Promise<Buffer> {
  await ensureConfigDirectory();
  let salt: Buffer;
  if (existsSync(CONFIG_SALT_FILE)) {
    salt = await readFile(CONFIG_SALT_FILE);
  } else {
    salt = randomBytes(32);
    await writeManagedFile(CONFIG_SALT_FILE, salt, { backup: false });
  }
  const fingerprint = `${os.hostname()}:${os.platform()}:${os.arch()}:${os.userInfo().username}`;
  return scryptSync(fingerprint, salt, 32) as Buffer;
}

function encryptConfig(config: AppConfig, key: Buffer): ConfigEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const payload = Buffer.concat([
    cipher.update(JSON.stringify(config), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    ciphertext: payload.toString("base64"),
    updatedAt: nowIso(),
  };
}

function decryptConfig(envelope: ConfigEnvelope, key: Buffer): AppConfig {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  const parsed = JSON.parse(plaintext) as Partial<AppConfig>;
  return {
    ...defaultAppConfig(),
    ...parsed,
    settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
    capabilityRegistry: {
      ...defaultCapabilityRegistry(),
      ...(parsed.capabilityRegistry || {}),
      sovereign: defaultSovereignState(), // always reset sovereign to default on load (in-memory only)
      capabilities: {
        ...defaultCapabilityRegistry().capabilities,
        ...(parsed.capabilityRegistry?.capabilities || {}),
      },
    },
    distributedNode: {
      ...defaultDistributedNodeConfig(),
      ...(parsed.distributedNode || {}),
    },
  };
}

// ── Load / Save ───────────────────────────────────────────────────────────────

async function loadLegacySettings(): Promise<Partial<AppSettings>> {
  return readJsonIfExists<Partial<AppSettings>>(LEGACY_SETTINGS_FILE, {});
}

export async function loadConfig(): Promise<AppConfig> {
  const key = await getConfigKey();
  if (!existsSync(CONFIG_FILE)) {
    const legacySettings = await loadLegacySettings();
    return { ...defaultAppConfig(), settings: { ...DEFAULT_SETTINGS, ...legacySettings } };
  }
  try {
    const envelope = JSON.parse(
      await readFile(CONFIG_FILE, "utf-8"),
    ) as ConfigEnvelope;
    return decryptConfig(envelope, key);
  } catch (error) {
    logger.error({ err: error }, "Failed to load encrypted config.json; falling back to defaults");
    thoughtLog.publish({
      level: "warning",
      category: "config",
      title: "Config Load Fallback",
      message: "Encrypted config.json could not be decoded. Falling back to defaults and legacy settings.",
    });
    const legacySettings = await loadLegacySettings();
    return { ...defaultAppConfig(), settings: { ...DEFAULT_SETTINGS, ...legacySettings } };
  }
}

export async function saveConfig(config: AppConfig): Promise<AppConfig> {
  const normalized: AppConfig = {
    ...defaultAppConfig(),
    ...config,
    updatedAt: nowIso(),
    settings: { ...DEFAULT_SETTINGS, ...(config.settings || {}) },
    capabilityRegistry: {
      ...defaultCapabilityRegistry(),
      ...(config.capabilityRegistry || {}),
      lastUpdatedAt: config.capabilityRegistry?.lastUpdatedAt || nowIso(),
      // Sovereign state is in-memory only — strip before encrypting to disk
      sovereign: defaultSovereignState(),
      capabilities: {
        ...defaultCapabilityRegistry().capabilities,
        ...(config.capabilityRegistry?.capabilities || {}),
      },
    },
    distributedNode: {
      ...defaultDistributedNodeConfig(),
      ...(config.distributedNode || {}),
    },
  };
  const key = await getConfigKey();
  const envelope = encryptConfig(normalized, key);
  await writeManagedJson(CONFIG_FILE, envelope);
  logger.info(
    {
      updatedAt: normalized.updatedAt,
      activeCapability: normalized.capabilityRegistry.activeCapability,
      enabledCapabilities: CAPABILITY_IDS.filter(
        (id) => normalized.capabilityRegistry.capabilities[id]?.enabled,
      ),
    },
    "Encrypted config persisted",
  );
  thoughtLog.publish({
    category: "config",
    title: "Config Saved",
    message: "Encrypted configuration persisted to disk",
    metadata: {
      activeCapability: normalized.capabilityRegistry.activeCapability,
      enabledCapabilities: CAPABILITY_IDS.filter(
        (id) => normalized.capabilityRegistry.capabilities[id]?.enabled,
      ),
    },
  });
  return normalized;
}

export async function updateConfig(
  mutator: (current: AppConfig) => AppConfig | Promise<AppConfig>,
): Promise<AppConfig> {
  const current = await loadConfig();
  const next = await mutator(current);
  return saveConfig(next);
}

export async function loadSettings(): Promise<AppSettings> {
  const config = await loadConfig();
  return config.settings;
}

export async function saveSettings(
  settings: Partial<AppSettings>,
): Promise<AppSettings> {
  const updated = await updateConfig((current) => ({
    ...current,
    settings: { ...current.settings, ...settings },
  }));
  return updated.settings;
}

export async function getCapabilityRegistry(): Promise<CapabilityRegistry> {
  const config = await loadConfig();
  return config.capabilityRegistry;
}

export async function loadDistributedNodeConfig(): Promise<DistributedNodeConfig> {
  const config = await loadConfig();
  return { ...defaultDistributedNodeConfig(), ...(config.distributedNode || {}) };
}

export async function saveDistributedNodeConfig(
  distributedNode: Partial<DistributedNodeConfig>,
): Promise<DistributedNodeConfig> {
  const updated = await updateConfig((current) => ({
    ...current,
    distributedNode: {
      ...defaultDistributedNodeConfig(),
      ...(current.distributedNode || {}),
      ...distributedNode,
    },
  }));
  return updated.distributedNode;
}

// Re-export for use in network-proxy
export { timingSafeEqual };
