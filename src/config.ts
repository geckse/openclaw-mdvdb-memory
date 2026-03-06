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
};

export type MdvdbMemoryConfig = {
  memoryDir: string;
  mdvdbBin: string;
  autoCapture: boolean;
  autoRecall: boolean;
  captureMaxChars: number;
  searchDefaults: SearchDefaults;
};

export const MEMORY_CATEGORIES = ["preference", "fact", "decision", "entity", "other"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const DEFAULT_CAPTURE_MAX_CHARS = 500;
const DEFAULT_MEMORY_DIR = join(homedir(), ".openclaw", "memory", "mdvdb");
const DEFAULT_MDVDB_BIN = "mdvdb";
const SEARCH_MODES: readonly string[] = ["hybrid", "semantic", "lexical"];

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

function parseSearchDefaults(raw: Record<string, unknown> | undefined): SearchDefaults {
  if (!raw) {
    return {
      mode: "hybrid",
      decay: true,
      boostLinks: false,
      limit: 5,
      minScore: 0.1,
    };
  }

  assertAllowedKeys(raw, ["mode", "decay", "boostLinks", "limit", "minScore", "decayHalfLife"], "searchDefaults");

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

  const decayHalfLife = typeof raw.decayHalfLife === "number" ? raw.decayHalfLife : undefined;

  return {
    mode,
    decay: raw.decay !== false,
    boostLinks: raw.boostLinks === true,
    limit,
    minScore,
    decayHalfLife,
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
        searchDefaults: parseSearchDefaults(undefined),
      };
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      ["memoryDir", "mdvdbBin", "autoCapture", "autoRecall", "captureMaxChars", "searchDefaults"],
      "memory config",
    );

    const memoryDir = typeof cfg.memoryDir === "string"
      ? resolveEnvVars(cfg.memoryDir)
      : DEFAULT_MEMORY_DIR;

    const mdvdbBin = typeof cfg.mdvdbBin === "string"
      ? resolveEnvVars(cfg.mdvdbBin)
      : DEFAULT_MDVDB_BIN;

    const captureMaxChars =
      typeof cfg.captureMaxChars === "number" ? Math.floor(cfg.captureMaxChars) : undefined;
    if (
      typeof captureMaxChars === "number" &&
      (captureMaxChars < 100 || captureMaxChars > 10_000)
    ) {
      throw new Error("captureMaxChars must be between 100 and 10000");
    }

    const searchDefaults = parseSearchDefaults(
      cfg.searchDefaults != null && typeof cfg.searchDefaults === "object" && !Array.isArray(cfg.searchDefaults)
        ? (cfg.searchDefaults as Record<string, unknown>)
        : undefined,
    );

    return {
      memoryDir,
      mdvdbBin,
      autoCapture: cfg.autoCapture === true,
      autoRecall: cfg.autoRecall !== false,
      captureMaxChars: captureMaxChars ?? DEFAULT_CAPTURE_MAX_CHARS,
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
      help: "Number of days for memory relevance to halve (uses mdvdb config if unset)",
      advanced: true,
    },
  },
};
