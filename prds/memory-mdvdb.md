# PRD: OpenClaw Memory Plugin — mdvdb Backend

## Overview

An OpenClaw memory plugin (`memory-mdvdb`) that replaces the default file-backed memory and the LanceDB-based alternative with **mdvdb** — a filesystem-native Markdown vector database. The plugin shells out to the `mdvdb` CLI for all search, indexing, and retrieval, storing memories as plain Markdown files with YAML frontmatter. This gives agents hybrid search (semantic + BM25), time decay, link boosting, and section-level results with zero library dependencies — just a CLI binary on PATH.

## Problem Statement

The current memory options for OpenClaw agents are:

1. **memory-core** — file-backed with basic search. Limited semantic capabilities, tightly coupled to the OpenClaw runtime's built-in tools.
2. **memory-lancedb** — powerful vector search but requires embedding the LanceDB native library (platform-specific, fails on some macOS builds) and the OpenAI SDK. Heavy dependencies for what should be a lightweight concern.

Neither option provides hybrid search (semantic + lexical), time decay, link-aware re-ranking, or inspectable plain-text storage out of the box. **mdvdb** already solves all of these as a standalone CLI designed explicitly for agent memory workflows.

## Goals

- Drop-in replacement for the LanceDB memory plugin with the same 3-tool interface (`memory_recall`, `memory_store`, `memory_forget`)
- Zero Node.js native dependencies — all DB operations via `mdvdb` CLI subprocess calls
- Memories stored as human-readable Markdown files with YAML frontmatter (inspectable, version-controllable)
- Hybrid search (semantic + BM25) with optional time decay and link boosting, configurable per-plugin
- Auto-recall via `before_agent_start` hook and auto-capture via `agent_end` hook (same lifecycle as LanceDB plugin)
- Hybrid mdvdb config management: auto-create `.markdownvdb` if missing, respect existing config if present
- CLI subcommand `mdvdb-mem` for manual memory management

## Non-Goals

- Replacing or modifying the `memory-core` plugin — this is a separate, additive plugin
- Implementing a Rust/WASM binding to mdvdb — we use the CLI exclusively
- Managing mdvdb installation — the binary must be pre-installed on PATH
- Supporting mdvdb's `watch` mode from within the plugin — we use explicit `ingest --file` calls
- Embedding generation — mdvdb handles this internally via its own config

## Technical Design

### Data Model Changes

**No changes to OpenClaw core.** The plugin introduces its own data model:

**Memory Entry (Markdown file with YAML frontmatter):**
```yaml
---
id: a1b2c3d4-e5f6-7890-abcd-ef1234567890
category: preference | fact | decision | entity | other
importance: 0.7          # 0.0-1.0
created: 2026-03-06T12:00:00.000Z
source: manual | auto-capture
tags:
  - memory
---

The user prefers dark mode for all applications.
```

**File layout:** `<memoryDir>/<YYYY-MM-DD>/<short-id>.md`
Example: `~/.openclaw/memory/mdvdb/2026-03-06/a1b2c3d4.md`

**mdvdb index:** Auto-managed by mdvdb in `<memoryDir>/.markdownvdb.idx` + `<memoryDir>/fts/`

### Interface Changes

**Plugin config type (`src/config.ts`):**
```typescript
type MdvdbMemoryConfig = {
  memoryDir: string;        // default: ~/.openclaw/memory/mdvdb/
  mdvdbBin: string;         // default: "mdvdb"
  autoCapture: boolean;     // default: false
  autoRecall: boolean;      // default: true
  captureMaxChars: number;  // default: 500
  searchDefaults: {
    mode: "hybrid" | "semantic" | "lexical";  // default: "hybrid"
    decay: boolean;          // default: true
    boostLinks: boolean;     // default: false
    limit: number;           // default: 5
    minScore: number;        // default: 0.1
    decayHalfLife?: number;  // days, undefined = use mdvdb config
  };
};
```

**Tool interfaces (identical to LanceDB for compatibility):**
- `memory_recall({ query: string, limit?: number })` -> `{ content, details: { count, memories } }`
- `memory_store({ text: string, importance?: number, category?: string })` -> `{ content, details: { action, id } }`
- `memory_forget({ query?: string, memoryId?: string })` -> `{ content, details: { action, id? } }`

### New Commands / API / UI

**Agent tools (LLM-callable):**
- `memory_recall` — search memories via mdvdb
- `memory_store` — write memory as .md file + index
- `memory_forget` — delete memory file + re-index

**CLI commands (`openclaw mdvdb-mem ...`):**
- `mdvdb-mem list` — show memory count
- `mdvdb-mem search <query> [--limit N]` — search memories
- `mdvdb-mem stats` — show index statistics (doc count, chunk count, index size)

**Lifecycle hooks:**
- `before_agent_start` — auto-recall relevant memories into context
- `agent_end` — auto-capture important information from conversation

### Migration Strategy

This is a new plugin — no migration needed. Users opt in by installing and configuring `@geckse/openclaw-mdvdb-memory` in their OpenClaw config. The LanceDB and core memory plugins continue to work independently.

For users migrating from LanceDB: memories would need to be re-created (export from LanceDB -> write as .md files -> `mdvdb ingest`). This is out of scope for v1 but could be a future CLI command.

## Implementation Steps

### 1. Create project scaffolding

Create the following files at the project root:
- `package.json` — name `@geckse/openclaw-mdvdb-memory`, `"type": "module"`, `@sinclair/typebox` dependency, `openclaw.extensions: ["./src/index.ts"]`
- `openclaw.plugin.json` — plugin manifest with id `memory-mdvdb`, kind `memory`, configSchema, uiHints
- `src/` directory for source files

**Reference:** `resource/memory-lancedb/package.json`, `resource/memory-lancedb/openclaw.plugin.json`

### 2. Implement `src/config.ts`

Config schema with `memoryConfigSchema` object containing a `parse(value)` method and `uiHints`. Fields: `memoryDir`, `mdvdbBin`, `autoCapture`, `autoRecall`, `captureMaxChars`, `searchDefaults` (with `mode`, `decay`, `boostLinks`, `limit`, `minScore`, `decayHalfLife`).

- Resolve `~` and env vars in paths
- Validate ranges (captureMaxChars 100-10000, minScore 0-1, limit > 0)
- Default `memoryDir` to `~/.openclaw/memory/mdvdb/`
- Export `MEMORY_CATEGORIES` and `MemoryCategory` type

**Reference:** `resource/memory-lancedb/config.ts`

### 3. Implement `src/mdvdb.ts` — CLI wrapper class

`MdvdbMemory` class that encapsulates all mdvdb CLI interactions:

- **`constructor(memoryDir, mdvdbBin, searchDefaults)`**
- **`ensureInitialized()`** — `mkdir -p` the memory dir, check if `.markdownvdb` exists, if not create default config via `mdvdb init --root <dir>` or write `.markdownvdb` directly
- **`search(query, opts?)`** — build `mdvdb search <query> --json --root <dir>` with optional `--limit`, `--min-score`, `--decay`, `--boost-links`, `--mode`, `--filter`; parse JSON stdout; return results with scores
- **`store(text, category, importance, source)`** — generate UUID, create date dir, write `.md` file with frontmatter, exec `mdvdb ingest --file <path> --root <dir>`; return the entry
- **`delete(id)`** — scan files for matching frontmatter `id` (or use filename convention), delete file, exec `mdvdb ingest --root <dir>` to update index
- **`count()`** — exec `mdvdb status --json --root <dir>`, return `document_count`
- **`findBySearch(query, limit, minScore)`** — convenience wrapper around `search()` used for duplicate detection

All CLI calls use `child_process.execFile` (not `exec`) for safety. Parse `--json` output. Handle errors gracefully (binary not found, index not initialized, etc).

### 4. Implement `src/index.ts` — Main plugin

Structure mirrors `resource/memory-lancedb/index.ts`:

**Pure helper functions (copy from LanceDB, adapt as needed):**
- `shouldCapture(text, options?)` — trigger-based capture filter
- `detectCategory(text)` — rule-based categorization
- `looksLikePromptInjection(text)` — injection detection
- `escapeMemoryForPrompt(text)` — XML escaping
- `formatRelevantMemoriesContext(memories)` — `<relevant-memories>` block formatter

**Plugin object:**
```typescript
const memoryPlugin = {
  id: "memory-mdvdb",
  name: "Memory (mdvdb)",
  kind: "memory" as const,
  configSchema: memoryConfigSchema,
  register(api: OpenClawPluginApi) {
    // 1. Parse config
    // 2. Create MdvdbMemory instance
    // 3. Register 3 tools (memory_recall, memory_store, memory_forget)
    // 4. Register CLI (mdvdb-mem: list, search, stats)
    // 5. Register hooks (before_agent_start, agent_end)
    // 6. Register service
  }
};
export default memoryPlugin;
```

**Tool implementations:**
- `memory_recall`: call `mdvdb.search()`, format results same as LanceDB (numbered list with category + score)
- `memory_store`: check for duplicates via `mdvdb.search()` with high minScore (0.95), then `mdvdb.store()`. Return duplicate/created status
- `memory_forget`: by memoryId -> `mdvdb.delete(id)`. By query -> `mdvdb.search()` -> if 1 result with score >0.9 auto-delete, otherwise return candidates list

**Hook implementations:**
- `before_agent_start`: if prompt length >= 5, search with limit 3 + decay, format and return `{ prependContext }`
- `agent_end`: extract user message texts, filter with `shouldCapture()`, categorize, store up to 3 per conversation

### 5. Implement `src/index.test.ts` — Tests

**Unit tests:**
- Config parsing: valid config, missing fields, range validation, env var resolution, defaults
- `shouldCapture`: triggers match, length bounds, injection rejection, system content rejection
- `detectCategory`: preference, decision, entity, fact, other classifications
- `looksLikePromptInjection`: positive and negative cases
- `formatRelevantMemoriesContext`: escaping, format structure
- CLI command builder: verify correct args for various search options

**Integration tests (guarded by `mdvdb` availability check):**
- Store a memory -> verify .md file created with correct frontmatter
- Store -> search -> verify match found
- Store -> delete -> verify file removed and search returns empty
- Duplicate detection: store same text twice -> second returns duplicate
- Auto-capture filtering: verify only user messages matching triggers are captured

**Reference:** `resource/memory-lancedb/index.test.ts`

### 6. Create `.markdownvdb` template

Default config template the plugin writes when initializing a new memory directory:
```env
MDVDB_SOURCE_DIRS=.
MDVDB_SEARCH_MODE=hybrid
MDVDB_TIME_DECAY=true
MDVDB_DECAY_HALF_LIFE_DAYS=30
```

The embedding provider settings are left to the user's global mdvdb config (`~/.mdvdb/config`) or environment variables.

## Validation Criteria

- [ ] Plugin loads and registers without errors when mdvdb is on PATH
- [ ] `memory_store` creates a `.md` file with correct YAML frontmatter in the configured memory directory
- [ ] `memory_store` calls `mdvdb ingest --file` after writing, so the memory is immediately searchable
- [ ] `memory_recall` returns results from `mdvdb search --json` with scores and categories
- [ ] `memory_forget` by ID deletes the correct file and re-indexes
- [ ] `memory_forget` by query shows candidates when multiple matches exist
- [ ] Duplicate detection prevents storing near-identical memories (similarity > 0.95)
- [ ] Auto-recall hook injects `<relevant-memories>` context before agent starts
- [ ] Auto-capture hook stores important user messages after agent ends
- [ ] `shouldCapture` rejects prompt injection attempts, system content, and agent output
- [ ] Plugin gracefully errors if mdvdb binary is not found (clear error message, no crash)
- [ ] Config validates correctly: missing fields error, range violations error, defaults applied
- [ ] CLI commands (`mdvdb-mem list/search/stats`) work from the OpenClaw CLI
- [ ] `--json` output from mdvdb is correctly parsed in all tools
- [ ] Memory directory and `.markdownvdb` config are auto-created on first use if absent
- [ ] Existing `.markdownvdb` config is preserved (not overwritten)

## Anti-Patterns to Avoid

- **Do NOT use `child_process.exec()`** — use `execFile()` to prevent shell injection. Query text must never be interpolated into a shell string. Pass as separate args array.
- **Do NOT embed the OpenAI SDK** — mdvdb handles embeddings internally. The plugin should have zero embedding logic.
- **Do NOT use synchronous file I/O** — all `fs` operations must be async (`fs.promises`). The plugin runs in the agent event loop.
- **Do NOT swallow errors silently** — log via `api.logger.warn()` and return user-facing error messages. Especially important for "mdvdb not found" scenarios.
- **Do NOT write memory files without frontmatter** — mdvdb uses frontmatter for metadata filtering. Missing frontmatter means `--filter category=X` won't work.
- **Do NOT store assistant/model messages in auto-capture** — only capture `role: "user"` messages to avoid self-poisoning feedback loops (see LanceDB `agent_end` hook logic).
- **Do NOT re-ingest the entire index after every store** — use `mdvdb ingest --file <path>` for single-file incremental updates. Full re-ingest is only needed after delete.

## Patterns to Follow

- **Plugin structure:** Mirror `resource/memory-lancedb/index.ts` — same tool names, same return format (`{ content, details }`), same hook patterns. This ensures behavioral compatibility.
- **Config schema:** Follow `resource/memory-lancedb/config.ts` — `parse()` method with validation, `uiHints` object, env var resolution via `${VAR}` syntax.
- **Manifest format:** Follow `resource/memory-lancedb/openclaw.plugin.json` — include `configSchema`, `uiHints`, `kind: "memory"`.
- **Package.json:** Follow `resource/memory-lancedb/package.json` — `"type": "module"`, `openclaw.extensions` array.
- **Tool return format:** `{ content: [{ type: "text", text }], details: { ... } }` — the `details` object carries structured data for downstream processing, `content` is human-readable.
- **Memory safety:** Reuse `looksLikePromptInjection()`, `escapeMemoryForPrompt()`, `formatRelevantMemoriesContext()` from the LanceDB plugin. These are battle-tested against prompt injection.
- **Test structure:** Follow `resource/memory-lancedb/index.test.ts` — vitest, dynamic imports, mock API pattern for registration tests, live test guard with `describe.skip`.
