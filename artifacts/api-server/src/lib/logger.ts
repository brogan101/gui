import pino from "pino";
import { existsSync, mkdirSync } from "fs";
import os from "os";
import path from "path";
import { toolsRoot } from "./runtime.js";

const LOG_DIR = path.join(os.homedir(), "LocalAI-Tools", "logs");
const LOG_FILE = path.join(LOG_DIR, "system.log");

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

const fileDestination = pino.destination({
  dest: LOG_FILE,
  sync: false,
});

export const logger = pino(
  {
    level: process.env["LOG_LEVEL"] ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
    ],
    base: {
      service: "localai-api-server",
      logFile: LOG_FILE,
    },
  },
  fileDestination,
);

export { toolsRoot };
