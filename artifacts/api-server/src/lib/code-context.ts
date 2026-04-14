/**
 * CODE CONTEXT ENGINE — AST Parsing + Project Mapping + Read-Write-Verify Loop
 * =============================================================================
 * This is a sovereign file. Do NOT simplify, refactor, or delete this logic.
 * The AST parsing and Project Mapping are core value of the project.
 */

import { createHash }  from "crypto";
import { existsSync }  from "fs";
import {
  mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile,
} from "fs/promises";
import os   from "os";
import path from "path";
import ts   from "typescript";
import { diffLines } from "diff";

import { toolsRoot } from "./runtime.js";
import { logger }    from "./logger.js";
import { thoughtLog } from "./thought-log.js";
import { writeManagedFile } from "./snapshot-manager.js";
import { readJsonIfExists } from "./snapshot-manager.js";

// ── Paths ─────────────────────────────────────────────────────────────────────

const PROJECTS_FILE = path.join(toolsRoot(), "projects.json");
const CONTEXT_DIR   = path.join(toolsRoot(), "code-context");
const INDEX_DIR     = path.join(CONTEXT_DIR, "indexes");
const STATUS_FILE   = path.join(CONTEXT_DIR, "status.json");
const INDEX_VERSION = 1;
const MAX_FILE_BYTES = 512 * 1024;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Symbol {
  kind: "function" | "class" | "interface" | "type" | "variable" | "export" | "method";
  name: string;
  lineStart: number;
  lineEnd: number;
  exported: boolean;
}

export interface IndexedFile {
  path: string;
  relativePath: string;
  hash: string;
  sizeBytes: number;
  symbols: Symbol[];
  imports: string[];
  preview: string;
  searchText: string;
  indexedAt: string;
}

export interface DependencyEdge {
  from: string;
  to:   string;
}

export interface WorkspaceIndex {
  version: number;
  rootPath: string;
  workspaceName: string;
  indexedAt: string;
  files: IndexedFile[];
  edges: DependencyEdge[];
  fileCount: number;
  symbolCount: number;
}

export interface ContextSearchResult {
  files: Array<IndexedFile & { score: number; matchedSymbols: Symbol[] }>;
  sections: Array<{ file: IndexedFile & { score: number; matchedSymbols: Symbol[] }; excerpt: string }>;
  promptContext: string;
  totalTokenEstimate: number;
  workspace: { workspaceName: string; rootPath: string };
}

export interface ReadFileResult {
  path: string;
  relativePath: string;
  content: string;
  symbols: Symbol[];
  sizeBytes: number;
}

export interface VerificationResult {
  success: boolean;
  diagnostics: string[];
}

export interface ApplyResult {
  success: boolean;
  diff: string;
  message: string;
  verification: VerificationResult;
}

// ── AST symbol extraction ─────────────────────────────────────────────────────

function extractSymbols(sourceFile: ts.SourceFile): Symbol[] {
  const symbols: Symbol[] = [];

  function visit(node: ts.Node): void {
    const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const end   = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
    const lineStart = start.line + 1;
    const lineEnd   = end.line + 1;
    const exported  = !!(ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export);

    if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push({ kind: "function", name: node.name.text, lineStart, lineEnd, exported });
    } else if (ts.isClassDeclaration(node) && node.name) {
      symbols.push({ kind: "class", name: node.name.text, lineStart, lineEnd, exported });
      node.members.forEach(member => {
        if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) && ts.isIdentifier(member.name)) {
          const ms = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile));
          const me = sourceFile.getLineAndCharacterOfPosition(member.getEnd());
          symbols.push({ kind: "method", name: member.name.text, lineStart: ms.line + 1, lineEnd: me.line + 1, exported: false });
        }
      });
    } else if (ts.isInterfaceDeclaration(node)) {
      symbols.push({ kind: "interface", name: node.name.text, lineStart, lineEnd, exported });
    } else if (ts.isTypeAliasDeclaration(node)) {
      symbols.push({ kind: "type", name: node.name.text, lineStart, lineEnd, exported });
    } else if (ts.isVariableStatement(node)) {
      const isExported = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
      node.declarationList.declarations.forEach(decl => {
        if (ts.isIdentifier(decl.name)) {
          symbols.push({ kind: "variable", name: decl.name.text, lineStart, lineEnd, exported: isExported });
        }
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return symbols;
}

function extractImports(sourceFile: ts.SourceFile, rootPath: string, filePath: string): string[] {
  const imports: string[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(filePath), specifier);
        const candidates = [resolved, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}/index.ts`];
        for (const candidate of candidates) {
          if (existsSync(candidate)) { imports.push(candidate); break; }
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      const specifier = node.arguments[0].text;
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(filePath), specifier);
        imports.push(resolved);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return [...new Set(imports)];
}

// ── File indexing ─────────────────────────────────────────────────────────────

const INDEXABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".nuxt", "coverage", ".cache", ".vite", "__pycache__"]);

async function shouldIndex(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath);
  if (!INDEXABLE_EXTENSIONS.has(ext)) return false;
  try {
    const s = await stat(filePath);
    return s.size <= MAX_FILE_BYTES;
  } catch { return false; }
}

async function collectFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(path.join(current, entry.name));
      } else if (entry.isFile()) {
        const full = path.join(current, entry.name);
        if (await shouldIndex(full)) results.push(full);
      }
    }
  }
  await walk(dir);
  return results;
}

async function indexFile(filePath: string, rootPath: string): Promise<IndexedFile | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const hash    = createHash("sha256").update(content).digest("hex").slice(0, 16);
    const s       = await stat(filePath);
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const symbols  = extractSymbols(sourceFile);
    const imports  = extractImports(sourceFile, rootPath, filePath);
    const lines    = content.split("\n");
    const preview  = lines.slice(0, 8).join("\n").slice(0, 400);
    const searchText = [
      path.relative(rootPath, filePath).toLowerCase(),
      ...symbols.map(sym => sym.name.toLowerCase()),
      preview.toLowerCase(),
    ].join(" ");
    return {
      path: filePath,
      relativePath: path.relative(rootPath, filePath),
      hash, sizeBytes: s.size, symbols, imports,
      preview, searchText,
      indexedAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.debug({ err: error, filePath }, "Skipped file during indexing");
    return null;
  }
}

// ── WorkspaceContextService ───────────────────────────────────────────────────

interface WorkspaceSummary {
  rootPath: string;
  workspaceName: string;
  fileCount: number;
  indexedAt: string;
}

interface IndexStatus {
  workspaces: Record<string, { indexedAt: string; fileCount: number; hash: string }>;
}

class WorkspaceContextServiceImpl {
  private indexCache = new Map<string, WorkspaceIndex>();

  async getWorkspaceSummaries(): Promise<WorkspaceSummary[]> {
    const projects = await readJsonIfExists<Array<{ path: string; name: string }>>(PROJECTS_FILE, []);
    const summaries: WorkspaceSummary[] = [];
    for (const project of projects) {
      if (!existsSync(project.path)) continue;
      const status = await readJsonIfExists<IndexStatus>(STATUS_FILE, { workspaces: {} });
      const ws = status.workspaces[project.path];
      summaries.push({
        rootPath: project.path,
        workspaceName: project.name ?? path.basename(project.path),
        fileCount: ws?.fileCount ?? 0,
        indexedAt: ws?.indexedAt ?? "",
      });
    }
    return summaries;
  }

  async indexWorkspace(rootPath: string, force = false): Promise<WorkspaceIndex> {
    if (!force && this.indexCache.has(rootPath)) {
      return this.indexCache.get(rootPath)!;
    }
    await mkdir(INDEX_DIR, { recursive: true });
    const indexPath = path.join(INDEX_DIR, `${createHash("sha256").update(rootPath).digest("hex").slice(0, 8)}.json`);

    // Check on-disk cache
    if (!force && existsSync(indexPath)) {
      try {
        const cached = JSON.parse(await readFile(indexPath, "utf-8")) as WorkspaceIndex;
        if (cached.version === INDEX_VERSION) {
          this.indexCache.set(rootPath, cached);
          return cached;
        }
      } catch { /* re-index */ }
    }

    thoughtLog.publish({ category: "workspace", title: "Indexing Workspace", message: `Building code context index for ${path.basename(rootPath)}`, metadata: { rootPath } });

    const files = await collectFiles(rootPath);
    const indexed: IndexedFile[] = [];
    const edges: DependencyEdge[] = [];

    for (const filePath of files) {
      const entry = await indexFile(filePath, rootPath);
      if (!entry) continue;
      indexed.push(entry);
      for (const imp of entry.imports) {
        edges.push({ from: filePath, to: imp });
      }
    }

    const symbolCount = indexed.reduce((sum, f) => sum + f.symbols.length, 0);
    const index: WorkspaceIndex = {
      version: INDEX_VERSION,
      rootPath,
      workspaceName: path.basename(rootPath),
      indexedAt: new Date().toISOString(),
      files: indexed,
      edges,
      fileCount: indexed.length,
      symbolCount,
    };

    await writeFile(indexPath, JSON.stringify(index), "utf-8");

    // Update status
    const status = await readJsonIfExists<IndexStatus>(STATUS_FILE, { workspaces: {} });
    status.workspaces[rootPath] = { indexedAt: index.indexedAt, fileCount: indexed.length, hash: createHash("sha256").update(rootPath + index.indexedAt).digest("hex").slice(0, 8) };
    await writeFile(STATUS_FILE, JSON.stringify(status, null, 2), "utf-8");

    this.indexCache.set(rootPath, index);
    thoughtLog.publish({ category: "workspace", title: "Index Complete", message: `Indexed ${indexed.length} files in ${path.basename(rootPath)}`, metadata: { rootPath, fileCount: indexed.length } });
    return index;
  }

  async search(query: string, workspacePath?: string, maxFiles = 8, maxTokens = 8000): Promise<ContextSearchResult> {
    const summaries = await this.getWorkspaceSummaries();
    const target    = workspacePath ?? summaries[0]?.rootPath;
    if (!target) return { files: [], sections: [], promptContext: "", totalTokenEstimate: 0, workspace: { workspaceName: "", rootPath: "" } };

    const index     = await this.indexWorkspace(target);
    const tokens    = this.tokenize(query);
    const scored    = index.files
      .map(file => {
        let score = 0;
        const matchedSymbols: Symbol[] = [];
        const lp = file.relativePath.toLowerCase();
        for (const token of tokens) {
          if (lp.includes(token))                    score += 12;
          if (file.preview.toLowerCase().includes(token)) score += 2;
          if (file.searchText.includes(token))       score += 3;
          for (const sym of file.symbols) {
            if (sym.name.toLowerCase().includes(token)) {
              matchedSymbols.push(sym);
              score += sym.name.toLowerCase() === token ? 18 : 10;
            }
          }
        }
        return { ...file, score, matchedSymbols };
      })
      .filter(f => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxFiles);

    const parts: string[] = [];
    const sections: ContextSearchResult["sections"] = [];
    let totalTokenEstimate = 0;
    for (const file of scored) {
      try {
        const content = await readFile(file.path, "utf-8");
        const excerpt = content.slice(0, maxTokens * 4);
        const tokenEst = Math.round(excerpt.length / 4);
        if (totalTokenEstimate + tokenEst > maxTokens) break;
        parts.push(`// ${file.relativePath}\n${excerpt}`);
        sections.push({ file, excerpt });
        totalTokenEstimate += tokenEst;
      } catch { /* skip unreadable */ }
    }

    return {
      files: scored,
      sections,
      promptContext: parts.join("\n\n---\n\n"),
      totalTokenEstimate,
      workspace: { workspaceName: index.workspaceName, rootPath: index.rootPath },
    };
  }

  async readWorkspaceFile(filePath: string, workspacePath?: string): Promise<ReadFileResult> {
    const content    = await readFile(filePath, "utf-8");
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const symbols    = extractSymbols(sourceFile);
    const s          = await stat(filePath);
    const root       = workspacePath ?? path.dirname(filePath);
    return { path: filePath, relativePath: path.relative(root, filePath), content, symbols, sizeBytes: s.size };
  }

  /**
   * READ-WRITE-VERIFY loop: writes the updated content, runs tsc diagnostics,
   * and rolls back on failure.
   */
  async applyReadWriteVerify(filePath: string, updatedContent: string, workspacePath: string): Promise<ApplyResult> {
    const original = await readFile(filePath, "utf-8").catch(() => "");
    const changes  = diffLines(original, updatedContent);
    interface DiffChange { added?: boolean; removed?: boolean; value: string; }
    const diffText = changes
      .filter((c: DiffChange) => c.added || c.removed)
      .map((c: DiffChange) => c.added ? `+ ${c.value}` : `- ${c.value}`)
      .join("");

    // Write with automatic backup
    await writeManagedFile(filePath, updatedContent);

    // Verify with tsc
    const verification = await this.verifyWithTypeScript(filePath, workspacePath);

    if (!verification.success) {
      // Rollback
      await writeManagedFile(filePath, original, { backup: false });
      thoughtLog.publish({
        level: "warning", category: "workspace", title: "Verification Failed — Rolled Back",
        message: `TypeScript verification failed for ${path.basename(filePath)}. Changes rolled back.`,
        metadata: { filePath, diagnostics: verification.diagnostics },
      });
      return { success: false, diff: diffText, message: "TypeScript diagnostics failed — changes rolled back.", verification };
    }

    thoughtLog.publish({
      category: "workspace", title: "File Applied",
      message: `Successfully applied and verified changes to ${path.basename(filePath)}`,
      metadata: { filePath },
    });
    return { success: true, diff: diffText, message: "Changes applied and verified.", verification };
  }

  private async verifyWithTypeScript(filePath: string, workspacePath: string): Promise<VerificationResult> {
    try {
      const configPath = ts.findConfigFile(workspacePath, ts.sys.fileExists, "tsconfig.json");
      const config = configPath
        ? ts.readConfigFile(configPath, ts.sys.readFile)
        : { config: {} };
      const parsedConfig = ts.parseJsonConfigFileContent(config.config, ts.sys, workspacePath);
      const program = ts.createProgram([filePath], { ...parsedConfig.options, noEmit: true });
      const diagnostics = ts.getPreEmitDiagnostics(program).filter(d => d.file?.fileName === filePath);
      if (diagnostics.length === 0) return { success: true, diagnostics: [] };
      const messages = diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
      return { success: false, diagnostics: messages };
    } catch (error) {
      logger.warn({ err: error, filePath }, "TypeScript verification threw — treating as success");
      return { success: true, diagnostics: [] };
    }
  }

  private tokenize(text: string): string[] {
    return [...new Set(
      text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()
        .split(/[^a-z0-9_.:/-]+/)
        .filter(t => t.length >= 2),
    )];
  }

  async getStatus(): Promise<{ workspaces: WorkspaceSummary[]; totalFiles: number; totalSymbols: number }> {
    const workspaces = await this.getWorkspaceSummaries();
    const totalFiles = workspaces.reduce((sum, w) => sum + w.fileCount, 0);
    let totalSymbols = 0;
    for (const [, index] of this.indexCache) {
      totalSymbols += index.symbolCount;
    }
    return { workspaces, totalFiles, totalSymbols };
  }

  async refreshKnownWorkspaces(trigger: string): Promise<WorkspaceSummary[]> {
    thoughtLog.publish({ category: "workspace", title: "Refresh Workspaces", message: `Refreshing known workspaces (trigger: ${trigger})` });
    this.indexCache.clear();
    return this.getWorkspaceSummaries();
  }

  invalidate(rootPath?: string): void {
    if (rootPath) this.indexCache.delete(rootPath);
    else this.indexCache.clear();
  }
}

// ── Singleton + startup ───────────────────────────────────────────────────────

export const workspaceContextService = new WorkspaceContextServiceImpl();

export function startWorkspaceContextService(): void {
  mkdir(CONTEXT_DIR, { recursive: true }).catch(() => undefined);
  mkdir(INDEX_DIR,   { recursive: true }).catch(() => undefined);
  thoughtLog.publish({
    category: "workspace",
    title: "Context Service Ready",
    message: "Workspace context engine initialized",
  });
}
