# just-bash-postgres

A PostgreSQL-backed filesystem provider for [just-bash](https://github.com/nicholasgasior/just-bash). It implements the `IFileSystem` interface using a single `fs_nodes` table with ltree for hierarchy, built-in full-text search, optional pgvector semantic search, and row-level security for per-session isolation.

## Installation

```bash
bun add just-bash-postgres
```

## Prerequisites

- PostgreSQL 14+ with the **ltree** extension (included in most distributions)
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

**Note:** `defenseInDepth: false` is required when using just-bash with postgres.js because the defense-in-depth sandbox restricts raw network access that postgres.js needs for its connection.

## Schema Setup

Calling `fs.setup()` runs an idempotent migration that creates the `fs_nodes` table, indexes, and RLS policies. It also creates the root directory for the session. You can call it on every startup safely -- it uses `IF NOT EXISTS` guards throughout.

If you pass `embeddingDimensions` in the options, `setup()` also creates the pgvector extension and adds an `embedding` column with an HNSW index.

## Search

Three search methods are available beyond the standard `IFileSystem` interface.

### Full-Text Search

Always available. Uses PostgreSQL's `tsvector` with filename weighted higher than content.

```typescript
const results = await fs.search("database migration");
// results: [{ path: "/docs/migration-guide.txt", name: "migration-guide.txt", rank: 0.8, snippet: "..." }]
```

### Semantic Search

Requires an embedding provider. Uses pgvector cosine similarity over HNSW indexes.

```typescript
const fs = new PgFileSystem({
  sql,
  sessionId: 1,
  embed: async (text) => openai.embeddings.create({ input: text, model: "text-embedding-3-small" }).then(r => r.data[0].embedding),
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

Each `PgFileSystem` instance is bound to a `sessionId`. All queries include `WHERE owner_id = $sessionId`, and the database schema enforces the same constraint via RLS policies. Sessions cannot see or modify each other's files.

```typescript
const sessionAFs = new PgFileSystem({ sql, sessionId: 1 });
const sessionBFs = new PgFileSystem({ sql, sessionId: 2 });

await sessionAFs.setup();
await sessionBFs.setup();

await sessionAFs.writeFile("/secret.txt", "session A data");
await sessionBFs.exists("/secret.txt"); // false -- completely isolated
```

No sessions table is required. `sessionId` is just a number; session management is the consuming application's responsibility.

## Configuration

```typescript
interface PgFileSystemOptions {
  /** postgres.js connection instance */
  sql: postgres.Sql;

  /** Numeric session ID for isolation. All operations are scoped to this session. */
  sessionId: number;

  /** Optional async function that returns an embedding vector for a text string.
      When provided, writeFile generates embeddings for text content. */
  embed?: (text: string) => Promise<number[]>;

  /** Dimension of the embedding vectors. Required if embed is provided.
      Must match the output of your embed function (e.g. 1536 for OpenAI text-embedding-3-small). */
  embeddingDimensions?: number;
}
```

## Security Considerations

### Trust Model

The `sessionId` is trusted without verification. The library does not authenticate sessions -- it assumes the consuming application has already validated the session before constructing a `PgFileSystem` instance.

### Connection Security

Use TLS for database connections in production by setting `sslmode=require` (or stricter) in your connection string:

```typescript
const sql = postgres("postgres://user:pass@host:5432/db?sslmode=require");
```

### Row-Level Security

The library enforces isolation at two levels: application-level `WHERE session_id = ...` on every query, and database-level RLS policies. **For RLS to be effective, the application must connect as a non-superuser role** -- PostgreSQL superusers bypass RLS entirely.

`setup()` automatically grants the necessary table permissions to a role named `fs_app` if it exists. To create this role:

```sql
CREATE ROLE fs_app LOGIN PASSWORD 'your-password';
GRANT CONNECT ON DATABASE your_db TO fs_app;
```

Then connect your application as `fs_app`:

```typescript
const sql = postgres("postgres://fs_app:your-password@localhost:5432/mydb");
```

Run `setup()` once with a superuser connection to create the schema, then switch to `fs_app` for normal operations.

### Defense in Depth

Setting `defenseInDepth: false` on the just-bash `Bash` instance disables just-bash's built-in sandbox. This is necessary because postgres.js requires raw network access. Compensate with network-level controls (firewall rules, VPC configuration) to restrict what the host can reach.

### File Size Limits

File size is configurable via the `maxFileSize` option (default 100MB). Set an appropriate limit for your use case to prevent excessive storage consumption.

## Development

### Docker Compose

A `docker-compose.yml` is included for running PostgreSQL with pgvector locally:

```bash
docker compose up -d
```

This starts PostgreSQL 17 with pgvector on port 5433 (host) mapped to 5432 (container), using the `just_bash_postgres_test` database with trust authentication.

### Running Tests

Tests run against a real PostgreSQL instance. Start the database first, then run:

```bash
docker compose up -d
bun test
```

By default, tests connect to `postgres://postgres@localhost:5433/just_bash_postgres_test`. Override with the `TEST_DATABASE_URL` environment variable.

### Type Checking

```bash
bun run typecheck
```
