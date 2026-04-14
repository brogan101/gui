import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "fs/promises";
import { existsSync } from "fs";
import path from "path";
import { isWindows, execCommand, shellQuote } from "./runtime.js";
import { logger } from "./logger.js";
import { thoughtLog } from "./thought-log.js";

export interface BackupMetadata {
  filePath: string;
  backupPath: string;
  exists: boolean;
  createdAt?: string;
  sizeBytes?: number;
  currentPath?: string;
}

export interface WriteManagedOptions {
  backup?: boolean;
  encoding?: BufferEncoding;
}

function isBackupArtifact(targetPath: string): boolean {
  return (
    targetPath.includes(`${path.sep}.localai-backups${path.sep}`) ||
    targetPath.endsWith(".bak")
  );
}

function getBackupDirectory(filePath: string): string {
  return path.join(path.dirname(filePath), ".localai-backups");
}

function getBackupPath(filePath: string): string {
  return path.join(
    getBackupDirectory(filePath),
    `${path.basename(filePath)}.bak`,
  );
}

async function hideDirectoryOnWindows(directoryPath: string): Promise<void> {
  if (!isWindows) return;
  await execCommand(`attrib +h ${shellQuote(directoryPath)}`, 5000).catch(
    () => undefined,
  );
}

async function ensureBackupDirectory(filePath: string): Promise<string> {
  const directoryPath = getBackupDirectory(filePath);
  await mkdir(directoryPath, { recursive: true });
  await hideDirectoryOnWindows(directoryPath);
  return directoryPath;
}

export async function getBackupMetadata(
  filePath: string,
): Promise<BackupMetadata> {
  const backupPath = getBackupPath(filePath);
  if (!existsSync(backupPath)) {
    return { filePath, backupPath, exists: false };
  }
  const backupStats = await stat(backupPath);
  return {
    filePath,
    backupPath,
    exists: true,
    createdAt: backupStats.mtime.toISOString(),
    sizeBytes: backupStats.size,
  };
}

async function createBackupIfExists(
  filePath: string,
): Promise<BackupMetadata> {
  if (isBackupArtifact(filePath) || !existsSync(filePath)) {
    return getBackupMetadata(filePath);
  }
  const backupPath = getBackupPath(filePath);
  await ensureBackupDirectory(filePath);
  await copyFile(filePath, backupPath);
  const metadata = await getBackupMetadata(filePath);
  logger.info({ filePath, backupPath }, "Created rollback backup");
  thoughtLog.publish({
    category: "rollback",
    title: "Backup Created",
    message: `Created rollback snapshot for ${path.basename(filePath)}`,
    metadata: { filePath, backupPath },
  });
  return metadata;
}

export async function writeManagedFile(
  filePath: string,
  content: string | Buffer,
  options: WriteManagedOptions = {},
): Promise<BackupMetadata> {
  const encoding = options.encoding ?? "utf-8";
  const shouldBackup = options.backup !== false;
  await mkdir(path.dirname(filePath), { recursive: true });
  let backupMetadata = await getBackupMetadata(filePath);
  if (shouldBackup && existsSync(filePath) && !isBackupArtifact(filePath)) {
    backupMetadata = await createBackupIfExists(filePath);
  }
  if (typeof content === "string") {
    await writeFile(filePath, content, { encoding });
  } else {
    await writeFile(filePath, content);
  }
  return backupMetadata;
}

export async function writeManagedJson(
  filePath: string,
  payload: unknown,
  options: WriteManagedOptions = {},
): Promise<BackupMetadata> {
  return writeManagedFile(filePath, JSON.stringify(payload, null, 2), options);
}

export async function readJsonIfExists<T>(
  filePath: string,
  fallback: T,
): Promise<T> {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(await readFile(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

export async function rollbackFile(filePath: string): Promise<BackupMetadata> {
  const metadata = await getBackupMetadata(filePath);
  if (!metadata.exists) {
    throw new Error(`No backup exists for ${filePath}`);
  }
  let currentPath: string | undefined;
  if (existsSync(filePath)) {
    currentPath = `${metadata.backupPath}.current`;
    await copyFile(filePath, currentPath);
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await copyFile(metadata.backupPath, filePath);
  logger.warn(
    { filePath, backupPath: metadata.backupPath },
    "Rolled back file from backup",
  );
  thoughtLog.publish({
    level: "warning",
    category: "rollback",
    title: "Rollback Applied",
    message: `Restored ${path.basename(filePath)} from snapshot backup`,
    metadata: { filePath, backupPath: metadata.backupPath, currentPath },
  });
  return { ...metadata, currentPath };
}

export async function listBackupMetadata(
  directoryPath: string,
): Promise<BackupMetadata[]> {
  const results: BackupMetadata[] = [];
  if (!existsSync(directoryPath)) return results;
  const entries = await readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name !== ".localai-backups") continue;
    const backupDirectory = path.join(directoryPath, entry.name);
    const backupFiles = await readdir(backupDirectory, { withFileTypes: true });
    for (const backupFile of backupFiles) {
      if (!backupFile.isFile()) continue;
      if (!backupFile.name.endsWith(".bak")) continue;
      const originalPath = path.join(
        directoryPath,
        backupFile.name.slice(0, -4),
      );
      results.push(await getBackupMetadata(originalPath));
    }
  }
  return results.sort((l, r) =>
    (r.createdAt || "").localeCompare(l.createdAt || ""),
  );
}
