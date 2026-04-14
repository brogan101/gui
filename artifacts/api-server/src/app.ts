import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import type { Options as PinoHttpOptions } from "pino-http";
import { logger } from "./lib/logger.js";
import { thoughtLog } from "./lib/thought-log.js";
import { stateOrchestrator } from "./lib/state-orchestrator.js";
import { distributedNodeAuthMiddleware, startDistributedNodeHeartbeat } from "./lib/network-proxy.js";
import { getUniversalGatewayTags } from "./lib/model-orchestrator.js";
import routes from "./routes/index.js";

const app = express();

// ── Structured request logging ────────────────────────────────────────────────

const pinoHttpOptions: PinoHttpOptions = {
  logger,
  serializers: {
    req(req: { id: unknown; method: string; url?: string }) {
      return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
    },
    res(res: { statusCode: number }) {
      return { statusCode: res.statusCode };
    },
  },
};

app.use(pinoHttp(pinoHttpOptions));

// ── Standard middleware ───────────────────────────────────────────────────────

app.use(cors());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(distributedNodeAuthMiddleware);
app.use("/api", routes);

// ── Background service boot sequence ─────────────────────────────────────────
//
// Order matters:
//   1. Hydrate the capability registry from encrypted config.
//   2. Start the distributed-node heartbeat monitor.
//   3. Run the boot-time Ollama catalog sync — populates the model cache and
//      updates sovereign state with lastCatalogSync + catalogModelCount.

void stateOrchestrator.hydrate();

startDistributedNodeHeartbeat();

thoughtLog.publish({
  category: "kernel",
  title:    "Boot: Services Starting",
  message:  "Express application bootstrapped — initiating background service startup",
});

void getUniversalGatewayTags(true)
  .then((gateway) => {
    // Update sovereign state with catalog sync results
    stateOrchestrator.setSovereignState({
      lastCatalogSync:    new Date().toISOString(),
      catalogModelCount:  gateway.models.length,
    });

    thoughtLog.publish({
      category: "kernel",
      title:    "Boot: Catalog Synced",
      message:  `Ollama catalog sync complete — ${gateway.models.length} model(s) available, VRAM guard: ${gateway.vramGuard.mode} (${gateway.vramGuard.status})`,
      metadata: {
        modelCount:      gateway.models.length,
        ollamaReachable: gateway.ollamaReachable,
        vramMode:        gateway.vramGuard.mode,
        vramStatus:      gateway.vramGuard.status,
        gpuName:         gateway.vramGuard.gpuName,
        totalVram:       gateway.vramGuard.totalBytes,
        freeVram:        gateway.vramGuard.freeBytes,
        models:          gateway.models.map(m => m.name),
      },
    });
  })
  .catch((err: unknown) => {
    thoughtLog.publish({
      level:    "warning",
      category: "kernel",
      title:    "Boot: Catalog Sync Skipped",
      message:  "Ollama not reachable at startup — catalog will sync on first API request",
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
  });

export default app;
