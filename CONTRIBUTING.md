# Contributing

## Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/F1nnM/just-bash-postgres.git
   cd just-bash-postgres
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Start PostgreSQL:
   ```bash
   docker compose up -d
   ```

   This starts PostgreSQL 17 with pgvector on port 5433 using trust authentication.

## Development Workflow

### Run tests

```bash
bun test
```

Tests connect to `postgres://postgres@localhost:5433/just_bash_postgres_test` by default. Override with `TEST_DATABASE_URL`.

### Run a single test file

```bash
bun test tests/search.test.ts
```

### Type check

```bash
bun run typecheck
```

## Project Structure

```
src/
  index.ts           # Public exports
  pg-filesystem.ts   # Core IFileSystem implementation
  schema.ts          # Schema migrations (idempotent)
  search.ts          # Full-text, semantic, and hybrid search
  path-encoding.ts   # POSIX path <-> ltree conversion
sql/
  001-setup.sql      # Main schema DDL
tests/
  helpers.ts         # Shared test utilities
  *.test.ts          # Test files
```

## Architecture

- All filesystem state lives in a single `fs_nodes` table
- Paths are stored as `ltree` labels prefixed with `s{sessionId}`
- Special characters in path segments are encoded (e.g., `_` -> `__5F__`, `.` -> `__dot__`)
- Every public method calls `normalizePath()` and runs inside a `withSession()` transaction that sets `app.session_id` for RLS

## Guidelines

- Tests run against a real PostgreSQL instance -- no mocks
- All schema changes must be idempotent (`IF NOT EXISTS`, `DO $$ ... EXCEPTION ...`)
- New public methods should respect session isolation via `withSession()`
