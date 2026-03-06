# memory-mdvdb

> **Experimental** — This plugin is under active development and not yet recommended for production use. APIs, storage format, and configuration may change without notice.

OpenClaw memory plugin backed by [mdvdb](https://github.com/geckse/mdvdb) — a filesystem-native Markdown vector database.

Gives OpenClaw agents long-term memory with hybrid search (semantic + BM25), time decay, and link boosting. Memories are stored as plain Markdown files with YAML frontmatter — human-readable, inspectable, and version-controllable.

Zero Node.js native dependencies. All database operations go through the `mdvdb` CLI.

## Prerequisites

- [mdvdb](https://github.com/geckse/mdvdb) CLI installed and available on PATH
- [OpenClaw](https://github.com/geckse/openclaw) runtime

## Install

```bash
# Install the plugin
openclaw plugins install @geckse/memory-mdvdb

# Set it as the active memory provider
openclaw config set plugins.slots.memory memory-mdvdb
```

### Local development

```bash
npm install

# Link plugin for local dev
npm run dev:install

# Unlink
npm run dev:uninstall
```

## Tools

The plugin registers three agent tools:

| Tool | Description |
|------|-------------|
| `memory_recall` | Search memories by query. Returns ranked results with scores. |
| `memory_store` | Save information with optional category and importance (0–1). Deduplicates automatically. |
| `memory_forget` | Delete memories by ID or search query. GDPR-compliant. |

### Categories

Memories are auto-categorized (or manually tagged) as: `preference`, `fact`, `decision`, `entity`, `other`.

## Configuration

Configure via `openclaw.plugin.json` or the OpenClaw settings UI.

```jsonc
{
  // Directory for memory files (default: ~/.openclaw/memory/mdvdb/)
  "memoryDir": "~/.openclaw/memory/mdvdb/",

  // Path to mdvdb binary (default: "mdvdb")
  "mdvdbBin": "mdvdb",

  // Auto-store important info from conversations (default: false)
  "autoCapture": false,

  // Inject relevant memories into agent context automatically (default: true)
  "autoRecall": true,

  // Max character length for auto-captured memories (default: 500)
  "captureMaxChars": 500,

  "searchDefaults": {
    // "hybrid" | "semantic" | "lexical" (default: "hybrid")
    "mode": "hybrid",

    // Reduce relevance of older memories (default: true)
    "decay": true,

    // Boost results that link to other memories (default: false)
    "boostLinks": false,

    // Max search results (default: 5)
    "limit": 5,

    // Minimum similarity score 0.0–1.0 (default: 0.1)
    "minScore": 0.1,

    // Days for memory relevance to halve (uses mdvdb config if unset)
    "decayHalfLife": 30
  }
}
```

## Lifecycle Hooks

- **Auto-recall** (`before_agent_start`) — searches memories matching the user's prompt and injects them as context. Enabled by default.
- **Auto-capture** (`agent_end`) — scans user messages for important information (preferences, decisions, entities) and stores them. Disabled by default.

Auto-capture uses rule-based trigger detection and includes prompt injection filtering to prevent storing malicious content.

## CLI

```bash
# List memory count
openclaw mdvdb-mem list

# Search memories
openclaw mdvdb-mem search "user preferences" --limit 10

# Show index statistics
openclaw mdvdb-mem stats
```

## How it works

1. Memories are stored as `.md` files organized by date (`YYYY-MM-DD/shortid.md`)
2. Each file has YAML frontmatter with `id`, `category`, `importance`, `created`, `source`, and `tags`
3. The plugin shells out to `mdvdb` CLI for indexing (`ingest`) and retrieval (`search`)
4. Search results are filtered by minimum score and ranked by the selected mode

## Testing

```bash
npm test
```

## License

MIT
