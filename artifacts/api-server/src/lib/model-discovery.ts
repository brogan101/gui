import { fetchJson, fetchText } from "./runtime.js";

export interface ModelSeed {
  modelName: string;
  tags: string[];
  category: "coding" | "general" | "reasoning" | "vision" | "embedding" | "uncensored";
  aliases?: string[];
  keywords?: string[];
}

export interface DiscoveredModelCard {
  spec: string;
  modelName: string;
  tag: string;
  category: ModelSeed["category"];
  novelty: "recommended" | "fresh" | "trending" | "abliterated";
  whyRecommended: string;
  hardwareRequirement: string;
  vramEstimateGb?: number;
  verificationSource: string;
  sourceLabels: string[];
  discoveredAt: string;
}

export interface VerifyResult {
  exists: boolean;
  modelName: string;
  tag: string;
  spec: string;
  digest?: string;
  vramEstimateGb?: number;
  hardwareRequirement: string;
  verificationSource: string;
}

interface DiscoverOptions {
  installedModels?: string[];
  limit?: number;
}

const SOURCE_URLS = [
  { id: "ollama-library",      label: "Ollama Library",              type: "text", url: "https://ollama.com/library" },
  { id: "hf-blog",             label: "HuggingFace Blog",            type: "text", url: "https://huggingface.co/blog" },
  { id: "ai-news",             label: "AI News Feed",                type: "text", url: "https://hnrss.org/newest?q=ollama%20OR%20huggingface%20OR%20local%20llm" },
  { id: "hf-abliterated",      label: "HuggingFace Abliterated Search", type: "json", url: "https://huggingface.co/api/models?search=abliterated&limit=12&sort=downloads&direction=-1" },
] as const;

const SEED_MODELS: ModelSeed[] = [
  { modelName: "qwen3-coder",        tags: ["30b","8b"],            category: "coding",     aliases: ["qwen coder"] },
  { modelName: "qwen2.5-coder",      tags: ["14b","7b","1.5b"],     category: "coding" },
  { modelName: "deepseek-coder-v2",  tags: ["16b"],                 category: "coding",     aliases: ["deepseek coder"] },
  { modelName: "qwen3",              tags: ["32b","14b","8b"],       category: "general" },
  { modelName: "gemma3",             tags: ["27b","12b","4b"],       category: "general" },
  { modelName: "deepseek-r1",        tags: ["14b","8b","7b"],        category: "reasoning" },
  { modelName: "qwq",                tags: ["32b"],                  category: "reasoning" },
  { modelName: "dolphin3",           tags: ["latest"],               category: "uncensored", keywords: ["abliterated","uncensored"] },
  { modelName: "neural-daredevil",   tags: ["8b"],                   category: "uncensored", keywords: ["abliterated","uncensored"] },
  { modelName: "glm4",               tags: ["9b"],                   category: "uncensored", keywords: ["abliterated","storytelling"] },
  { modelName: "qwen2.5-vl",         tags: ["7b"],                   category: "vision" },
  { modelName: "minicpm-v",          tags: ["latest"],               category: "vision" },
  { modelName: "nomic-embed-text",   tags: ["latest"],               category: "embedding" },
  { modelName: "mxbai-embed-large",  tags: ["latest"],               category: "embedding" },
  { modelName: "llama3.3",           tags: ["70b"],                  category: "general",    aliases: ["llama 3.3"] },
  { modelName: "mistral-small",      tags: ["24b"],                  category: "general",    aliases: ["mistral small"] },
];

function uniq<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function estimateVramFromTag(tag: string): number | undefined {
  const lower = tag.toLowerCase();
  if (lower === "latest" || lower === "mini") return undefined;
  const numeric = lower.match(/(\d+(?:\.\d+)?)/);
  if (!numeric) return undefined;
  const value = Number(numeric[1]);
  if (Number.isNaN(value)) return undefined;
  if (lower.includes("70")) return 48;
  if (value >= 30) return 22;
  if (value >= 24) return 18;
  if (value >= 14) return 10;
  if (value >= 8)  return 6;
  if (value >= 4)  return 4;
  if (value >= 1)  return 2;
  return undefined;
}

function hardwareRequirement(tag: string): string {
  const vram = estimateVramFromTag(tag);
  if (!vram) return "Tag verified. Hardware varies by quantization and context window.";
  if (vram <= 4)  return `Lightweight. Roughly ${vram} GB VRAM or a capable CPU setup.`;
  if (vram <= 10) return `Mid-range. Roughly ${vram} GB VRAM recommended for smooth use.`;
  return `High-end. Roughly ${vram} GB VRAM recommended.`;
}

function guessCandidateTags(seed?: ModelSeed): string[] {
  return uniq([...seed?.tags ?? [], "latest", "8b", "7b", "4b", "3b", "1.5b", "14b", "32b"]);
}

function parseOllamaLibraryNames(html: string): string[] {
  const matches = html.match(/\/library\/([a-z0-9][a-z0-9._-]*)/gi) ?? [];
  return uniq(
    matches
      .map(e => e.split("/").pop() ?? "")
      .map(e => e.trim().toLowerCase())
      .filter(e => e.length > 2 && !e.includes(".")),
  );
}

function scoreSeed(seed: ModelSeed, signals: string[]): {
  score: number; sourceLabels: string[]; novelty: DiscoveredModelCard["novelty"];
} {
  const haystack = signals.join("\n").toLowerCase();
  const searchTerms = uniq([seed.modelName, ...seed.aliases ?? [], ...seed.keywords ?? []]);
  const sourceLabels: string[] = [];
  let score = 0;
  for (const term of searchTerms) {
    if (haystack.includes(term.toLowerCase())) score += 2;
  }
  for (const source of SOURCE_URLS) {
    const sourceSignal = signals.find(e => e.startsWith(`${source.label}:`));
    if (!sourceSignal) continue;
    const signalText = sourceSignal.toLowerCase();
    if (searchTerms.some(term => signalText.includes(term.toLowerCase()))) {
      sourceLabels.push(source.label);
      score += source.id === "ollama-library" ? 2 : 1;
    }
  }
  let novelty: DiscoveredModelCard["novelty"] = "recommended";
  if ((seed.keywords ?? []).some(k => k.includes("abliterated")) || haystack.includes("abliterated")) {
    novelty = "abliterated"; score += 1;
  } else if (sourceLabels.includes("AI News Feed")) {
    novelty = "fresh";
  } else if (sourceLabels.length > 1) {
    novelty = "trending";
  }
  return { score, sourceLabels: uniq(sourceLabels), novelty };
}

async function loadSignals(): Promise<string[]> {
  const results = await Promise.allSettled(
    SOURCE_URLS.map(async source => {
      if (source.type === "json") {
        const payload = await fetchJson<Array<{id?: string}>>(source.url, undefined, 10000);
        return `${source.label}: ${payload.map(e => e.id).filter(Boolean).join(" | ")}`;
      }
      const text = await fetchText(source.url, undefined, 10000);
      return `${source.label}: ${text.slice(0, 25000)}`;
    }),
  );
  return results
    .filter(r => r.status === "fulfilled")
    .map(r => (r as PromiseFulfilledResult<string>).value);
}

export async function verifyOllamaModelSpec(input: string): Promise<VerifyResult> {
  const [rawName, rawTag] = input.includes(":") ? input.split(":") : [input, ""];
  const modelName = rawName.trim().toLowerCase();
  const seed = SEED_MODELS.find(e => e.modelName === modelName);
  const tagsToTry = rawTag ? [rawTag] : guessCandidateTags(seed);
  for (const tag of tagsToTry) {
    try {
      const data = await fetchJson<{ digest?: string }>(
        `https://registry.ollama.ai/v2/library/${encodeURIComponent(modelName)}/manifests/${encodeURIComponent(tag)}`,
        { headers: { Accept: "application/vnd.docker.distribution.manifest.v2+json" } },
        10000,
      );
      return {
        exists: true, modelName, tag, spec: `${modelName}:${tag}`,
        digest: data.digest?.slice(0, 12),
        vramEstimateGb: estimateVramFromTag(tag),
        hardwareRequirement: hardwareRequirement(tag),
        verificationSource: "Ollama Registry Manifest",
      };
    } catch { /* try next tag */ }
  }
  return {
    exists: false, modelName, tag: rawTag ?? "", spec: rawTag ? `${modelName}:${rawTag}` : modelName,
    hardwareRequirement: "Verification failed. The requested tag was not confirmed in the Ollama registry.",
    verificationSource: "Ollama Registry Manifest",
  };
}

export async function discoverVerifiedModels(options?: DiscoverOptions): Promise<DiscoveredModelCard[]> {
  const installed = new Set((options?.installedModels ?? []).map(e => e.toLowerCase()));
  const signals = await loadSignals().catch(() => [] as string[]);
  const ollamaSignal = signals.find(e => e.startsWith("Ollama Library:")) ?? "";
  const dynamicNames = parseOllamaLibraryNames(ollamaSignal);
  const dynamicSeeds: ModelSeed[] = dynamicNames.slice(0, 30).map(modelName => ({
    modelName, tags: [], category: "general",
  }));
  const candidates = uniq(
    [...SEED_MODELS, ...dynamicSeeds].map(e => JSON.stringify(e)),
  ).map(e => JSON.parse(e) as ModelSeed);
  const ranked = candidates
    .map(seed => ({ seed, ...scoreSeed(seed, signals) }))
    .filter(e => e.score > 0 || dynamicNames.includes(e.seed.modelName))
    .sort((a, b) => b.score - a.score)
    .slice(0, 16);
  const cards: DiscoveredModelCard[] = [];
  for (const candidate of ranked) {
    const verified = await verifyOllamaModelSpec(candidate.seed.modelName);
    if (!verified.exists || installed.has(verified.spec.toLowerCase())) continue;
    const reasonParts = [
      candidate.novelty === "abliterated" ? "Community signals point to this as a strong uncensored or abliterated option."
        : candidate.novelty === "fresh"     ? "Recent web signals suggest this model is gaining attention."
        : candidate.novelty === "trending"  ? "This model shows up across multiple discovery sources."
        : "This model matches the current local-model shortlist.",
      candidate.sourceLabels.length
        ? `Referenced by ${candidate.sourceLabels.join(", ")}.`
        : "Verified against the live Ollama registry before proposing it.",
    ];
    cards.push({
      spec: verified.spec, modelName: verified.modelName, tag: verified.tag,
      category: candidate.seed.category, novelty: candidate.novelty,
      whyRecommended: reasonParts.join(" "),
      hardwareRequirement: verified.hardwareRequirement,
      vramEstimateGb: verified.vramEstimateGb,
      verificationSource: verified.verificationSource,
      sourceLabels: candidate.sourceLabels.length ? candidate.sourceLabels : ["Ollama Library"],
      discoveredAt: new Date().toISOString(),
    });
    if (cards.length >= (options?.limit ?? 6)) break;
  }
  return cards;
}
