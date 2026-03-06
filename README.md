# memory-mdvdb

> **Experimental** — APIs, storage format, and configuration may change without notice.

OpenClaw memory plugin backed by [mdvdb](https://github.com/geckse/mdvdb) — a filesystem-native Markdown vector database.

Hybrid search (semantic + BM25), time decay, wiki-link boosting, frontmatter filtering. Memories are plain Markdown with YAML frontmatter — human-readable, version-controllable.

Zero Node.js native dependencies. All operations go through the `mdvdb` CLI.

## Prerequisites

- [mdvdb](https://github.com/geckse/mdvdb) CLI on PATH
- [OpenClaw](https://github.com/geckse/openclaw) runtime

## Install

```bash
openclaw plugins install @geckse/memory-mdvdb
openclaw config set plugins.slots.memory memory-mdvdb
```

### Local development

```bash
npm install
npm run dev:install    # link plugin
npm run dev:uninstall  # unlink
```

## Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid recall over indexed memories. Supports frontmatter filtering (`--filter category=preference`) and path scoping. |
| `memory_get` | Read a memory file by path, optionally a line range. Graceful on missing files. |
| `memory_store` | Store a memory with category, importance (0-1), tags, and `[[wiki-links]]`. Auto-discovers related memories. |
| `memory_forget` | Delete by ID or search query. |

### Categories

`preference`, `fact`, `decision`, `entity`, `other`

### Frontmatter filtering

```json
{ "query": "user preferences", "filter": ["category=preference", "importance=0.9"] }
```

### Wiki-links

Storing a memory auto-discovers related ones and adds `[[wiki-links]]`. Linked memories rank higher with `boostLinks`.

```json
{ "text": "Switched to Bun runtime", "links": ["2026-03-06-a1b2c3d4"] }
```

## Time decay

By default, only time-log memory files (`YYYY-MM-DD-*.md`) are subject to time decay. Static knowledge files in the memory directory are unaffected.

- **Half-life:** 7 days — a memory's relevance halves every week
- **Scoped via `decayInclude`:** defaults to `["????-??-??-*.md"]`
- Override with `decayExclude` to exempt specific patterns

## Excluded files

OpenClaw workspace files are excluded from indexing by default:

`AGENTS.md`, `HEARTBEAT.md`, `SOUL.md`, `IDENTITY.md`, `BOOTSTRAP.md`, `TOOLS.md`, `USER.md`

These are loaded by OpenClaw through their own mechanisms — indexing them as memories would create duplicate signals.

Override via `ignorePatterns`. Set to `[]` to disable all exclusions.

## Configuration

Config goes in `~/.openclaw/openclaw.json` under `plugins.entries.memory-mdvdb.config`:

```jsonc
{
  "plugins": {
    "entries": {
      "memory-mdvdb": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "openai",
            "apiKey": "${OPENAI_API_KEY}"
          }
        }
      }
    }
  }
}
```

### Embedding providers

**OpenAI** (default):
```jsonc
{ "provider": "openai", "apiKey": "${OPENAI_API_KEY}" }
```

**Ollama** (local):
```jsonc
{ "provider": "ollama", "model": "nomic-embed-text" }
```

**Custom** (OpenAI-compatible):
```jsonc
{ "provider": "custom", "baseUrl": "https://api.example.com/v1", "apiKey": "..." }
```

### Full reference

```jsonc
{
  "memoryDir": "~/.openclaw/workspace/memory/",
  "mdvdbBin": "mdvdb",
  "embedding": { "provider": "openai", "apiKey": "${OPENAI_API_KEY}" },
  "autoCapture": false,
  "autoRecall": true,
  "captureMaxChars": 500,
  "ignorePatterns": ["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "IDENTITY.md", "BOOTSTRAP.md", "TOOLS.md", "USER.md"],
  "searchDefaults": {
    "mode": "hybrid",           // "hybrid" | "semantic" | "lexical"
    "decay": true,              // enable time decay
    "decayHalfLife": 7,         // days for relevance to halve
    "decayInclude": ["????-??-??-*.md"],  // only these files decay
    "decayExclude": [],         // exempt patterns from decay
    "boostLinks": false,        // boost wiki-linked results
    "limit": 5,
    "minScore": 0.1
  }
}
```

## Lifecycle Hooks

- **Auto-recall** (`before_agent_start`) — injects matching memories into context. On by default.
- **Auto-capture** (`agent_end`) — stores important info from conversations. Off by default.

## CLI

```bash
openclaw mdvdb-mem list                        # memory count
openclaw mdvdb-mem search "query" --limit 10   # search
openclaw mdvdb-mem ingest                      # index all files
openclaw mdvdb-mem ingest --file path/to.md    # index one file
openclaw mdvdb-mem reindex                     # full re-embed
openclaw mdvdb-mem stats                       # index statistics
```

## How it works

1. Memories stored as `YYYY-MM-DD-<shortId>.md` with YAML frontmatter
2. Related memories linked via `[[wiki-links]]` for link-boosting
3. Plugin shells out to `mdvdb` CLI for indexing and search
4. Time decay scoped to time-log files only — static knowledge stays evergreen
5. OpenClaw workspace files excluded by default

## Testing

```bash
npm test
```

## License

MIT
