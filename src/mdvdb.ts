import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { EmbeddingConfig, MdvdbMemoryConfig, MemoryCategory, SearchMode } from "./config.js";

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

interface ConfigOverrideOptions {
  ignorePatterns: string[];
  mode: string;
  decay: boolean;
  boostLinks: boolean;
  limit: number;
  minScore: number;
  decayHalfLife?: number;
  decayExclude?: string[];
  decayInclude?: string[];
}

function buildConfigOverrides(opts: ConfigOverrideOptions): string {
  const lines = [
    "MDVDB_SOURCE_DIRS=.",
    `MDVDB_IGNORE_PATTERNS=${opts.ignorePatterns.join(",")}`,
    `MDVDB_SEARCH_MODE=${opts.mode}`,
    `MDVDB_SEARCH_DECAY=${opts.decay}`,
    `MDVDB_SEARCH_BOOST_LINKS=${opts.boostLinks}`,
    `MDVDB_SEARCH_DEFAULT_LIMIT=${opts.limit}`,
    `MDVDB_SEARCH_MIN_SCORE=${opts.minScore}`,
  ];
  if (opts.decayHalfLife !== undefined) {
    lines.push(`MDVDB_SEARCH_DECAY_HALF_LIFE=${opts.decayHalfLife}`);
  }
  if (opts.decayExclude && opts.decayExclude.length > 0) {
    lines.push(`MDVDB_SEARCH_DECAY_EXCLUDE=${opts.decayExclude.join(",")}`);
  }
  if (opts.decayInclude && opts.decayInclude.length > 0) {
    lines.push(`MDVDB_SEARCH_DECAY_INCLUDE=${opts.decayInclude.join(",")}`);
  }
  return lines.join("\n") + "\n";
}

export interface SearchOptions {
  mode?: SearchMode;
  limit?: number;
  minScore?: number;
  decay?: boolean;
  boostLinks?: boolean;
  decayHalfLife?: number;
  filter?: string[];
  pathPrefix?: string;
}

export interface SearchResult {
  file: string;
  score: number;
  text: string;
  section?: string;
  lineStart?: number;
  lineEnd?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  importance: number;
  created: string;
  source: "manual" | "auto-capture";
  tags: string[];
  text: string;
}

export interface IndexStats {
  totalFiles: number;
  totalSections: number;
  indexSize?: number;
}

export class MdvdbMemory {
  private readonly memoryDir: string;
  private readonly mdvdbBin: string;
  private readonly embedding?: EmbeddingConfig;
  private readonly ignorePatterns: string[];
  private readonly searchDefaults: MdvdbMemoryConfig["searchDefaults"];
  private initialized = false;

  constructor(config: MdvdbMemoryConfig) {
    this.memoryDir = config.memoryDir;
    this.mdvdbBin = config.mdvdbBin;
    this.embedding = config.embedding;
    this.ignorePatterns = config.ignorePatterns;
    this.searchDefaults = config.searchDefaults;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await fs.mkdir(this.memoryDir, { recursive: true });

    const configDir = path.join(this.memoryDir, ".markdownvdb");
    const configPath = path.join(configDir, ".config");

    // Check if .markdownvdb exists — could be a stale file from an older version
    try {
      const stat = await fs.stat(configDir);
      if (!stat.isDirectory()) {
        // Remove stale config file so mdvdb init can create the directory
        await fs.unlink(configDir);
      }
    } catch {
      // doesn't exist yet — that's fine
    }

    try {
      await this.runMdvdb(["init", "--root", this.memoryDir]);
    } catch (err) {
      // init may fail if already initialized — that's fine
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("already initialized") && !message.includes("already exists")) {
        throw err;
      }
    }

    // Apply memory-optimized config overrides (always rewrite to pick up config changes)
    try {
      const overrides = buildConfigOverrides({
        ignorePatterns: this.ignorePatterns,
        mode: this.searchDefaults.mode,
        decay: this.searchDefaults.decay,
        boostLinks: this.searchDefaults.boostLinks,
        limit: this.searchDefaults.limit,
        minScore: this.searchDefaults.minScore,
        decayHalfLife: this.searchDefaults.decayHalfLife,
        decayExclude: this.searchDefaults.decayExclude,
        decayInclude: this.searchDefaults.decayInclude,
      });
      // Always rewrite to pick up any config changes
      await fs.writeFile(configPath, overrides, "utf-8");
    } catch {
      // config file may not exist if init failed — skip overrides
    }

    this.initialized = true;
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    await this.ensureInitialized();

    const minScore = options?.minScore ?? this.searchDefaults.minScore;

    // Defaults are in .markdownvdb/.config — only pass per-query overrides
    const args = ["search", query, "--json", "--root", this.memoryDir];

    if (options?.limit !== undefined) {
      args.push("--limit", String(options.limit));
    }
    if (options?.mode !== undefined) {
      args.push("--mode", options.mode);
    }
    if (options?.minScore !== undefined) {
      args.push("--min-score", String(options.minScore));
    }
    if (options?.decay !== undefined) {
      args.push(options.decay ? "--decay" : "--no-decay");
    }
    if (options?.boostLinks !== undefined) {
      args.push("--boost-links");
    }
    if (options?.decayHalfLife !== undefined) {
      args.push("--decay-half-life", String(options.decayHalfLife));
    }

    const filters = options?.filter;
    if (filters) {
      for (const f of filters) {
        args.push("--filter", f);
      }
    }

    const pathPrefix = options?.pathPrefix;
    if (pathPrefix) {
      args.push("--path", pathPrefix);
    }

    let stdout: string;
    try {
      const result = await this.runMdvdb(args);
      stdout = result.stdout;
    } catch (err) {
      throw this.wrapError(err, "search");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return [];
    }

    // mdvdb wraps results in { results: [...] } or returns a flat array
    let items: Array<Record<string, unknown>>;
    if (Array.isArray(parsed)) {
      items = parsed as Array<Record<string, unknown>>;
    } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).results)) {
      items = (parsed as Record<string, unknown>).results as Array<Record<string, unknown>>;
    } else {
      return [];
    }

    return items
      .filter((r) => {
        const score = typeof r.score === "number" ? r.score : 0;
        return score >= minScore;
      })
      .map((r) => {
        // mdvdb nests chunk and file info in sub-objects
        const chunk = (r.chunk && typeof r.chunk === "object" ? r.chunk : {}) as Record<string, unknown>;
        const fileObj = (r.file && typeof r.file === "object" ? r.file : null) as Record<string, unknown> | null;

        const filePath = fileObj
          ? String(fileObj.path ?? "")
          : String(r.file ?? r.path ?? "");

        const text = String(chunk.content ?? r.text ?? r.content ?? r.snippet ?? "");

        const headings = Array.isArray(chunk.heading_hierarchy)
          ? (chunk.heading_hierarchy as string[]).join(" > ")
          : (typeof r.section === "string" ? r.section : undefined);

        const lineStart = typeof chunk.start_line === "number" ? chunk.start_line
          : (typeof r.line_start === "number" ? r.line_start : undefined);
        const lineEnd = typeof chunk.end_line === "number" ? chunk.end_line
          : (typeof r.line_end === "number" ? r.line_end : undefined);

        const frontmatter = fileObj && typeof fileObj.frontmatter === "object" && fileObj.frontmatter !== null
          ? fileObj.frontmatter as Record<string, unknown>
          : undefined;

        return {
          file: filePath,
          score: typeof r.score === "number" ? r.score : 0,
          text,
          section: headings,
          lineStart,
          lineEnd,
          metadata: frontmatter,
        };
      });
  }

  async store(
    text: string,
    category: MemoryCategory,
    importance: number,
    source: "manual" | "auto-capture",
    tags: string[] = ["memory"],
    links: string[] = [],
  ): Promise<MemoryEntry> {
    await this.ensureInitialized();

    const id = randomUUID();
    const shortId = id.slice(0, 8);
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const filePath = path.join(this.memoryDir, `${dateStr}-${shortId}.md`);

    const frontmatter = [
      "---",
      `id: ${id}`,
      `category: ${category}`,
      `importance: ${importance}`,
      `created: ${now.toISOString()}`,
      `source: ${source}`,
      `tags:`,
      ...tags.map((t) => `  - ${t}`),
      "---",
      "",
      text,
    ];

    // Append [[wiki-links]] to related memories
    if (links.length > 0) {
      frontmatter.push("");
      frontmatter.push(...links.map((l) => `[[${l}]]`));
    }

    frontmatter.push("");

    await fs.writeFile(filePath, frontmatter.join("\n"), "utf-8");

    try {
      await this.runMdvdb(["ingest", "--file", filePath, "--root", this.memoryDir]);
    } catch (err) {
      throw this.wrapError(err, "ingest");
    }

    return {
      id,
      category,
      importance,
      created: now.toISOString(),
      source,
      tags,
      text,
    };
  }

  async delete(memoryId: string): Promise<boolean> {
    await this.ensureInitialized();

    const filePath = await this.findFileById(memoryId);
    if (!filePath) {
      return false;
    }

    await fs.unlink(filePath);

    try {
      await this.runMdvdb(["ingest", "--root", this.memoryDir]);
    } catch (err) {
      throw this.wrapError(err, "re-index after delete");
    }

    return true;
  }

  async count(): Promise<number> {
    await this.ensureInitialized();

    let stdout: string;
    try {
      const result = await this.runMdvdb(["status", "--json", "--root", this.memoryDir]);
      stdout = result.stdout;
    } catch (err) {
      throw this.wrapError(err, "status");
    }

    try {
      const parsed = JSON.parse(stdout);
      if (typeof parsed.document_count === "number") {
        return parsed.document_count;
      }
      if (typeof parsed.total_files === "number") {
        return parsed.total_files;
      }
      if (typeof parsed.totalFiles === "number") {
        return parsed.totalFiles;
      }
      return 0;
    } catch {
      return 0;
    }
  }

  async stats(): Promise<IndexStats> {
    await this.ensureInitialized();

    let stdout: string;
    try {
      const result = await this.runMdvdb(["status", "--json", "--root", this.memoryDir]);
      stdout = result.stdout;
    } catch (err) {
      throw this.wrapError(err, "status");
    }

    try {
      const parsed = JSON.parse(stdout);
      return {
        totalFiles: typeof parsed.document_count === "number"
          ? parsed.document_count
          : (typeof parsed.total_files === "number" ? parsed.total_files : 0),
        totalSections: typeof parsed.chunk_count === "number"
          ? parsed.chunk_count
          : (typeof parsed.total_sections === "number" ? parsed.total_sections : 0),
        indexSize: typeof parsed.file_size === "number"
          ? parsed.file_size
          : (typeof parsed.index_size === "number" ? parsed.index_size : undefined),
      };
    } catch {
      return { totalFiles: 0, totalSections: 0 };
    }
  }

  async ingest(options?: { reindex?: boolean; file?: string }): Promise<string> {
    await this.ensureInitialized();

    const args = ["ingest", "--root", this.memoryDir];
    if (options?.reindex) {
      args.push("--reindex");
    }
    if (options?.file) {
      args.push("--file", options.file);
    }

    const result = await this.runMdvdb(args);
    return result.stdout + result.stderr;
  }

  async get(filePath: string, startLine?: number, numLines?: number): Promise<{ text: string; path: string }> {
    const resolved = path.resolve(this.memoryDir, filePath);

    // Reject paths outside memory dir
    if (!resolved.startsWith(this.memoryDir)) {
      return { text: "", path: filePath };
    }

    try {
      const content = await fs.readFile(resolved, "utf-8");
      if (startLine == null) {
        return { text: content, path: filePath };
      }

      const lines = content.split("\n");
      const start = Math.max(0, startLine - 1); // 1-based to 0-based
      const end = numLines != null ? start + numLines : lines.length;
      return { text: lines.slice(start, end).join("\n"), path: filePath };
    } catch {
      // Graceful degradation — return empty instead of throwing
      return { text: "", path: filePath };
    }
  }

  private async findFileById(memoryId: string): Promise<string | null> {
    const shortId = memoryId.slice(0, 8);

    try {
      const entries = await fs.readdir(this.memoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) {
          continue;
        }
        // Match by short id in filename (YYYY-MM-DD-<shortId>.md)
        if (entry.name.includes(shortId)) {
          return path.join(this.memoryDir, entry.name);
        }
      }
    } catch {
      // directory may not exist
    }

    return null;
  }

  private async runMdvdb(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const env = { ...process.env };
    if (this.embedding) {
      env.MDVDB_EMBEDDING_PROVIDER = this.embedding.provider;
      if (this.embedding.model) {
        env.MDVDB_EMBEDDING_MODEL = this.embedding.model;
      }
      if (this.embedding.dimensions !== undefined) {
        env.MDVDB_EMBEDDING_DIMENSIONS = String(this.embedding.dimensions);
      }
      if (this.embedding.apiKey) {
        env.OPENAI_API_KEY = this.embedding.apiKey;
      }
      if (this.embedding.baseUrl) {
        env.MDVDB_EMBEDDING_ENDPOINT = this.embedding.baseUrl;
      }
      if (this.embedding.ollamaHost) {
        env.MDVDB_OLLAMA_HOST = this.embedding.ollamaHost;
      }
    }

    try {
      return await execFileAsync(this.mdvdbBin, args, {
        cwd: this.memoryDir,
        timeout: EXEC_TIMEOUT,
        maxBuffer: MAX_BUFFER,
        env,
      });
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
        throw new Error(
          `mdvdb binary not found on PATH. Please install mdvdb (https://github.com/geckse/mdvdb) and ensure it is available as "${this.mdvdbBin}".`,
        );
      }
      throw err;
    }
  }

  private wrapError(err: unknown, operation: string): Error {
    if (err instanceof Error) {
      return new Error(`mdvdb ${operation} failed: ${err.message}`);
    }
    return new Error(`mdvdb ${operation} failed: ${String(err)}`);
  }
}
