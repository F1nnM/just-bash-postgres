# PgFileSystem: PostgreSQL-backed filesystem provider for just-bash

## Summary

A TypeScript package that implements just-bash's `IFileSystem` interface backed by PostgreSQL. Files and directories are stored in a single `fs_nodes` table using ltree for hierarchy, with optional full-text search and vector embedding search for text files. Row-level security enforces complete per-user isolation.

## Stack

- **Runtime**: bun
- **Test runner**: bun test
- **SQL client**: postgres.js
- **PostgreSQL extensions**: ltree, pgvector (optional)

## Core Architecture

Single `fs_nodes` table. Each row is a file, directory, or symlink. Hierarchy is modeled with both `parent_id` (referential integrity) and an `ltree` `path` column (fast hierarchical queries). Every node is scoped to an `owner_id`.

The `PgFileSystem` class implements `IFileSystem` (20 required methods). It takes a postgres.js connection and a `userId` at construction. All queries include `WHERE owner_id = $userId`.

### Schema

```sql
CREATE EXTENSION IF NOT EXISTS ltree;
-- pgvector is optional, only if embeddings are used
-- CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE fs_nodes (
    id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    owner_id        bigint NOT NULL,
    parent_id       bigint REFERENCES fs_nodes(id) ON DELETE CASCADE,
    name            text NOT NULL,
    node_type       text NOT NULL CHECK (node_type IN ('file', 'directory', 'symlink')),
    path            ltree NOT NULL,
    content         text,
    binary_data     bytea,
    symlink_target  text,
    mode            int NOT NULL DEFAULT 644,
    size_bytes      bigint NOT NULL DEFAULT 0,
    mtime           timestamptz NOT NULL DEFAULT now(),
    created_at      timestamptz NOT NULL DEFAULT now(),
    search_vector   tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(content, '')), 'C')
    ) STORED,

    CONSTRAINT unique_owner_path UNIQUE (owner_id, path)
);

CREATE INDEX idx_fs_path_gist ON fs_nodes USING GIST (path gist_ltree_ops(siglen=124));
CREATE INDEX idx_fs_parent ON fs_nodes (parent_id);
CREATE INDEX idx_fs_owner ON fs_nodes (owner_id);
CREATE INDEX idx_fs_owner_parent ON fs_nodes (owner_id, parent_id);
CREATE INDEX idx_fs_search ON fs_nodes USING GIN (search_vector);
```

Vector embedding column is added dynamically when an embedding provider is configured:

```sql
-- Added at runtime if embeddingDimensions is set
ALTER TABLE fs_nodes ADD COLUMN embedding vector(N);
CREATE INDEX idx_fs_embedding ON fs_nodes
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
```

## Path Encoding (POSIX to ltree)

ltree labels allow `[A-Za-z0-9_-]`. Filenames with other characters are encoded:

| Character | Encoding |
|-----------|----------|
| `.`       | `__dot__` |
| ` `       | `__sp__` |
| `-`       | `-` (as-is) |
| `_`       | `_` (as-is) |
| other     | `__XX__` (hex) |

Each path segment (split on `/`) becomes one ltree label, prefixed with the user ID:

```
/home/docs/readme.md  ->  u42.home.docs.readme__dot__md
/my file.txt          ->  u42.my__sp__file__dot__txt
```

Two pure functions handle conversion:
- `pathToLtree(posixPath, userId) -> string`
- `ltreeToPath(ltree) -> string`

## User Isolation

### Application level
Every query includes `WHERE owner_id = $userId`. The userId is fixed at construction.

### Database level (defense-in-depth)
RLS policies enforce the same constraint. `set_config('app.user_id', ...)` is called per transaction.

```sql
ALTER TABLE fs_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fs_nodes FORCE ROW LEVEL SECURITY;

CREATE POLICY user_isolation ON fs_nodes FOR ALL
    USING (owner_id = current_setting('app.user_id', true)::bigint)
    WITH CHECK (owner_id = current_setting('app.user_id', true)::bigint);
```

No users table. `owner_id` is just a number. User management is the consuming application's responsibility.

### Per-user path roots
Each user's ltree paths are prefixed with `u{userId}`. This prevents path collisions and makes RLS + ltree work together cleanly.

## Search Features

### Full-text search (always available)
The `search_vector` generated column indexes filename (weight A) and content (weight C). Uses `websearch_to_tsquery` for natural query syntax.

### Vector search (opt-in)
Requires passing `embed` function and `embeddingDimensions` at construction. Embeddings are generated on `writeFile` for text content. HNSW index enables fast cosine similarity queries.

### Extra methods (beyond IFileSystem)

```typescript
search(query: string, opts?: { path?: string }): Promise<SearchResult[]>
semanticSearch(query: string, opts?: { path?: string; limit?: number }): Promise<SearchResult[]>
hybridSearch(query: string, opts?: {
    path?: string;
    textWeight?: number;
    vectorWeight?: number;
    limit?: number;
}): Promise<SearchResult[]>
```

Searches can be scoped to a subtree using ltree's `<@` operator.

## Public API

```typescript
import { PgFileSystem } from "just-bash-postgres";
import { Bash } from "just-bash";
import postgres from "postgres";

const sql = postgres("postgres://...");

const fs = new PgFileSystem({
    sql,
    userId: 42,
    // Optional: enable vector search
    embed: async (text) => getEmbedding(text),
    embeddingDimensions: 1536,
});

// Ensure schema exists
await fs.setup();

const bash = new Bash({ fs });
```

## Project Structure

```
src/
  index.ts              # public exports
  pg-filesystem.ts      # IFileSystem implementation
  path-encoding.ts      # POSIX <-> ltree conversion
  schema.ts             # SQL migration/setup
  search.ts             # FTS, vector, hybrid search methods
sql/
  001-setup.sql         # extensions + table + indexes + RLS
tests/
  path-encoding.test.ts # pure unit tests
  pg-filesystem.test.ts # all IFileSystem methods against real PG
  search.test.ts        # FTS and vector search
  rls.test.ts           # multi-user isolation verification
docs/
  plans/                # this file
```

## Testing Strategy

- **TDD with Red-Green-Refactor**: write failing test first, implement minimally, refactor
- **Real PostgreSQL**: tests run against a real PG instance (Docker)
- **No mocks**: all database tests use real queries
- **Path encoding**: pure unit tests, no DB
- **IFileSystem methods**: write then read, mkdir then readdir, etc.
- **RLS tests**: two PgFileSystem instances with different userIds verify complete isolation
- **Search tests**: write files with known content, verify FTS and vector results
