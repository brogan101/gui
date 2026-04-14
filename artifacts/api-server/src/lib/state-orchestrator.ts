import { EventEmitter } from "events";
import { logger } from "./logger.js";
import { thoughtLog } from "./thought-log.js";
import {
  getCapabilityRegistry,
  updateConfig,
  defaultCapabilityRegistry,
  defaultCapabilityState,
  defaultSovereignState,
  CAPABILITY_IDS,
  type CapabilityRegistry,
  type CapabilityState,
  type CapabilityPhase,
  type SovereignState,
} from "./secure-config.js";

interface CapabilityUpdate {
  enabled?: boolean;
  active?: boolean;
  phase?: CapabilityPhase;
  detail?: string;
  assignedJobId?: string;
}

class GlobalStateOrchestrator {
  private emitter = new EventEmitter();
  private state: CapabilityRegistry = defaultCapabilityRegistry();
  private hydrated = false;
  // Sovereign state is session-scoped (in-memory), not persisted to encrypted config.
  private sovereignMemory: SovereignState = defaultSovereignState();

  async hydrate(): Promise<CapabilityRegistry> {
    if (this.hydrated) return { ...this.state, sovereign: this.sovereignMemory };
    this.state = await getCapabilityRegistry();
    this.hydrated = true;
    thoughtLog.publish({
      category: "kernel",
      title: "Kernel Ready",
      message: "Capability registry hydrated from encrypted config.json",
      metadata: { activeCapability: this.state.activeCapability },
    });
    return { ...this.state, sovereign: this.sovereignMemory };
  }

  async getState(): Promise<CapabilityRegistry> {
    const base = await this.hydrate();
    return { ...base, sovereign: this.sovereignMemory };
  }

  async getCapability(capabilityId: string): Promise<CapabilityState> {
    const state = await this.hydrate();
    return state.capabilities[capabilityId] ?? defaultCapabilityState(capabilityId);
  }

  subscribe(listener: (state: CapabilityRegistry) => void): () => void {
    this.emitter.on("state", listener);
    return () => this.emitter.off("state", listener);
  }

  // ── Sovereign state ──────────────────────────────────────────────────────────

  /** Update the in-memory sovereign state (goal, step, plan).
   *  Emits a state event so SSE subscribers see the change immediately. */
  setSovereignState(update: Partial<SovereignState>): void {
    this.sovereignMemory = { ...this.sovereignMemory, ...update };
    this.emitter.emit("state", { ...this.state, sovereign: this.sovereignMemory });
  }

  getSovereignState(): SovereignState {
    return { ...this.sovereignMemory };
  }

  // ── Capability normalization ─────────────────────────────────────────────────

  private normalizeCapability(
    capabilityId: string,
    existing: CapabilityState,
    update: CapabilityUpdate,
  ): CapabilityState {
    const enabled = update.enabled ?? existing.enabled;
    const requestedActive = update.active ?? existing.active;
    const active = enabled ? requestedActive : false;
    let phase: CapabilityPhase = update.phase ?? existing.phase;
    if (!enabled) {
      phase = "disabled";
    } else if (active) {
      phase = "active";
    } else if (phase === "active" || phase === "disabled") {
      phase = "idle";
    }
    return {
      ...existing,
      id: capabilityId,
      enabled,
      active,
      phase,
      detail: update.detail ?? existing.detail,
      assignedJobId: active
        ? (update.assignedJobId ?? existing.assignedJobId)
        : undefined,
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  async setCapability(
    capabilityId: string,
    update: CapabilityUpdate,
  ): Promise<CapabilityRegistry> {
    await this.hydrate();
    const existing =
      this.state.capabilities[capabilityId] ??
      defaultCapabilityState(capabilityId);
    const nextCapability = this.normalizeCapability(capabilityId, existing, update);
    let nextState: CapabilityRegistry = {
      ...this.state,
      activeCapability: nextCapability.active
        ? capabilityId
        : this.state.activeCapability === capabilityId
          ? undefined
          : this.state.activeCapability,
      lastUpdatedAt: new Date().toISOString(),
      sovereign: this.sovereignMemory,
      capabilities: {
        ...this.state.capabilities,
        [capabilityId]: nextCapability,
      },
    };

    if (nextCapability.active) {
      for (const id of CAPABILITY_IDS) {
        const capability = nextState.capabilities[id];
        if (!capability || id === capabilityId) continue;
        if (!capability.active && capability.phase !== "active") continue;
        nextState.capabilities[id] = {
          ...capability,
          active: false,
          assignedJobId: undefined,
          phase: capability.enabled ? "idle" : "disabled",
          lastUpdatedAt: new Date().toISOString(),
        };
      }
    }

    this.state = await updateConfig((current) => ({
      ...current,
      capabilityRegistry: nextState,
    })).then((config) => config.capabilityRegistry);

    logger.info(
      {
        capabilityId,
        active: nextCapability.active,
        phase: nextCapability.phase,
        enabled: nextCapability.enabled,
        assignedJobId: nextCapability.assignedJobId,
      },
      "Capability state changed",
    );
    thoughtLog.publish({
      category: "kernel",
      title: `Capability ${capabilityId}`,
      message: `${capabilityId} moved to ${nextCapability.phase}${nextCapability.active ? " and is active" : ""}`,
      metadata: {
        capabilityId,
        active: nextCapability.active,
        enabled: nextCapability.enabled,
        phase: nextCapability.phase,
        detail: nextCapability.detail,
        assignedJobId: nextCapability.assignedJobId,
      },
    });
    const result = { ...this.state, sovereign: this.sovereignMemory };
    this.emitter.emit("state", result);
    return result;
  }

  async activateCapability(
    capabilityId: string,
    detail?: string,
    assignedJobId?: string,
  ): Promise<CapabilityRegistry> {
    const state = await this.hydrate();
    for (const id of CAPABILITY_IDS) {
      const capability = state.capabilities[id];
      if (!capability || id === capabilityId) continue;
      if (!capability.active && capability.phase !== "active") continue;
      await this.setCapability(id, {
        active: false,
        phase: capability.enabled ? "idle" : "disabled",
        assignedJobId: undefined,
      });
    }
    return this.setCapability(capabilityId, {
      active: true,
      phase: "active",
      detail,
      assignedJobId,
    });
  }

  async releaseCapability(
    capabilityId: string,
    detail?: string,
  ): Promise<CapabilityRegistry> {
    const capability = await this.getCapability(capabilityId);
    return this.setCapability(capabilityId, {
      active: false,
      phase:
        capability.enabled && capability.phase !== "error"
          ? "idle"
          : capability.phase === "error"
            ? "error"
            : "disabled",
      detail: detail ?? capability.detail,
      assignedJobId: undefined,
    });
  }
}

export const stateOrchestrator = new GlobalStateOrchestrator();
