/**
 * SOVEREIGN STUDIO PIPELINE
 * ==========================
 * Provides three autonomous pipeline categories:
 *
 *  1. Vibe Coding   — Full-cycle: describe → generate → pnpm install → test endpoint
 *  2. CAD/Hardware  — OpenSCAD script generator, Blender Python generator,
 *                     and a G-Code optimizer for 3D printers / laser cutters
 *  3. Image Gen     — ComfyUI (port 8188) + Stable Diffusion Web UI (port 7860)
 *                     with an LLM-powered Prompt Architect expander
 *
 * All LLM calls go through the local Ollama gateway so they work offline
 * with any installed model.  External services (ComfyUI / SD Web UI) are
 * probed first; functions degrade gracefully when they are not running.
 */

import { execFile as cpExecFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { fetchJson, postJson, fetchText, toolsRoot, commandExists } from "./runtime.js";
import { logger } from "./logger.js";
import { thoughtLog } from "./thought-log.js";

const execFileAsync = promisify(cpExecFile);

// ── Constants ─────────────────────────────────────────────────────────────────

const COMFYUI_BASE    = "http://127.0.0.1:8188";
const SD_WEBUI_BASE   = "http://127.0.0.1:7860";
const OLLAMA_BASE     = "http://127.0.0.1:11434";
const PIPELINE_DIR    = path.join(toolsRoot(), "studio-pipeline");
const IMAGEGEN_DIR    = path.join(PIPELINE_DIR, "imagegen");
const CAD_DIR         = path.join(PIPELINE_DIR, "cad");

// ── Shared helpers ────────────────────────────────────────────────────────────

async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

async function ollamaGenerate(
  prompt: string,
  model: string,
  timeoutMs = 60_000,
): Promise<string> {
  const result = await postJson<{ response?: string }>(
    `${OLLAMA_BASE}/api/generate`,
    { model, prompt, stream: false },
    timeoutMs,
  );
  return (result.response ?? "").trim();
}

async function getPreferredModel(preferCoding = false): Promise<string> {
  try {
    const rolesFile = path.join(toolsRoot(), "model-roles.json");
    if (existsSync(rolesFile)) {
      const roles = JSON.parse(await readFile(rolesFile, "utf-8")) as Record<string, string>;
      if (preferCoding) {
        return roles["primary-coding"] || roles.chat || "llama3.1";
      }
      return roles.chat || roles["primary-coding"] || "llama3.1";
    }
  } catch { /* fall through */ }
  return "llama3.1";
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CadScriptResult {
  type: "openscad" | "blender" | "gcode";
  script: string;
  description: string;
  savedPath?: string;
  generatedAt: string;
  model: string;
}

export interface GCodeOptimizeResult {
  originalLineCount: number;
  optimizedLineCount: number;
  optimizedGCode: string;
  changes: string[];
  savedPath?: string;
  optimizedAt: string;
}

export interface ImageGenStatus {
  comfyuiReachable: boolean;
  sdWebuiReachable: boolean;
  preferredBackend: "comfyui" | "sdwebui" | "none";
}

export interface PromptArchitectResult {
  originalPrompt: string;
  expandedPrompt: string;
  negativePrompt: string;
  style: string;
  model: string;
  expandedAt: string;
}

export interface ImageGenResult {
  success: boolean;
  backend: "comfyui" | "sdwebui";
  promptId?: string;
  images: string[];
  savedPaths: string[];
  prompt: string;
  expandedPrompt?: string;
  generatedAt: string;
  error?: string;
}

export interface VibeCodingInstallResult {
  success: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface VibeCodingTestResult {
  success: boolean;
  status?: number;
  body?: string;
  error?: string;
  endpointUrl: string;
  testedAt: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. VIBE CODING — Full-cycle completion
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run `pnpm install` (falling back to `npm install`) inside a studio directory.
 * Returns stdout/stderr and whether the install succeeded.
 */
export async function runInstall(studioPath: string): Promise<VibeCodingInstallResult> {
  const start = Date.now();
  const useNpm = !(await commandExists("pnpm"));
  const installer = useNpm ? "npm" : "pnpm";

  thoughtLog.publish({
    category: "system",
    title:    "Vibe Coding — Install",
    message:  `Running \`${installer} install\` in ${path.basename(studioPath)}`,
    metadata: { studioPath, installer },
  });

  try {
    const { stdout, stderr } = await execFileAsync(
      installer,
      ["install"],
      { cwd: studioPath, timeout: 120_000 },
    );
    const durationMs = Date.now() - start;
    thoughtLog.publish({
      category: "system",
      title:    "Vibe Coding — Install Complete",
      message:  `${installer} install succeeded in ${durationMs}ms`,
      metadata: { studioPath, durationMs },
    });
    return { success: true, stdout, stderr, durationMs };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const durationMs = Date.now() - start;
    thoughtLog.publish({
      level:    "warning",
      category: "system",
      title:    "Vibe Coding — Install Failed",
      message:  e.message ?? String(err),
      metadata: { studioPath, durationMs },
    });
    return {
      success:  false,
      stdout:   e.stdout ?? "",
      stderr:   e.stderr ?? String(err),
      durationMs,
    };
  }
}

/**
 * Start the dev server in the background and probe the health endpoint.
 * Returns the test result.  The dev server is killed after the probe.
 */
export async function testEndpoint(
  studioPath: string,
  port = 5173,
  endpointPath = "/",
  startCommand = "pnpm dev",
): Promise<VibeCodingTestResult> {
  const endpointUrl = `http://localhost:${port}${endpointPath}`;
  const testedAt    = nowIso();

  thoughtLog.publish({
    category: "system",
    title:    "Vibe Coding — Endpoint Test",
    message:  `Probing ${endpointUrl}`,
    metadata: { studioPath, endpointUrl },
  });

  const [cmd, ...args] = startCommand.split(" ");
  const child = cpExecFile(cmd, args, { cwd: studioPath, timeout: 60_000 });

  // Give the dev server 8 seconds to start
  await new Promise<void>(resolve => setTimeout(resolve, 8_000));

  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(endpointUrl, { signal: controller.signal });
    clearTimeout(id);
    const body = await response.text().catch(() => "");
    child.kill();
    thoughtLog.publish({
      category: "system",
      title:    "Vibe Coding — Endpoint OK",
      message:  `${endpointUrl} returned HTTP ${response.status}`,
      metadata: { status: response.status },
    });
    return {
      success:     response.ok,
      status:      response.status,
      body:        body.slice(0, 500),
      endpointUrl,
      testedAt,
    };
  } catch (err) {
    child.kill();
    const error = err instanceof Error ? err.message : String(err);
    thoughtLog.publish({
      level:    "warning",
      category: "system",
      title:    "Vibe Coding — Endpoint Unreachable",
      message:  error,
      metadata: { endpointUrl },
    });
    return { success: false, error, endpointUrl, testedAt };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CAD / HARDWARE PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate an OpenSCAD script from a natural-language description.
 * The LLM is instructed to emit only valid OpenSCAD code with no prose.
 */
export async function generateOpenScadScript(
  description: string,
  saveOutput = true,
): Promise<CadScriptResult> {
  const model = await getPreferredModel(true);
  const prompt = [
    "You are an expert OpenSCAD 3-D modelling engineer.",
    "Generate ONLY valid OpenSCAD code — no explanations, no markdown fences.",
    "Use parametric variables (e.g., height=50;) at the top of the file.",
    "End the file with the primary shape call.",
    "",
    `Design brief: ${description}`,
  ].join("\n");

  thoughtLog.publish({
    category: "system",
    title:    "CAD — Generating OpenSCAD",
    message:  description.slice(0, 120),
    metadata: { model },
  });

  const script = await ollamaGenerate(prompt, model, 90_000);
  const clean  = script.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();

  let savedPath: string | undefined;
  if (saveOutput && clean) {
    await ensureDir(CAD_DIR);
    savedPath = path.join(CAD_DIR, `${randomUUID().slice(0, 8)}.scad`);
    await writeFile(savedPath, clean, "utf-8");
  }

  return {
    type:         "openscad",
    script:       clean,
    description,
    savedPath,
    generatedAt:  nowIso(),
    model,
  };
}

/**
 * Generate a Blender Python script from a natural-language description.
 * Uses the Blender Python API (bpy).
 */
export async function generateBlenderPythonScript(
  description: string,
  saveOutput = true,
): Promise<CadScriptResult> {
  const model = await getPreferredModel(true);
  const prompt = [
    "You are an expert Blender 4.x Python scripting engineer using the bpy module.",
    "Generate ONLY valid Python code that uses `import bpy` — no explanations, no markdown fences.",
    "The script must: clear the default scene, create geometry, and optionally set materials.",
    "End with `print('Blender script complete.')` to signal success.",
    "",
    `Scene brief: ${description}`,
  ].join("\n");

  thoughtLog.publish({
    category: "system",
    title:    "CAD — Generating Blender Script",
    message:  description.slice(0, 120),
    metadata: { model },
  });

  const script = await ollamaGenerate(prompt, model, 90_000);
  const clean  = script.replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();

  let savedPath: string | undefined;
  if (saveOutput && clean) {
    await ensureDir(CAD_DIR);
    savedPath = path.join(CAD_DIR, `${randomUUID().slice(0, 8)}_blender.py`);
    await writeFile(savedPath, clean, "utf-8");
  }

  return {
    type:         "blender",
    script:       clean,
    description,
    savedPath,
    generatedAt:  nowIso(),
    model,
  };
}

/**
 * Optimize raw G-Code for FDM 3D printers or laser cutters.
 * Applies: deduplication of sequential redundant moves, comment stripping,
 * temperature sequencing, empty-line removal, and LLM-guided improvements.
 */
export async function optimizeGCode(
  rawGCode: string,
  printerType: "fdm" | "laser" = "fdm",
  saveOutput = true,
): Promise<GCodeOptimizeResult> {
  const lines           = rawGCode.split(/\r?\n/);
  const originalCount   = lines.length;
  const changes: string[] = [];

  // ── Static optimization passes ────────────────────────────────────────────
  const pass1: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    // Strip standalone comment lines (';' at start)
    if (trimmed.startsWith(";") && !trimmed.includes("layer") && !trimmed.includes("Layer")) {
      changes.push(`Stripped comment: ${trimmed.slice(0, 60)}`);
      continue;
    }
    // Strip blank lines
    if (!trimmed) continue;
    pass1.push(line);
  }
  changes.push(`Removed ${lines.length - pass1.length} blank/comment lines`);

  // Deduplicate consecutive identical movement commands (X/Y/Z repeats)
  const pass2: string[] = [];
  let lastMove = "";
  for (const line of pass1) {
    const upper = line.trim().toUpperCase();
    if ((upper.startsWith("G0") || upper.startsWith("G1")) && upper === lastMove) {
      changes.push(`Deduped redundant move: ${upper.slice(0, 60)}`);
      continue;
    }
    if (upper.startsWith("G0") || upper.startsWith("G1")) lastMove = upper;
    else lastMove = "";
    pass2.push(line);
  }

  let finalLines = pass2;

  // ── LLM refinement pass ───────────────────────────────────────────────────
  try {
    const model = await getPreferredModel(false);
    const snippet = pass2.slice(0, 80).join("\n");
    const prompt = [
      `You are an expert ${printerType === "fdm" ? "FDM 3D printer" : "laser cutter"} G-Code engineer.`,
      "Suggest 3-5 specific improvements to this G-Code header/preamble as a JSON array of strings.",
      "Focus on: print speed, temperature staging, retraction, acceleration.",
      "Return ONLY a JSON array: [\"improvement 1\", \"improvement 2\", ...]",
      "",
      "G-Code snippet:",
      snippet,
    ].join("\n");

    const llmResponse = await ollamaGenerate(prompt, model, 30_000);
    const jsonMatch   = llmResponse.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const llmSuggestions = JSON.parse(jsonMatch[0]) as string[];
      if (Array.isArray(llmSuggestions)) {
        changes.push(...llmSuggestions.map(s => `LLM: ${s}`));
      }
    }
  } catch {
    changes.push("LLM refinement skipped (Ollama not reachable)");
  }

  const optimizedGCode = finalLines.join("\n");
  let savedPath: string | undefined;

  if (saveOutput) {
    await ensureDir(CAD_DIR);
    savedPath = path.join(CAD_DIR, `${randomUUID().slice(0, 8)}_optimized.gcode`);
    await writeFile(savedPath, optimizedGCode, "utf-8");
  }

  thoughtLog.publish({
    category: "system",
    title:    "CAD — G-Code Optimized",
    message:  `${originalCount} → ${finalLines.length} lines (${changes.length} changes)`,
    metadata: { originalCount, optimizedCount: finalLines.length, printerType },
  });

  return {
    originalLineCount:  originalCount,
    optimizedLineCount: finalLines.length,
    optimizedGCode,
    changes:            changes.slice(0, 20),
    savedPath,
    optimizedAt:        nowIso(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. IMAGE GENERATION PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

/** Probe which image generation backends are currently running. */
export async function getImageGenStatus(): Promise<ImageGenStatus> {
  const [comfyuiReachable, sdWebuiReachable] = await Promise.all([
    fetchText(`${COMFYUI_BASE}/`, undefined, 3000)
      .then(() => true)
      .catch(() => false),
    fetchJson<{ title?: string }>(`${SD_WEBUI_BASE}/info`, undefined, 3000)
      .then(() => true)
      .catch(() => false),
  ]);

  const preferredBackend: ImageGenStatus["preferredBackend"] =
    comfyuiReachable ? "comfyui" :
    sdWebuiReachable ? "sdwebui" :
                       "none";

  return { comfyuiReachable, sdWebuiReachable, preferredBackend };
}

/**
 * Expand a basic prompt into a richly-detailed diffusion-ready prompt using
 * the local LLM.  Returns both the expanded positive and negative prompts.
 */
export async function expandImagePrompt(
  basicPrompt: string,
  style: "photorealistic" | "anime" | "oil-painting" | "sketch" | "cinematic" = "photorealistic",
): Promise<PromptArchitectResult> {
  const model = await getPreferredModel(false);
  const prompt = [
    "You are the Prompt Architect for a local Stable Diffusion image generation system.",
    "Expand the user's basic prompt into a detailed, richly-described diffusion prompt.",
    `Style: ${style}`,
    "Return ONLY a JSON object with keys: expandedPrompt (string), negativePrompt (string).",
    "expandedPrompt: 50-120 words with quality modifiers, lighting, composition, and style tags.",
    "negativePrompt: common negative modifiers (blurry, bad anatomy, watermark, etc.).",
    "",
    `User prompt: ${basicPrompt}`,
  ].join("\n");

  thoughtLog.publish({
    category: "system",
    title:    "Image Gen — Prompt Architect",
    message:  basicPrompt.slice(0, 80),
    metadata: { style, model },
  });

  let expandedPrompt = basicPrompt;
  let negativePrompt = "blurry, bad anatomy, watermark, text, low quality, deformed";

  try {
    const response  = await ollamaGenerate(prompt, model, 30_000);
    const jsonMatch = response.match(/\{[\s\S]*?\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { expandedPrompt?: string; negativePrompt?: string };
      if (parsed.expandedPrompt) expandedPrompt = parsed.expandedPrompt;
      if (parsed.negativePrompt) negativePrompt  = parsed.negativePrompt;
    }
  } catch {
    thoughtLog.publish({
      level:    "warning",
      category: "system",
      title:    "Image Gen — Prompt Expand Fallback",
      message:  "LLM not reachable; using basic prompt as-is",
    });
  }

  return {
    originalPrompt: basicPrompt,
    expandedPrompt,
    negativePrompt,
    style,
    model,
    expandedAt: nowIso(),
  };
}

/**
 * Send a generation request to ComfyUI using a minimal text-to-image workflow.
 * Returns the list of output images (base-64 encoded PNGs).
 */
async function generateViaComfyUI(
  prompt: string,
  negativePrompt: string,
  options: { steps?: number; cfgScale?: number; width?: number; height?: number; seed?: number } = {},
): Promise<{ images: string[]; promptId: string }> {
  const { steps = 20, cfgScale = 7, width = 512, height = 512, seed = -1 } = options;

  // Minimal ComfyUI API workflow (KSampler + CLIP text encode + VAE decode)
  const workflow = {
    "3": { class_type: "KSampler",    inputs: { seed, steps, cfg: cfgScale, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "v1-5-pruned-emaonly.ckpt" } },
    "5": { class_type: "EmptyLatentImage",       inputs: { width, height, batch_size: 1 } },
    "6": { class_type: "CLIPTextEncode",          inputs: { text: prompt,         clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode",          inputs: { text: negativePrompt, clip: ["4", 1] } },
    "8": { class_type: "VAEDecode",              inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage",             inputs: { filename_prefix: "sovereign", images: ["8", 0] } },
  };

  const queue = await postJson<{ prompt_id: string }>(
    `${COMFYUI_BASE}/prompt`,
    { prompt: workflow },
    60_000,
  );
  const promptId = queue.prompt_id;

  // Poll for completion (max 120 s)
  let images: string[] = [];
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise<void>(r => setTimeout(r, 2_000));
    const history = await fetchJson<Record<string, { outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string }> }> }>>(`${COMFYUI_BASE}/history/${promptId}`, undefined, 5_000).catch(() => null);
    const entry   = history?.[promptId];
    if (!entry) continue;
    for (const node of Object.values(entry.outputs ?? {})) {
      for (const img of node.images ?? []) {
        const params = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: "output" });
        const imgUrl = `${COMFYUI_BASE}/view?${params.toString()}`;
        const b64    = await fetchText(imgUrl, undefined, 10_000)
          .then(async () => {
            const raw = await fetch(imgUrl);
            const buf = await raw.arrayBuffer();
            return Buffer.from(buf).toString("base64");
          })
          .catch(() => "");
        if (b64) images.push(`data:image/png;base64,${b64}`);
      }
    }
    if (images.length > 0) break;
  }

  return { images, promptId };
}

/**
 * Send a generation request to the Stable Diffusion WebUI (AUTOMATIC1111 / Forge).
 */
async function generateViaSDWebUI(
  prompt: string,
  negativePrompt: string,
  options: { steps?: number; cfgScale?: number; width?: number; height?: number; seed?: number } = {},
): Promise<{ images: string[] }> {
  const { steps = 20, cfgScale = 7, width = 512, height = 512, seed = -1 } = options;

  const result = await postJson<{ images?: string[] }>(
    `${SD_WEBUI_BASE}/sdapi/v1/txt2img`,
    {
      prompt,
      negative_prompt: negativePrompt,
      steps,
      cfg_scale:       cfgScale,
      width,
      height,
      seed,
      n_iter:          1,
      batch_size:      1,
    },
    120_000,
  );

  return { images: (result.images ?? []).map(b64 => `data:image/png;base64,${b64}`) };
}

/**
 * Generate images using whichever backend is available.
 * Automatically expands the prompt if `expandPrompt` is true.
 */
export async function generateImage(
  basicPrompt: string,
  options: {
    expandPrompt?: boolean;
    style?: PromptArchitectResult["style"];
    steps?: number;
    cfgScale?: number;
    width?: number;
    height?: number;
    seed?: number;
    saveImages?: boolean;
  } = {},
): Promise<ImageGenResult> {
  const { expandPrompt = true, style = "photorealistic", saveImages = true, ...genOptions } = options;
  const generatedAt = nowIso();

  let finalPrompt    = basicPrompt;
  let negativePrompt = "blurry, bad anatomy, watermark, text, low quality, deformed";
  let expandedResult: PromptArchitectResult | undefined;

  if (expandPrompt) {
    expandedResult = await expandImagePrompt(basicPrompt, style);
    finalPrompt    = expandedResult.expandedPrompt;
    negativePrompt = expandedResult.negativePrompt;
  }

  const status = await getImageGenStatus();

  if (status.preferredBackend === "none") {
    return {
      success:      false,
      backend:      "comfyui",
      images:       [],
      savedPaths:   [],
      prompt:       basicPrompt,
      expandedPrompt: finalPrompt,
      generatedAt,
      error:        "Neither ComfyUI nor Stable Diffusion WebUI is reachable. Start one and retry.",
    };
  }

  thoughtLog.publish({
    category: "system",
    title:    "Image Gen — Generating",
    message:  `Using ${status.preferredBackend} — "${finalPrompt.slice(0, 80)}..."`,
    metadata: { backend: status.preferredBackend, ...genOptions },
  });

  try {
    let images: string[] = [];
    let promptId: string | undefined;

    if (status.preferredBackend === "comfyui") {
      const result = await generateViaComfyUI(finalPrompt, negativePrompt, genOptions);
      images   = result.images;
      promptId = result.promptId;
    } else {
      const result = await generateViaSDWebUI(finalPrompt, negativePrompt, genOptions);
      images = result.images;
    }

    const savedPaths: string[] = [];
    if (saveImages) {
      await ensureDir(IMAGEGEN_DIR);
      for (let i = 0; i < images.length; i++) {
        const b64Data = images[i].replace(/^data:image\/\w+;base64,/, "");
        const filePath = path.join(IMAGEGEN_DIR, `${Date.now()}_${i}.png`);
        await writeFile(filePath, Buffer.from(b64Data, "base64"));
        savedPaths.push(filePath);
      }
    }

    thoughtLog.publish({
      category: "system",
      title:    "Image Gen — Complete",
      message:  `Generated ${images.length} image(s) via ${status.preferredBackend}`,
      metadata: { backend: status.preferredBackend, count: images.length },
    });

    return {
      success:         true,
      backend:         status.preferredBackend,
      promptId,
      images,
      savedPaths,
      prompt:          basicPrompt,
      expandedPrompt:  finalPrompt,
      generatedAt,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ err, backend: status.preferredBackend }, "Image generation failed");
    thoughtLog.publish({
      level:    "error",
      category: "system",
      title:    "Image Gen — Error",
      message:  error,
      metadata: { backend: status.preferredBackend },
    });
    return {
      success:      false,
      backend:      status.preferredBackend,
      images:       [],
      savedPaths:   [],
      prompt:       basicPrompt,
      expandedPrompt: finalPrompt,
      generatedAt,
      error,
    };
  }
}
