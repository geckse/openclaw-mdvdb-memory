import { homedir } from "node:os";
import { join } from "node:path";

export type SearchMode = "hybrid" | "semantic" | "lexical";

export type SearchDefaults = {
  mode: SearchMode;
  decay: boolean;
  boostLinks: boolean;
  limit: number;
  minScore: number;
  decayHalfLife?: number;
  decayExclude?: string[];
  decayInclude?: string[];
};

export type EmbeddingProvider = "openai" | "ollama" | "custom";

export type EmbeddingConfig = {
  provider: EmbeddingProvider;
  model?: string;
  dimensions?: number;
  apiKey?: string;
  baseUrl?: string;
  ollamaHost?: string;
};

export type MdvdbMemoryConfig = {
  memoryDir: string;
  mdvdbBin: string;
  embedding?: EmbeddingConfig;
  autoCapture: boolean;
  autoRecall: boolean;
  captureMaxChars: number;
  ignorePatterns: string[];
  searchDefaults: SearchDefaults;
};

export const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const DEFAULT_DECAY_INCLUDE = ["????-??-??-*.md"];
export const DEFAULT_CAPTURE_MAX_CHARS = 500;
export const DEFAULT_IGNORE_PATTERNS = [
  "AGENTS.md", "HEARTBEAT.md", "SOUL.md", "IDENTITY.md",
  "BOOTSTRAP.md", "TOOLS.md", "USER.md",
];
const DEFAULT_MEMORY_DIR = join(homedir(), ".openclaw", "workspace", "memory");
const DEFAULT_MDVDB_BIN = "mdvdb";
const SEARCH_MODES: readonly string[] = ["hybrid", "semantic", "lexical"];
const EMBEDDING_PROVIDERS: readonly string[] = ["openai", "ollama", "custom"];

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) {
    return;
  }
  throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function parseEmbedding(raw: Record<string, unknown> | undefined): EmbeddingConfig | undefined {
  if (!raw) {
    return undefined;
  }

  assertAllowedKeys(raw, ["provider", "model", "dimensions", "apiKey", "baseUrl", "ollamaHost"], "embedding");

  const provider = typeof raw.provider === "string" && EMBEDDING_PROVIDERS.includes(raw.provider)
    ? (raw.provider as EmbeddingProvider)
    : "openai";

  return {
    provider,
    model: typeof raw.model === "string" ? raw.model : undefined,
    dimensions: typeof raw.dimensions === "number" ? raw.dimensions : undefined,
    apiKey: typeof raw.apiKey === "string" ? resolveEnvVars(raw.apiKey) : undefined,
    baseUrl: typeof raw.baseUrl === "string" ? resolveEnvVars(raw.baseUrl) : undefined,
    ollamaHost: typeof raw.ollamaHost === "string" ? resolveEnvVars(raw.ollamaHost) : undefined,
  };
}

function parseSearchDefaults(raw: Record<string, unknown> | undefined): SearchDefaults {
  if (!raw) {
    return {
      mode: "hybrid",
      decay: true,
      boostLinks: false,
      limit: 5,
      minScore: 0.1,
      decayHalfLife: 7,
      decayInclude: DEFAULT_DECAY_INCLUDE,
    };
  }

  assertAllowedKeys(raw, ["mode", "decay", "boostLinks", "limit", "minScore", "decayHalfLife", "decayExclude", "decayInclude"], "searchDefaults");

  const mode = typeof raw.mode === "string" && SEARCH_MODES.includes(raw.mode)
    ? (raw.mode as SearchMode)
    : "hybrid";

  const limit = typeof raw.limit === "number" ? Math.floor(raw.limit) : 5;
  if (limit < 1) {
    throw new Error("searchDefaults.limit must be at least 1");
  }

  const minScore = typeof raw.minScore === "number" ? raw.minScore : 0.1;
  if (minScore < 0 || minScore > 1) {
    throw new Error("searchDefaults.minScore must be between 0 and 1");
  }

  const decayHalfLife = typeof raw.decayHalfLife === "number" ? raw.decayHalfLife : 7;

  const decayExclude = Array.isArray(raw.decayExclude)
    ? (raw.decayExclude as unknown[]).filter((p): p is string => typeof p === "string")
    : undefined;

  const decayInclude = Array.isArray(raw.decayInclude)
    ? (raw.decayInclude as unknown[]).filter((p): p is string => typeof p === "string")
    : DEFAULT_DECAY_INCLUDE;

  return {
    mode,
    decay: raw.decay !== false,
    boostLinks: raw.boostLinks === true,
    limit,
    minScore,
    decayHalfLife,
    decayExclude,
    decayInclude,
  };
}

export const memoryConfigSchema = {
  parse(value: unknown): MdvdbMemoryConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      // No config provided — use all defaults
      return {
        memoryDir: DEFAULT_MEMORY_DIR,
        mdvdbBin: DEFAULT_MDVDB_BIN,
        autoCapture: false,
        autoRecall: true,
        captureMaxChars: DEFAULT_CAPTURE_MAX_CHARS,
        ignorePatterns: DEFAULT_IGNORE_PATTERNS,
        searchDefaults: parseSearchDefaults(undefined),
      };
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["memoryDir", "mdvdbBin", "embedding", "autoCapture", "autoRecall", "captureMaxChars", "ignorePatterns", "searchDefaults"],
      "memory config",
    );

    const memoryDir = typeof cfg.memoryDir === "string"
      ? resolveEnvVars(cfg.memoryDir)
      : DEFAULT_MEMORY_DIR;

    const mdvdbBin = typeof cfg.mdvdbBin === "string"
      ? resolveEnvVars(cfg.mdvdbBin)
      : DEFAULT_MDVDB_BIN;

    const embedding = parseEmbedding(
      cfg.embedding != null && typeof cfg.embedding === "object" && !Array.isArray(cfg.embedding)
        ? (cfg.embedding as Record<string, unknown>)
        : undefined,
    );

    const captureMaxChars =
      typeof cfg.captureMaxChars === "number" ? Math.floor(cfg.captureMaxChars) : undefined;
    if (
      typeof captureMaxChars === "number" &&
      (captureMaxChars < 100 || captureMaxChars > 10_000)
    ) {
      throw new Error("captureMaxChars must be between 100 and 10000");
    }

    const ignorePatterns = Array.isArray(cfg.ignorePatterns)
      ? (cfg.ignorePatterns as unknown[]).filter((p): p is string => typeof p === "string")
      : DEFAULT_IGNORE_PATTERNS;

    const searchDefaults = parseSearchDefaults(
      cfg.searchDefaults != null && typeof cfg.searchDefaults === "object" && !Array.isArray(cfg.searchDefaults)
        ? (cfg.searchDefaults as Record<string, unknown>)
        : undefined,
    );

    return {
      memoryDir,
      mdvdbBin,
      embedding,
      autoCapture: cfg.autoCapture === true,
      autoRecall: cfg.autoRecall !== false,
      captureMaxChars: captureMaxChars ?? DEFAULT_CAPTURE_MAX_CHARS,
      ignorePatterns,
      searchDefaults,
    };
  },
  uiHints: {
    memoryDir: {
      label: "Memory Directory",
      help: "Directory where memory files are stored as Markdown",
    },
    mdvdbBin: {
      label: "mdvdb Binary Path",
      help: "Path to the mdvdb CLI binary (must be installed separately)",
      advanced: true,
    },
    ignorePatterns: {
      label: "Ignore Patterns",
      help: "File patterns excluded from indexing. OpenClaw workspace files (AGENTS.md, SOUL.md, etc.) are excluded by default.",
      advanced: true,
    },
    "embedding.provider": {
      label: "Embedding Provider",
      help: "Embedding provider: openai, ollama, or custom (default: openai)",
    },
    "embedding.model": {
      label: "Embedding Model",
      help: "Model name (e.g. text-embedding-3-small for OpenAI, nomic-embed-text for Ollama)",
      advanced: true,
    },
    "embedding.dimensions": {
      label: "Embedding Dimensions",
      help: "Vector dimensions (default: provider-specific)",
      advanced: true,
    },
    "embedding.apiKey": {
      label: "API Key",
      sensitive: true,
      placeholder: "sk-proj-... or ${OPENAI_API_KEY}",
      help: "API key for OpenAI or custom provider",
    },
    "embedding.baseUrl": {
      label: "Custom Base URL",
      placeholder: "https://api.example.com/v1",
      help: "Base URL for custom embedding endpoint",
      advanced: true,
    },
    "embedding.ollamaHost": {
      label: "Ollama Host",
      placeholder: "http://localhost:11434",
      help: "Ollama server URL (default: http://localhost:11434)",
      advanced: true,
    },
    autoCapture: {
      label: "Auto-Capture",
      help: "Automatically store important information from conversations",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject relevant memories into agent context",
    },
    captureMaxChars: {
      label: "Capture Max Characters",
      help: "Maximum character length for auto-captured memories (100-10000)",
      advanced: true,
      placeholder: String(DEFAULT_CAPTURE_MAX_CHARS),
    },
    "searchDefaults.mode": {
      label: "Search Mode",
      help: "Default search mode: hybrid (semantic + BM25), semantic only, or lexical only",
    },
    "searchDefaults.decay": {
      label: "Time Decay",
      help: "Reduce relevance of older memories in search results",
    },
    "searchDefaults.boostLinks": {
      label: "Boost Links",
      help: "Boost results that link to other memories",
    },
    "searchDefaults.limit": {
      label: "Result Limit",
      help: "Default number of search results to return",
      advanced: true,
    },
    "searchDefaults.minScore": {
      label: "Minimum Score",
      help: "Minimum similarity score for results (0.0-1.0)",
      advanced: true,
    },
    "searchDefaults.decayHalfLife": {
      label: "Decay Half-Life (days)",
      help: "Number of days for memory relevance to halve (default: 7)",
      advanced: true,
    },
    "searchDefaults.decayInclude": {
      label: "Decay Include Patterns",
      help: "Only apply time decay to files matching these patterns (default: time-log memory files only)",
      advanced: true,
    },
    "searchDefaults.decayExclude": {
      label: "Decay Exclude Patterns",
      help: "Exclude files matching these patterns from time decay",
      advanced: true,
    },
  },
};
