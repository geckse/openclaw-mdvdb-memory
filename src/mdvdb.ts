import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { MdvdbMemoryConfig, MemoryCategory, SearchMode } from "./config.js";

const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

const DEFAULT_MARKDOWNVDB = `MDVDB_SOURCE_DIRS=.
MDVDB_SEARCH_MODE=hybrid
MDVDB_TIME_DECAY=true
MDVDB_DECAY_HALF_LIFE_DAYS=30
`;

export interface SearchOptions {
  mode?: SearchMode;
  limit?: number;
  minScore?: number;
  decay?: boolean;
  boostLinks?: boolean;
  decayHalfLife?: number;
}

export interface SearchResult {
  file: string;
  score: number;
  text: string;
  section?: string;
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
  private readonly searchDefaults: MdvdbMemoryConfig["searchDefaults"];
  private initialized = false;

  constructor(config: MdvdbMemoryConfig) {
    this.memoryDir = config.memoryDir;
    this.mdvdbBin = config.mdvdbBin;
    this.searchDefaults = config.searchDefaults;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await fs.mkdir(this.memoryDir, { recursive: true });

    const configPath = path.join(this.memoryDir, ".markdownvdb");
    try {
      await fs.access(configPath);
    } catch {
      await fs.writeFile(configPath, DEFAULT_MARKDOWNVDB, "utf-8");
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

    this.initialized = true;
  }

  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    await this.ensureInitialized();

    const mode = options?.mode ?? this.searchDefaults.mode;
    const limit = options?.limit ?? this.searchDefaults.limit;
    const minScore = options?.minScore ?? this.searchDefaults.minScore;
    const decay = options?.decay ?? this.searchDefaults.decay;
    const boostLinks = options?.boostLinks ?? this.searchDefaults.boostLinks;
    const decayHalfLife = options?.decayHalfLife ?? this.searchDefaults.decayHalfLife;

    const args = ["search", query, "--json", "--root", this.memoryDir];
    args.push("--limit", String(limit));
    args.push("--mode", mode);

    args.push("--min-score", String(minScore));

    if (decay) {
      args.push("--decay");
    } else {
      args.push("--no-decay");
    }
    if (boostLinks) {
      args.push("--boost-links");
    }
    if (decayHalfLife !== undefined) {
      args.push("--decay-half-life", String(decayHalfLife));
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

    if (!Array.isArray(parsed)) {
      return [];
    }

    return (parsed as Array<Record<string, unknown>>)
      .filter((r) => {
        const score = typeof r.score === "number" ? r.score : 0;
        return score >= minScore;
      })
      .map((r) => ({
        file: String(r.file ?? r.path ?? ""),
        score: typeof r.score === "number" ? r.score : 0,
        text: String(r.text ?? r.content ?? r.snippet ?? ""),
        section: typeof r.section === "string" ? r.section : undefined,
        metadata: typeof r.metadata === "object" && r.metadata !== null
          ? (r.metadata as Record<string, unknown>)
          : undefined,
      }));
  }

  async store(
    text: string,
    category: MemoryCategory,
    importance: number,
    source: "manual" | "auto-capture",
    tags: string[] = ["memory"],
  ): Promise<MemoryEntry> {
    await this.ensureInitialized();

    const id = randomUUID();
    const shortId = id.slice(0, 8);
    const now = new Date();
    const dateDir = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const dirPath = path.join(this.memoryDir, dateDir);
    const filePath = path.join(dirPath, `${shortId}.md`);

    await fs.mkdir(dirPath, { recursive: true });

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
      "",
    ].join("\n");

    await fs.writeFile(filePath, frontmatter, "utf-8");

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
      if (typeof parsed.total_files === "number") {
        return parsed.total_files;
      }
      if (typeof parsed.totalFiles === "number") {
        return parsed.totalFiles;
      }
      if (typeof parsed.files === "number") {
        return parsed.files;
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
        totalFiles: typeof parsed.total_files === "number"
          ? parsed.total_files
          : (typeof parsed.totalFiles === "number" ? parsed.totalFiles : 0),
        totalSections: typeof parsed.total_sections === "number"
          ? parsed.total_sections
          : (typeof parsed.totalSections === "number" ? parsed.totalSections : 0),
        indexSize: typeof parsed.index_size === "number"
          ? parsed.index_size
          : undefined,
      };
    } catch {
      return { totalFiles: 0, totalSections: 0 };
    }
  }

  private async findFileById(memoryId: string): Promise<string | null> {
    const shortId = memoryId.slice(0, 8);

    try {
      const entries = await fs.readdir(this.memoryDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) {
          continue;
        }
        const dateDir = path.join(this.memoryDir, entry.name);
        const files = await fs.readdir(dateDir);
        for (const file of files) {
          if (file === `${shortId}.md`) {
            return path.join(dateDir, file);
          }
        }
      }
    } catch {
      // directory may not exist
    }

    return null;
  }

  private async runMdvdb(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      return await execFileAsync(this.mdvdbBin, args, {
        cwd: this.memoryDir,
        timeout: EXEC_TIMEOUT,
        maxBuffer: MAX_BUFFER,
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
