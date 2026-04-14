/**
 * SOVEREIGN SELF-EDIT ENGINE
 * ===========================
 * Allows the AI to propose and apply modifications to its own source files.
 * Every edit is backed up via the snapshot-manager before writing.
 * Server restart is triggered by exiting the process (tsx watch / pm2 / the
 * Windows launcher script will respawn it automatically).
 *
 * Safety constraints:
 *   • Only files inside ALLOWED_SOURCE_ROOTS may be modified.
 *   • The change is diff-previewed before applying.
 *   • A backup is always created by writeManagedFile.
 */

import path from "path";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { diffLines } from "diff";
import { writeManagedFile } from "./snapshot-manager.js";
import { logger } from "./logger.js";
import { thoughtLog } from "./thought-log.js";

// ── Source root resolution ────────────────────────────────────────────────────

function resolveSourceRoot(): string {
  // In the esbuild bundle __dirname points to /dist; walk up to the repo root.
  // In tsx dev mode __dirname is the actual src/lib directory.
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Walk up until we find a package.json that belongs to the api-server
  let current = here;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(current, "package.json");
    if (existsSync(candidate)) return current;
    current = path.dirname(current);
  }
  return here;
}

const REPO_ROOT = resolveSourceRoot();

/** Only these paths are writable via self-edit. */
const ALLOWED_SOURCE_ROOTS: string[] = [
  path.join(REPO_ROOT, "src"),
  path.join(REPO_ROOT, "artifacts"),
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SelfEditProposal {
  filePath: string;
  oldContent: string;
  newContent: string;
  diff: string;
  lineCount: { before: number; after: number; added: number; removed: number };
}

export interface SelfEditResult {
  success: boolean;
  filePath: string;
  diff: string;
  backupPath: string;
  message: string;
}

// ── Guards ────────────────────────────────────────────────────────────────────

function isAllowedPath(filePath: string): boolean {
  const normalized = path.normalize(filePath);
  return ALLOWED_SOURCE_ROOTS.some(root => normalized.startsWith(root));
}

function computeDiff(before: string, after: string): string {
  return diffLines(before, after)
    .map(part => {
      const prefix = part.added ? "+" : part.removed ? "-" : " ";
      return (part.value.split("\n").filter((_, i, arr) => i < arr.length - 1 || part.value.endsWith("\n") || arr.length === 1))
        .map(line => `${prefix}${line}`)
        .join("\n");
    })
    .join("");
}

// ── Core API ──────────────────────────────────────────────────────────────────

/** Read a file and prepare a self-edit proposal (preview only, no write). */
export async function proposeSelfEdit(
  filePath: string,
  newContent: string,
): Promise<SelfEditProposal> {
  const normalized = path.normalize(filePath);
  if (!isAllowedPath(normalized)) {
    throw new Error(`Self-edit denied: ${normalized} is outside the allowed source roots.`);
  }
  const oldContent = existsSync(normalized)
    ? await readFile(normalized, "utf-8")
    : "";
  const diff = computeDiff(oldContent, newContent);
  const beforeLines = oldContent.split("\n").length;
  const afterLines  = newContent.split("\n").length;
  const addedLines   = diff.split("\n").filter(l => l.startsWith("+")).length;
  const removedLines = diff.split("\n").filter(l => l.startsWith("-")).length;
  return {
    filePath: normalized,
    oldContent,
    newContent,
    diff,
    lineCount: { before: beforeLines, after: afterLines, added: addedLines, removed: removedLines },
  };
}

/** Apply a self-edit proposal.  Backs up the original file first. */
export async function applySelfEdit(
  proposal: SelfEditProposal,
): Promise<SelfEditResult> {
  const { filePath, newContent, diff } = proposal;
  if (!isAllowedPath(filePath)) {
    throw new Error(`Self-edit denied: ${filePath} is outside the allowed source roots.`);
  }
  logger.warn({ filePath, addedLines: proposal.lineCount.added, removedLines: proposal.lineCount.removed }, "Sovereign self-edit applying");
  const backup = await writeManagedFile(filePath, newContent);
  thoughtLog.publish({
    level:    "warning",
    category: "system",
    title:    "Sovereign Self-Edit Applied",
    message:  `${path.basename(filePath)} modified — +${proposal.lineCount.added}/-${proposal.lineCount.removed} lines`,
    metadata: {
      filePath,
      backupPath: backup.backupPath,
      linesBefore: proposal.lineCount.before,
      linesAfter:  proposal.lineCount.after,
    },
  });
  return {
    success:    true,
    filePath,
    diff,
    backupPath: backup.backupPath ?? "",
    message:    `Applied self-edit to ${path.basename(filePath)}. Restart the server to load changes.`,
  };
}

/** Convenience: propose then immediately apply a self-edit in one call. */
export async function sovereignEdit(
  filePath: string,
  newContent: string,
): Promise<SelfEditResult> {
  const proposal = await proposeSelfEdit(filePath, newContent);
  return applySelfEdit(proposal);
}

// ── Server restart ────────────────────────────────────────────────────────────

/**
 * Trigger a graceful server restart.
 * In `tsx watch` dev mode: writing any .ts file triggers automatic reload.
 * In production (pm2 / Windows Service): exit code 0 causes the supervisor to respawn.
 * In standalone production mode: call with `force = true` to hard-exit.
 */
export function triggerServerRestart(reason = "Sovereign restart requested", delayMs = 500): void {
  thoughtLog.publish({
    level:    "warning",
    category: "kernel",
    title:    "Server Restart Triggered",
    message:  reason,
    metadata: { delayMs },
  });
  logger.warn({ reason, delayMs }, "Server restart triggered");
  setTimeout(() => {
    process.exit(0); // supervisor (tsx watch / pm2 / Windows service) will respawn
  }, delayMs);
}
