# just-bash-postgres

[![CI](https://github.com/F1nnM/just-bash-postgres/actions/workflows/ci.yml/badge.svg)](https://github.com/F1nnM/just-bash-postgres/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/endpoint?url=https://f1nnm.github.io/just-bash-postgres/coverage.json)](https://github.com/F1nnM/just-bash-postgres/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/just-bash-postgres)](https://www.npmjs.com/package/just-bash-postgres)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A PostgreSQL-backed filesystem provider for [just-bash](https://github.com/nicholasgasior/just-bash). Implements the `IFileSystem` interface using a single `fs_nodes` table with ltree for hierarchy, built-in full-text search, optional pgvector semantic search, and row-level security for per-session isolation.

## Features

- **Full `IFileSystem` implementation** -- files, directories, symlinks, hard links, chmod, stat, recursive cp/rm/mv
- **Full-text search** -- PostgreSQL `tsvector` with weighted filename + content ranking
- **Semantic search** -- pgvector cosine similarity with any embedding provider
- **Hybrid search** -- combined text + vector ranking with configurable weights
- **Multi-tenant isolation** -- per-session scoping via `sessionId`, enforced by both application logic and RLS
- **Idempotent schema setup** -- safe to call `setup()` on every startup

## Installation

```bash
bun add just-bash-postgres
```

Or with npm:

```bash
npm install just-bash-postgres
```

### Prerequisites

- **Bun** >= 1.0
- **PostgreSQL** 14+ with the **ltree** extension (included in most distributions)
- **pgvector** extension (optional, only needed for semantic/hybrid search)

## Quick Start

```typescript
import postgres from "postgres";
import { PgFileSystem } from "just-bash-postgres";
import { Bash } from "just-bash";

const sql = postgres("postgres://user:pass@localhost:5432/mydb");

const fs = new PgFileSystem({ sql, sessionId: 1 });
await fs.setup(); // creates tables, indexes, and RLS policies

const bash = new Bash({ fs, cwd: "/", defenseInDepth: false });

await bash.exec('echo "hello" > /greeting.txt');
const result = await bash.exec("cat /greeting.txt");
console.log(result.stdout); // "hello\n"
```

> **Note:** `defenseInDepth: false` is required when using just-bash with postgres.js because the defense-in-depth sandbox restricts raw network access that postgres.js needs for its connection.

## Schema Setup

`fs.setup()` runs an idempotent migration that creates the `fs_nodes` table, indexes, and RLS policies, along with the root directory for the session. Safe to call on every startup -- all statements use `IF NOT EXISTS` guards.

If you pass `embeddingDimensions` in the options, `setup()` also creates the pgvector extension and adds an `embedding` column with an HNSW index.

## Search

Three search methods are available beyond the standard `IFileSystem` interface.

### Full-Text Search

Always available. Uses PostgreSQL's `tsvector` with filename weighted higher than content.

```typescript
const results = await fs.search("database migration");
// [{ path: "/docs/migration-guide.txt", name: "migration-guide.txt", rank: 0.8, snippet: "..." }]
```

### Semantic Search

Requires an embedding provider. Uses pgvector cosine similarity over HNSW indexes.

```typescript
const fs = new PgFileSystem({
  sql,
  sessionId: 1,
  embed: async (text) =>
    openai.embeddings
      .create({ input: text, model: "text-embedding-3-small" })
      .then((r) => r.data[0].embedding),
  embeddingDimensions: 1536,
});
await fs.setup();

const results = await fs.semanticSearch("how to deploy the app");
```

### Hybrid Search

Combines full-text and vector search with configurable weights (default: 0.4 text, 0.6 vector).

```typescript
const results = await fs.hybridSearch("deployment guide", {
  textWeight: 0.3,
  vectorWeight: 0.7,
  limit: 10,
});
```

All search methods accept an optional `path` parameter to scope results to a subtree:

```typescript
const results = await fs.search("config", { path: "/app/settings" });
```

### SearchResult

```typescript
interface SearchResult {
  path: string;
  name: string;
  rank: number;
  snippet?: string; // only present for full-text search
}
```

## Session Isolation

Each `PgFileSystem` instance is bound to a `sessionId`. All queries include `WHERE session_id = $sessionId`, and the database schema enforces the same constraint via RLS policies. Sessions cannot see or modify each other's files.

```typescript
const sessionAFs = new PgFileSystem({ sql, sessionId: 1 });
const sessionBFs = new PgFileSystem({ sql, sessionId: 2 });

await sessionAFs.setup();
await sessionBFs.setup();

await sessionAFs.writeFile("/secret.txt", "session A data");
await sessionBFs.exists("/secret.txt"); // false -- completely isolated
```

No sessions table is required. `sessionId` is just a positive integer; session management is the consuming application's responsibility.

## Configuration

```typescript
interface PgFileSystemOptions {
  /** postgres.js connection instance */
  sql: postgres.Sql;

  /** Positive integer session ID for isolation. All operations are scoped to this session. */
  sessionId: number;

  /** Maximum file size in bytes (default: 100MB) */
  maxFileSize?: number;

  /** Statement timeout in milliseconds (default: 30000) */
  statementTimeout?: number;

  /** Async function that returns an embedding vector for text content.
      When provided, writeFile generates embeddings automatically. */
  embed?: (text: string) => Promise<number[]>;

  /** Dimension of embedding vectors. Required if embed is provided.
      Must match your embed function output (e.g. 1536 for text-embedding-3-small). */
  embeddingDimensions?: number;
}
```

## API

### Filesystem Operations

| Method | Description |
|--------|-------------|
| `setup()` | Create schema, indexes, RLS policies, and root directory |
| `writeFile(path, content)` | Create or overwrite a file |
| `readFile(path)` | Read file as UTF-8 string |
| `readFileBuffer(path)` | Read file as `Uint8Array` |
| `appendFile(path, content)` | Append to a file |
| `exists(path)` | Check if path exists |
| `stat(path)` | Get file stats (follows symlinks) |
| `lstat(path)` | Get file stats (does not follow symlinks) |
| `mkdir(path, options?)` | Create directory (`{ recursive: true }` supported) |
| `readdir(path)` | List directory entries as strings |
| `readdirWithFileTypes(path)` | List directory entries with type info |
| `rm(path, options?)` | Delete file or directory (`{ recursive: true }` supported) |
| `mv(src, dest)` | Move/rename file or directory |
| `cp(src, dest, options?)` | Copy file or directory (`{ recursive: true }` supported) |
| `chmod(path, mode)` | Change file mode |
| `utimes(path, atime, mtime)` | Update modification time |
| `symlink(target, path)` | Create a symbolic link |
| `readlink(path)` | Read symlink target |
| `link(src, dest)` | Create a hard link (copies content) |
| `realpath(path)` | Resolve symlinks (max 16 levels) |

### Search Operations

| Method | Description |
|--------|-------------|
| `search(query, options?)` | Full-text search with websearch syntax |
| `semanticSearch(query, options?)` | Vector cosine similarity search |
| `hybridSearch(query, options?)` | Combined text + vector search |

### Schema Utilities

| Export | Description |
|--------|-------------|
| `setupSchema(sql)` | Run schema migration standalone |
| `setupVectorColumn(sql, dimensions)` | Add vector column standalone |
| `FsError` | Error class with POSIX codes (ENOENT, EISDIR, etc.) |

## Security

### Trust Model

The `sessionId` is trusted without verification. The library assumes the consuming application has validated the session before constructing a `PgFileSystem` instance.

### Connection Security

Use TLS for database connections in production:

```typescript
const sql = postgres("postgres://user:pass@host:5432/db?sslmode=require");
```

### Row-Level Security

Isolation is enforced at two levels: application-level `WHERE session_id = ...` on every query, and database-level RLS policies. **For RLS to be effective, connect as a non-superuser role** -- PostgreSQL superusers bypass RLS.

`setup()` automatically grants permissions to a role named `fs_app` if it exists:

```sql
CREATE ROLE fs_app LOGIN PASSWORD 'your-password';
GRANT CONNECT ON DATABASE your_db TO fs_app;
```

Run `setup()` once with a superuser connection to create the schema, then use `fs_app` for normal operations:

```typescript
const sql = postgres("postgres://fs_app:your-password@localhost:5432/mydb");
```

### Defense in Depth

Setting `defenseInDepth: false` on the just-bash `Bash` instance disables just-bash's built-in sandbox, which is necessary because postgres.js requires raw network access. Compensate with network-level controls (firewall rules, VPC configuration) to restrict what the host can reach.

## Development

### Setup

```bash
git clone https://github.com/F1nnM/just-bash-postgres.git
cd just-bash-postgres
bun install
docker compose up -d
```

### Running Tests

Tests run against a real PostgreSQL instance (110+ tests across 7 files):

```bash
docker compose up -d
bun test
```

By default, tests connect to `postgres://postgres@localhost:5433/just_bash_postgres_test`. Override with `TEST_DATABASE_URL`.

### Type Checking

```bash
bun run typecheck
```

## Publishing

Releases are published to npm automatically via GitHub Actions when you [create a release](https://github.com/F1nnM/just-bash-postgres/releases/new) on GitHub.

To publish manually:

```bash
npm publish
```

> Requires `NPM_TOKEN` secret in the repository settings for automated publishing.

## License

[MIT](LICENSE)
