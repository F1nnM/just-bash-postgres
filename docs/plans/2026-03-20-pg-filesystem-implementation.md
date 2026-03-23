# PgFileSystem Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement a PostgreSQL-backed `IFileSystem` provider for just-bash with ltree hierarchy, FTS, optional vector search, and RLS-based user isolation.

**Architecture:** Single `fs_nodes` table stores all filesystem nodes. `PgFileSystem` class implements just-bash's `IFileSystem` (20 methods). Path encoding converts POSIX paths to ltree labels. RLS + application-level WHERE clauses enforce per-user isolation. Search methods extend beyond the IFileSystem interface.

**Tech Stack:** bun, TypeScript, postgres.js, PostgreSQL (ltree, tsvector, pgvector)

---

### Task 1: Project Bootstrap

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/index.ts`
- Create: `.gitignore`

**Step 1: Initialize bun project and install dependencies**

Run:
```bash
cd /home/finn/Repos/just-bash-postgres
bun init -y
bun add postgres just-bash
bun add -d @types/bun
```

**Step 2: Configure tsconfig.json**

Replace the generated `tsconfig.json` with:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationDir": "dist",
    "types": ["bun-types"]
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

**Step 3: Update .gitignore**

```
node_modules/
dist/
*.tgz
.env
```

**Step 4: Create empty entry point**

`src/index.ts`:
```typescript
// just-bash-postgres: PostgreSQL filesystem provider for just-bash
```

**Step 5: Verify setup**

Run: `bun run src/index.ts`
Expected: exits cleanly with no output

**Step 6: Commit**

```bash
git add package.json tsconfig.json src/index.ts .gitignore bun.lock
git commit -m "bootstrap: bun project with postgres.js and just-bash deps"
```

---

### Task 2: Path Encoding (Pure Unit Tests)

**Files:**
- Create: `src/path-encoding.ts`
- Create: `tests/path-encoding.test.ts`

**Step 1: Write failing tests for path encoding**

`tests/path-encoding.test.ts`:
```typescript
import { describe, test, expect } from "bun:test";
import { encodeLabel, decodeLabel, pathToLtree, ltreeToPath } from "../src/path-encoding";

describe("encodeLabel", () => {
  test("passes through alphanumeric", () => {
    expect(encodeLabel("hello")).toBe("hello");
  });

  test("passes through hyphens and underscores", () => {
    expect(encodeLabel("my-file_name")).toBe("my-file_name");
  });

  test("encodes dots", () => {
    expect(encodeLabel("readme.md")).toBe("readme__dot__md");
  });

  test("encodes spaces", () => {
    expect(encodeLabel("my file")).toBe("my__sp__file");
  });

  test("encodes multiple special chars", () => {
    expect(encodeLabel("my file.txt")).toBe("my__sp__file__dot__txt");
  });

  test("encodes other special characters as hex", () => {
    expect(encodeLabel("file@name")).toBe("file__40__name");
  });

  test("encodes hash", () => {
    expect(encodeLabel("file#1")).toBe("file__23__1");
  });
});

describe("decodeLabel", () => {
  test("passes through alphanumeric", () => {
    expect(decodeLabel("hello")).toBe("hello");
  });

  test("decodes dots", () => {
    expect(decodeLabel("readme__dot__md")).toBe("readme.md");
  });

  test("decodes spaces", () => {
    expect(decodeLabel("my__sp__file")).toBe("my file");
  });

  test("decodes hex", () => {
    expect(decodeLabel("file__40__name")).toBe("file@name");
  });

  test("roundtrips complex names", () => {
    const names = ["hello.world.txt", "my file (1).md", "résumé.pdf", "a+b=c.js"];
    for (const name of names) {
      expect(decodeLabel(encodeLabel(name))).toBe(name);
    }
  });
});

describe("pathToLtree", () => {
  test("converts root path", () => {
    expect(pathToLtree("/", 42)).toBe("u42");
  });

  test("converts simple path", () => {
    expect(pathToLtree("/home", 42)).toBe("u42.home");
  });

  test("converts nested path", () => {
    expect(pathToLtree("/home/docs/readme.md", 42)).toBe("u42.home.docs.readme__dot__md");
  });

  test("handles trailing slash", () => {
    expect(pathToLtree("/home/docs/", 42)).toBe("u42.home.docs");
  });

  test("normalizes double slashes", () => {
    expect(pathToLtree("/home//docs", 42)).toBe("u42.home.docs");
  });
});

describe("ltreeToPath", () => {
  test("converts root", () => {
    expect(ltreeToPath("u42")).toBe("/");
  });

  test("converts simple path", () => {
    expect(ltreeToPath("u42.home")).toBe("/home");
  });

  test("converts nested path with encoded chars", () => {
    expect(ltreeToPath("u42.home.docs.readme__dot__md")).toBe("/home/docs/readme.md");
  });

  test("roundtrips paths", () => {
    const paths = ["/", "/home", "/home/docs/readme.md", "/tmp/my file.txt"];
    for (const p of paths) {
      expect(ltreeToPath(pathToLtree(p, 7))).toBe(p);
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/path-encoding.test.ts`
Expected: FAIL — module `../src/path-encoding` has no exports

**Step 3: Implement path encoding**

`src/path-encoding.ts`:
```typescript
const SPECIAL_ENCODINGS: Record<string, string> = {
  ".": "__dot__",
  " ": "__sp__",
};

const DECODE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(SPECIAL_ENCODINGS).map(([k, v]) => [v, k])
);

export function encodeLabel(name: string): string {
  let result = "";
  for (const char of name) {
    if (SPECIAL_ENCODINGS[char]) {
      result += SPECIAL_ENCODINGS[char];
    } else if (/[A-Za-z0-9_-]/.test(char)) {
      result += char;
    } else {
      const hex = char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
      result += `__${hex}__`;
    }
  }
  return result;
}

export function decodeLabel(label: string): string {
  return label.replace(/__([A-Za-z0-9]+)__/g, (match, code) => {
    if (DECODE_MAP[match]) return DECODE_MAP[match];
    // Hex-encoded character
    const charCode = parseInt(code, 16);
    if (!isNaN(charCode) && charCode > 0) return String.fromCharCode(charCode);
    return match; // shouldn't happen, return as-is
  });
}

export function pathToLtree(posixPath: string, userId: number): string {
  const segments = posixPath.split("/").filter(Boolean);
  const prefix = `u${userId}`;
  if (segments.length === 0) return prefix;
  return prefix + "." + segments.map(encodeLabel).join(".");
}

export function ltreeToPath(ltree: string): string {
  const parts = ltree.split(".");
  // First part is the user prefix (u42), skip it
  const segments = parts.slice(1);
  if (segments.length === 0) return "/";
  return "/" + segments.map(decodeLabel).join("/");
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/path-encoding.test.ts`
Expected: all tests PASS

**Step 5: Commit**

```bash
git add src/path-encoding.ts tests/path-encoding.test.ts
git commit -m "feat: path encoding for POSIX <-> ltree conversion"
```

---

### Task 3: SQL Schema

**Files:**
- Create: `sql/001-setup.sql`
- Create: `src/schema.ts`
- Create: `tests/helpers.ts`
- Create: `tests/schema.test.ts`

**Step 1: Write the SQL migration**

`sql/001-setup.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS ltree;

CREATE TABLE IF NOT EXISTS fs_nodes (
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

CREATE INDEX IF NOT EXISTS idx_fs_path_gist ON fs_nodes USING GIST (path gist_ltree_ops(siglen=124));
CREATE INDEX IF NOT EXISTS idx_fs_parent ON fs_nodes (parent_id);
CREATE INDEX IF NOT EXISTS idx_fs_owner ON fs_nodes (owner_id);
CREATE INDEX IF NOT EXISTS idx_fs_owner_parent ON fs_nodes (owner_id, parent_id);
CREATE INDEX IF NOT EXISTS idx_fs_search ON fs_nodes USING GIN (search_vector);

-- RLS: per-user isolation
ALTER TABLE fs_nodes ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'fs_nodes' AND policyname = 'user_isolation'
    ) THEN
        CREATE POLICY user_isolation ON fs_nodes FOR ALL
            USING (owner_id = current_setting('app.user_id', true)::bigint)
            WITH CHECK (owner_id = current_setting('app.user_id', true)::bigint);
    END IF;
END $$;
```

**Step 2: Create test helpers**

`tests/helpers.ts`:
```typescript
import postgres from "postgres";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/just_bash_postgres_test";

export function createTestSql() {
  return postgres(TEST_DB_URL);
}

export async function resetDb(sql: postgres.Sql) {
  await sql`DROP TABLE IF EXISTS fs_nodes CASCADE`;
}
```

**Step 3: Write failing test for schema setup**

`tests/schema.test.ts`:
```typescript
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createTestSql, resetDb } from "./helpers";
import { setupSchema } from "../src/schema";
import type postgres from "postgres";

describe("setupSchema", () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    sql = createTestSql();
  });

  afterAll(async () => {
    await resetDb(sql);
    await sql.end();
  });

  beforeEach(async () => {
    await resetDb(sql);
  });

  test("creates fs_nodes table", async () => {
    await setupSchema(sql);
    const result = await sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'fs_nodes'
      ORDER BY ordinal_position
    `;
    const columns = result.map((r: { column_name: string }) => r.column_name);
    expect(columns).toContain("id");
    expect(columns).toContain("owner_id");
    expect(columns).toContain("parent_id");
    expect(columns).toContain("name");
    expect(columns).toContain("node_type");
    expect(columns).toContain("path");
    expect(columns).toContain("content");
    expect(columns).toContain("binary_data");
    expect(columns).toContain("search_vector");
  });

  test("creates ltree extension", async () => {
    await setupSchema(sql);
    const result = await sql`SELECT 'home.docs'::ltree @> 'home.docs.readme'::ltree AS is_ancestor`;
    expect(result[0].is_ancestor).toBe(true);
  });

  test("enables RLS on fs_nodes", async () => {
    await setupSchema(sql);
    const result = await sql`
      SELECT rowsecurity FROM pg_tables WHERE tablename = 'fs_nodes'
    `;
    expect(result[0].rowsecurity).toBe(true);
  });

  test("is idempotent", async () => {
    await setupSchema(sql);
    await setupSchema(sql); // should not throw
  });
});
```

**Step 4: Run tests to verify they fail**

Run: `bun test tests/schema.test.ts`
Expected: FAIL — `setupSchema` not found

**Step 5: Implement schema setup**

`src/schema.ts`:
```typescript
import type postgres from "postgres";
import { readFileSync } from "fs";
import { join } from "path";

export async function setupSchema(sql: postgres.Sql): Promise<void> {
  const migrationPath = join(import.meta.dir, "..", "sql", "001-setup.sql");
  const migration = readFileSync(migrationPath, "utf-8");
  await sql.unsafe(migration);
}

export async function setupVectorColumn(sql: postgres.Sql, dimensions: number): Promise<void> {
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);

  const hasColumn = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'fs_nodes' AND column_name = 'embedding'
  `;
  if (hasColumn.length === 0) {
    await sql.unsafe(`ALTER TABLE fs_nodes ADD COLUMN embedding vector(${dimensions})`);
    await sql.unsafe(`
      CREATE INDEX IF NOT EXISTS idx_fs_embedding ON fs_nodes
      USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)
    `);
  }
}
```

**Step 6: Run tests to verify they pass**

Run: `bun test tests/schema.test.ts`
Expected: all tests PASS

**Step 7: Commit**

```bash
git add sql/001-setup.sql src/schema.ts tests/helpers.ts tests/schema.test.ts
git commit -m "feat: SQL schema with ltree, FTS, and RLS"
```

---

### Task 4: PgFileSystem — Constructor + Core Read/Write

**Files:**
- Create: `src/pg-filesystem.ts`
- Create: `tests/pg-filesystem.test.ts`
- Modify: `src/index.ts`

This task implements the constructor, `setup()`, `writeFile`, `readFile`, `readFileBuffer`, `appendFile`, `exists`, and `stat`.

**Step 1: Write failing tests**

`tests/pg-filesystem.test.ts`:
```typescript
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createTestSql, resetDb } from "./helpers";
import { PgFileSystem } from "../src/pg-filesystem";
import type postgres from "postgres";

describe("PgFileSystem", () => {
  let sql: postgres.Sql;
  let fs: PgFileSystem;

  beforeAll(() => {
    sql = createTestSql();
  });

  afterAll(async () => {
    await resetDb(sql);
    await sql.end();
  });

  beforeEach(async () => {
    await resetDb(sql);
    fs = new PgFileSystem({ sql, userId: 1 });
    await fs.setup();
  });

  describe("writeFile + readFile", () => {
    test("writes and reads text file", async () => {
      await fs.writeFile("/hello.txt", "world");
      const content = await fs.readFile("/hello.txt");
      expect(content).toBe("world");
    });

    test("writes and reads nested file", async () => {
      await fs.mkdir("/docs", { recursive: true });
      await fs.writeFile("/docs/readme.md", "# Hello");
      const content = await fs.readFile("/docs/readme.md");
      expect(content).toBe("# Hello");
    });

    test("overwrites existing file", async () => {
      await fs.writeFile("/test.txt", "first");
      await fs.writeFile("/test.txt", "second");
      expect(await fs.readFile("/test.txt")).toBe("second");
    });

    test("throws ENOENT for non-existent file", async () => {
      expect(fs.readFile("/nope.txt")).rejects.toThrow("ENOENT");
    });
  });

  describe("readFileBuffer", () => {
    test("reads text as buffer", async () => {
      await fs.writeFile("/hello.txt", "world");
      const buf = await fs.readFileBuffer("/hello.txt");
      expect(buf).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(buf)).toBe("world");
    });

    test("reads binary data", async () => {
      const data = new Uint8Array([0x00, 0x01, 0xff, 0xfe]);
      await fs.writeFile("/bin.dat", data);
      const buf = await fs.readFileBuffer("/bin.dat");
      expect(buf).toEqual(data);
    });
  });

  describe("appendFile", () => {
    test("appends to existing file", async () => {
      await fs.writeFile("/log.txt", "line1\n");
      await fs.appendFile("/log.txt", "line2\n");
      expect(await fs.readFile("/log.txt")).toBe("line1\nline2\n");
    });

    test("creates file if not exists", async () => {
      await fs.appendFile("/new.txt", "content");
      expect(await fs.readFile("/new.txt")).toBe("content");
    });
  });

  describe("exists", () => {
    test("returns false for non-existent path", async () => {
      expect(await fs.exists("/nope")).toBe(false);
    });

    test("returns true for existing file", async () => {
      await fs.writeFile("/test.txt", "hi");
      expect(await fs.exists("/test.txt")).toBe(true);
    });

    test("returns true for directory", async () => {
      await fs.mkdir("/mydir");
      expect(await fs.exists("/mydir")).toBe(true);
    });
  });

  describe("stat", () => {
    test("returns file stat", async () => {
      await fs.writeFile("/test.txt", "hello");
      const s = await fs.stat("/test.txt");
      expect(s.isFile).toBe(true);
      expect(s.isDirectory).toBe(false);
      expect(s.isSymbolicLink).toBe(false);
      expect(s.size).toBe(5);
      expect(s.mtime).toBeInstanceOf(Date);
    });

    test("returns directory stat", async () => {
      await fs.mkdir("/mydir");
      const s = await fs.stat("/mydir");
      expect(s.isFile).toBe(false);
      expect(s.isDirectory).toBe(true);
    });

    test("throws ENOENT for non-existent", async () => {
      expect(fs.stat("/nope")).rejects.toThrow("ENOENT");
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/pg-filesystem.test.ts`
Expected: FAIL — `PgFileSystem` not found

**Step 3: Implement PgFileSystem constructor + core read/write**

`src/pg-filesystem.ts`:
```typescript
import type postgres from "postgres";
import type { IFileSystem, FsStat, ReadFileOptions, WriteFileOptions, MkdirOptions, RmOptions, CpOptions, DirentEntry } from "just-bash";
import { pathToLtree, ltreeToPath, encodeLabel, decodeLabel } from "./path-encoding";
import { setupSchema, setupVectorColumn } from "./schema";

type BufferEncoding = "utf8" | "utf-8" | "ascii" | "binary" | "base64" | "hex" | "latin1";
type FileContent = string | Uint8Array;

export interface PgFileSystemOptions {
  sql: postgres.Sql;
  userId: number;
  embed?: (text: string) => Promise<number[]>;
  embeddingDimensions?: number;
}

interface FsRow {
  id: number;
  owner_id: number;
  parent_id: number | null;
  name: string;
  node_type: string;
  path: string;
  content: string | null;
  binary_data: Uint8Array | null;
  symlink_target: string | null;
  mode: number;
  size_bytes: number;
  mtime: Date;
  created_at: Date;
}

export class PgFileSystem implements IFileSystem {
  private sql: postgres.Sql;
  private userId: number;
  private embed?: (text: string) => Promise<number[]>;
  private embeddingDimensions?: number;

  constructor(options: PgFileSystemOptions) {
    this.sql = options.sql;
    this.userId = options.userId;
    this.embed = options.embed;
    this.embeddingDimensions = options.embeddingDimensions;
  }

  async setup(): Promise<void> {
    await setupSchema(this.sql);
    if (this.embeddingDimensions) {
      await setupVectorColumn(this.sql, this.embeddingDimensions);
    }
    // Ensure root directory exists for this user
    const rootLtree = pathToLtree("/", this.userId);
    await this.sql`
      INSERT INTO fs_nodes (owner_id, name, node_type, path, mode)
      VALUES (${this.userId}, '/', 'directory', ${rootLtree}::ltree, 755)
      ON CONFLICT (owner_id, path) DO NOTHING
    `;
  }

  private ltree(posixPath: string): string {
    return pathToLtree(posixPath, this.userId);
  }

  private async getNode(posixPath: string): Promise<FsRow | null> {
    const lt = this.ltree(posixPath);
    const rows = await this.sql<FsRow[]>`
      SELECT * FROM fs_nodes
      WHERE owner_id = ${this.userId} AND path = ${lt}::ltree
      LIMIT 1
    `;
    return rows.length > 0 ? rows[0] : null;
  }

  private parentPath(posixPath: string): string {
    const parts = posixPath.split("/").filter(Boolean);
    if (parts.length <= 1) return "/";
    return "/" + parts.slice(0, -1).join("/");
  }

  private fileName(posixPath: string): string {
    const parts = posixPath.split("/").filter(Boolean);
    return parts[parts.length - 1] || "/";
  }

  // ── File I/O ──────────────────────────────────────────────────────

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    if (node.node_type === "directory") throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);

    if (node.node_type === "symlink") {
      return this.readFile(node.symlink_target!, options);
    }

    if (node.content !== null) return node.content;
    if (node.binary_data !== null) return new TextDecoder().decode(node.binary_data);
    return "";
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    if (node.node_type === "directory") throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);

    if (node.node_type === "symlink") {
      return this.readFileBuffer(node.symlink_target!);
    }

    if (node.binary_data !== null) return node.binary_data;
    if (node.content !== null) return new TextEncoder().encode(node.content);
    return new Uint8Array(0);
  }

  async writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const name = this.fileName(path);
    const parentPosix = this.parentPath(path);
    const parent = await this.getNode(parentPosix);
    if (!parent) throw new Error(`ENOENT: no such file or directory, open '${path}'`);

    const lt = this.ltree(path);
    const isText = typeof content === "string";
    const textContent = isText ? content : null;
    const binaryData = isText ? null : content;
    const sizeBytes = isText ? Buffer.byteLength(content) : content.byteLength;

    let embedding: number[] | null = null;
    if (isText && this.embed && content.length > 0) {
      embedding = await this.embed(content);
    }

    if (embedding) {
      const embeddingStr = `[${embedding.join(",")}]`;
      await this.sql`
        INSERT INTO fs_nodes (owner_id, parent_id, name, node_type, path, content, binary_data, size_bytes, mtime, embedding)
        VALUES (${this.userId}, ${parent.id}, ${name}, 'file', ${lt}::ltree, ${textContent}, ${binaryData}, ${sizeBytes}, now(), ${embeddingStr}::vector)
        ON CONFLICT (owner_id, path) DO UPDATE SET
          content = EXCLUDED.content,
          binary_data = EXCLUDED.binary_data,
          size_bytes = EXCLUDED.size_bytes,
          mtime = now(),
          embedding = EXCLUDED.embedding
      `;
    } else {
      await this.sql`
        INSERT INTO fs_nodes (owner_id, parent_id, name, node_type, path, content, binary_data, size_bytes, mtime)
        VALUES (${this.userId}, ${parent.id}, ${name}, 'file', ${lt}::ltree, ${textContent}, ${binaryData}, ${sizeBytes}, now())
        ON CONFLICT (owner_id, path) DO UPDATE SET
          content = EXCLUDED.content,
          binary_data = EXCLUDED.binary_data,
          size_bytes = EXCLUDED.size_bytes,
          mtime = now()
      `;
    }
  }

  async appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const existing = await this.getNode(path);
    if (!existing) {
      await this.writeFile(path, content, options);
      return;
    }

    const textContent = typeof content === "string" ? content : new TextDecoder().decode(content);
    const currentContent = existing.content ?? "";
    const newContent = currentContent + textContent;
    const sizeBytes = Buffer.byteLength(newContent);

    const lt = this.ltree(path);
    await this.sql`
      UPDATE fs_nodes
      SET content = ${newContent}, size_bytes = ${sizeBytes}, mtime = now()
      WHERE owner_id = ${this.userId} AND path = ${lt}::ltree
    `;
  }

  // ── Path queries ──────────────────────────────────────────────────

  async exists(path: string): Promise<boolean> {
    const node = await this.getNode(path);
    return node !== null;
  }

  async stat(path: string): Promise<FsStat> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);

    return {
      isFile: node.node_type === "file",
      isDirectory: node.node_type === "directory",
      isSymbolicLink: node.node_type === "symlink",
      mode: node.mode,
      size: Number(node.size_bytes),
      mtime: new Date(node.mtime),
    };
  }

  async lstat(path: string): Promise<FsStat> {
    // lstat doesn't follow symlinks — same as stat for our implementation
    // since stat on a symlink node already returns isSymbolicLink: true
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);

    return {
      isFile: node.node_type === "file",
      isDirectory: node.node_type === "directory",
      isSymbolicLink: node.node_type === "symlink",
      mode: node.mode,
      size: Number(node.size_bytes),
      mtime: new Date(node.mtime),
    };
  }

  async realpath(path: string): Promise<string> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    if (node.node_type === "symlink" && node.symlink_target) {
      return this.realpath(node.symlink_target);
    }
    return path;
  }

  // ── Directory operations ──────────────────────────────────────────

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const recursive = options?.recursive ?? false;

    if (recursive) {
      const segments = path.split("/").filter(Boolean);
      let current = "/";
      for (const segment of segments) {
        const parentPosix = current;
        current = current === "/" ? `/${segment}` : `${current}/${segment}`;
        const existing = await this.getNode(current);
        if (existing) {
          if (existing.node_type !== "directory") {
            throw new Error(`ENOTDIR: not a directory, mkdir '${current}'`);
          }
          continue;
        }
        const parent = await this.getNode(parentPosix);
        if (!parent) throw new Error(`ENOENT: no such file or directory, mkdir '${current}'`);
        const lt = this.ltree(current);
        await this.sql`
          INSERT INTO fs_nodes (owner_id, parent_id, name, node_type, path, mode)
          VALUES (${this.userId}, ${parent.id}, ${segment}, 'directory', ${lt}::ltree, 755)
          ON CONFLICT (owner_id, path) DO NOTHING
        `;
      }
    } else {
      const existing = await this.getNode(path);
      if (existing) throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
      const parentPosix = this.parentPath(path);
      const parent = await this.getNode(parentPosix);
      if (!parent) throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      const name = this.fileName(path);
      const lt = this.ltree(path);
      await this.sql`
        INSERT INTO fs_nodes (owner_id, parent_id, name, node_type, path, mode)
        VALUES (${this.userId}, ${parent.id}, ${name}, 'directory', ${lt}::ltree, 755)
      `;
    }
  }

  async readdir(path: string): Promise<string[]> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    if (node.node_type !== "directory") throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);

    const lt = this.ltree(path);
    const depth = lt.split(".").length + 1;
    const rows = await this.sql<{ name: string }[]>`
      SELECT name FROM fs_nodes
      WHERE owner_id = ${this.userId}
        AND path <@ ${lt}::ltree
        AND nlevel(path) = ${depth}
      ORDER BY name
    `;
    return rows.map(r => r.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    if (node.node_type !== "directory") throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);

    const lt = this.ltree(path);
    const depth = lt.split(".").length + 1;
    const rows = await this.sql<{ name: string; node_type: string }[]>`
      SELECT name, node_type FROM fs_nodes
      WHERE owner_id = ${this.userId}
        AND path <@ ${lt}::ltree
        AND nlevel(path) = ${depth}
      ORDER BY name
    `;
    return rows.map(r => ({
      name: r.name,
      isFile: r.node_type === "file",
      isDirectory: r.node_type === "directory",
      isSymbolicLink: r.node_type === "symlink",
    }));
  }

  // ── Mutation ──────────────────────────────────────────────────────

  async rm(path: string, options?: RmOptions): Promise<void> {
    const node = await this.getNode(path);
    if (!node) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }

    if (node.node_type === "directory") {
      if (!options?.recursive) {
        // Check if directory has children
        const lt = this.ltree(path);
        const children = await this.sql`
          SELECT 1 FROM fs_nodes
          WHERE owner_id = ${this.userId} AND parent_id = ${node.id}
          LIMIT 1
        `;
        if (children.length > 0) {
          throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
        }
      }
    }

    // Delete node and all descendants (CASCADE handles children via parent_id,
    // but we also need to handle ltree descendants for recursive)
    if (options?.recursive && node.node_type === "directory") {
      const lt = this.ltree(path);
      await this.sql`
        DELETE FROM fs_nodes
        WHERE owner_id = ${this.userId} AND path <@ ${lt}::ltree
      `;
    } else {
      await this.sql`
        DELETE FROM fs_nodes
        WHERE owner_id = ${this.userId} AND id = ${node.id}
      `;
    }
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcNode = await this.getNode(src);
    if (!srcNode) throw new Error(`ENOENT: no such file or directory, cp '${src}'`);

    if (srcNode.node_type === "directory") {
      if (!options?.recursive) {
        throw new Error(`EISDIR: illegal operation on a directory, cp '${src}'`);
      }
      // Recursive copy
      await this.mkdir(dest, { recursive: true });
      const children = await this.readdir(src);
      for (const child of children) {
        const srcChild = src === "/" ? `/${child}` : `${src}/${child}`;
        const destChild = dest === "/" ? `/${child}` : `${dest}/${child}`;
        await this.cp(srcChild, destChild, options);
      }
      return;
    }

    // Copy file
    const content = srcNode.content !== null ? srcNode.content : await this.readFileBuffer(src);
    await this.writeFile(dest, content);
  }

  async mv(src: string, dest: string): Promise<void> {
    const srcNode = await this.getNode(src);
    if (!srcNode) throw new Error(`ENOENT: no such file or directory, mv '${src}'`);

    const destParentPosix = this.parentPath(dest);
    const destParent = await this.getNode(destParentPosix);
    if (!destParent) throw new Error(`ENOENT: no such file or directory, mv '${dest}'`);

    const newName = this.fileName(dest);
    const newLtree = this.ltree(dest);
    const oldLtree = this.ltree(src);

    if (srcNode.node_type === "directory") {
      // Update all descendants' paths
      const oldPrefix = oldLtree;
      const newPrefix = newLtree;
      // Update descendants first (those whose path starts with old path)
      await this.sql`
        UPDATE fs_nodes
        SET path = (${newPrefix}::ltree || subpath(path, nlevel(${oldPrefix}::ltree)))
        WHERE owner_id = ${this.userId}
          AND path <@ ${oldPrefix}::ltree
          AND path != ${oldPrefix}::ltree
      `;
    }

    // Update the node itself
    await this.sql`
      UPDATE fs_nodes
      SET name = ${newName}, path = ${newLtree}::ltree, parent_id = ${destParent.id}, mtime = now()
      WHERE owner_id = ${this.userId} AND id = ${srcNode.id}
    `;
  }

  async chmod(path: string, mode: number): Promise<void> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);

    await this.sql`
      UPDATE fs_nodes SET mode = ${mode}
      WHERE owner_id = ${this.userId} AND id = ${node.id}
    `;
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);

    await this.sql`
      UPDATE fs_nodes SET mtime = ${mtime}
      WHERE owner_id = ${this.userId} AND id = ${node.id}
    `;
  }

  // ── Links ─────────────────────────────────────────────────────────

  async symlink(target: string, linkPath: string): Promise<void> {
    const parentPosix = this.parentPath(linkPath);
    const parent = await this.getNode(parentPosix);
    if (!parent) throw new Error(`ENOENT: no such file or directory, symlink '${linkPath}'`);

    const name = this.fileName(linkPath);
    const lt = this.ltree(linkPath);

    await this.sql`
      INSERT INTO fs_nodes (owner_id, parent_id, name, node_type, path, symlink_target, mode)
      VALUES (${this.userId}, ${parent.id}, ${name}, 'symlink', ${lt}::ltree, ${target}, 777)
    `;
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    // Hard links: copy the content (PostgreSQL doesn't have real hard links)
    const srcNode = await this.getNode(existingPath);
    if (!srcNode) throw new Error(`ENOENT: no such file or directory, link '${existingPath}'`);
    if (srcNode.node_type === "directory") throw new Error(`EPERM: operation not permitted, link '${existingPath}'`);

    const content = srcNode.content !== null ? srcNode.content : await this.readFileBuffer(existingPath);
    await this.writeFile(newPath, content);
  }

  async readlink(path: string): Promise<string> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    if (node.node_type !== "symlink") throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    return node.symlink_target!;
  }

  // ── Utility ───────────────────────────────────────────────────────

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    if (base === "/") return normalizePath("/" + path);
    return normalizePath(base + "/" + path);
  }

  getAllPaths(): string[] {
    // Synchronous — cannot query DB. Return empty as AgentFS does.
    return [];
  }
}

function normalizePath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") { resolved.pop(); continue; }
    resolved.push(part);
  }
  return "/" + resolved.join("/");
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test tests/pg-filesystem.test.ts`
Expected: all tests PASS

**Step 5: Update src/index.ts**

`src/index.ts`:
```typescript
export { PgFileSystem } from "./pg-filesystem";
export type { PgFileSystemOptions } from "./pg-filesystem";
export { setupSchema, setupVectorColumn } from "./schema";
export { pathToLtree, ltreeToPath, encodeLabel, decodeLabel } from "./path-encoding";
```

**Step 6: Commit**

```bash
git add src/pg-filesystem.ts src/index.ts tests/pg-filesystem.test.ts
git commit -m "feat: PgFileSystem core — constructor, read, write, stat, mkdir, rm, cp, mv, symlinks"
```

---

### Task 5: PgFileSystem — Directory + Mutation Tests

**Files:**
- Modify: `tests/pg-filesystem.test.ts`

This task adds tests for the remaining IFileSystem methods: `mkdir`, `readdir`, `readdirWithFileTypes`, `rm`, `cp`, `mv`, `chmod`, `utimes`, `symlink`, `link`, `readlink`, `realpath`, `lstat`, `resolvePath`.

**Step 1: Add failing tests for directory operations**

Append to `tests/pg-filesystem.test.ts` inside the main `describe`:

```typescript
  describe("mkdir", () => {
    test("creates a directory", async () => {
      await fs.mkdir("/newdir");
      const s = await fs.stat("/newdir");
      expect(s.isDirectory).toBe(true);
    });

    test("recursive creates nested dirs", async () => {
      await fs.mkdir("/a/b/c", { recursive: true });
      expect(await fs.exists("/a")).toBe(true);
      expect(await fs.exists("/a/b")).toBe(true);
      expect(await fs.exists("/a/b/c")).toBe(true);
    });

    test("throws EEXIST for existing dir without recursive", async () => {
      await fs.mkdir("/mydir");
      expect(fs.mkdir("/mydir")).rejects.toThrow("EEXIST");
    });

    test("recursive is idempotent", async () => {
      await fs.mkdir("/mydir", { recursive: true });
      await fs.mkdir("/mydir", { recursive: true }); // no throw
    });
  });

  describe("readdir", () => {
    test("lists immediate children", async () => {
      await fs.mkdir("/parent");
      await fs.writeFile("/parent/a.txt", "a");
      await fs.writeFile("/parent/b.txt", "b");
      await fs.mkdir("/parent/sub");
      const entries = await fs.readdir("/parent");
      expect(entries.sort()).toEqual(["a.txt", "b.txt", "sub"]);
    });

    test("does not list grandchildren", async () => {
      await fs.mkdir("/parent/sub", { recursive: true });
      await fs.writeFile("/parent/sub/deep.txt", "deep");
      await fs.writeFile("/parent/top.txt", "top");
      const entries = await fs.readdir("/parent");
      expect(entries.sort()).toEqual(["sub", "top.txt"]);
    });

    test("throws ENOENT for non-existent dir", async () => {
      expect(fs.readdir("/nope")).rejects.toThrow("ENOENT");
    });
  });

  describe("readdirWithFileTypes", () => {
    test("returns typed entries", async () => {
      await fs.mkdir("/parent");
      await fs.writeFile("/parent/file.txt", "hi");
      await fs.mkdir("/parent/dir");
      const entries = await fs.readdirWithFileTypes!("/parent");
      const file = entries.find(e => e.name === "file.txt")!;
      const dir = entries.find(e => e.name === "dir")!;
      expect(file.isFile).toBe(true);
      expect(dir.isDirectory).toBe(true);
    });
  });

  describe("rm", () => {
    test("removes a file", async () => {
      await fs.writeFile("/doomed.txt", "bye");
      await fs.rm("/doomed.txt");
      expect(await fs.exists("/doomed.txt")).toBe(false);
    });

    test("removes empty directory", async () => {
      await fs.mkdir("/empty");
      await fs.rm("/empty");
      expect(await fs.exists("/empty")).toBe(false);
    });

    test("throws ENOTEMPTY for non-empty dir without recursive", async () => {
      await fs.mkdir("/full");
      await fs.writeFile("/full/file.txt", "hi");
      expect(fs.rm("/full")).rejects.toThrow("ENOTEMPTY");
    });

    test("recursive removes dir and contents", async () => {
      await fs.mkdir("/tree/sub", { recursive: true });
      await fs.writeFile("/tree/sub/file.txt", "data");
      await fs.rm("/tree", { recursive: true });
      expect(await fs.exists("/tree")).toBe(false);
      expect(await fs.exists("/tree/sub")).toBe(false);
    });

    test("force ignores non-existent", async () => {
      await fs.rm("/nope", { force: true }); // no throw
    });
  });

  describe("cp", () => {
    test("copies a file", async () => {
      await fs.writeFile("/src.txt", "data");
      await fs.cp("/src.txt", "/dst.txt");
      expect(await fs.readFile("/dst.txt")).toBe("data");
    });

    test("recursive copies directory", async () => {
      await fs.mkdir("/srcdir");
      await fs.writeFile("/srcdir/a.txt", "a");
      await fs.cp("/srcdir", "/dstdir", { recursive: true });
      expect(await fs.readFile("/dstdir/a.txt")).toBe("a");
    });
  });

  describe("mv", () => {
    test("renames a file", async () => {
      await fs.writeFile("/old.txt", "data");
      await fs.mv("/old.txt", "/new.txt");
      expect(await fs.exists("/old.txt")).toBe(false);
      expect(await fs.readFile("/new.txt")).toBe("data");
    });

    test("moves file to different directory", async () => {
      await fs.mkdir("/target");
      await fs.writeFile("/src.txt", "data");
      await fs.mv("/src.txt", "/target/moved.txt");
      expect(await fs.readFile("/target/moved.txt")).toBe("data");
    });

    test("moves directory with descendants", async () => {
      await fs.mkdir("/srcdir/sub", { recursive: true });
      await fs.writeFile("/srcdir/sub/file.txt", "data");
      await fs.mkdir("/dest");
      await fs.mv("/srcdir", "/dest/moved");
      expect(await fs.readFile("/dest/moved/sub/file.txt")).toBe("data");
    });
  });

  describe("chmod", () => {
    test("changes file mode", async () => {
      await fs.writeFile("/test.txt", "hi");
      await fs.chmod("/test.txt", 755);
      const s = await fs.stat("/test.txt");
      expect(s.mode).toBe(755);
    });
  });

  describe("utimes", () => {
    test("updates mtime", async () => {
      await fs.writeFile("/test.txt", "hi");
      const date = new Date("2020-01-01T00:00:00Z");
      await fs.utimes("/test.txt", date, date);
      const s = await fs.stat("/test.txt");
      expect(s.mtime.getTime()).toBe(date.getTime());
    });
  });

  describe("symlink + readlink + lstat", () => {
    test("creates and reads symlink", async () => {
      await fs.writeFile("/target.txt", "real content");
      await fs.symlink("/target.txt", "/link.txt");
      expect(await fs.readlink("/link.txt")).toBe("/target.txt");
    });

    test("readFile follows symlink", async () => {
      await fs.writeFile("/target.txt", "real content");
      await fs.symlink("/target.txt", "/link.txt");
      expect(await fs.readFile("/link.txt")).toBe("real content");
    });

    test("lstat returns symlink info", async () => {
      await fs.writeFile("/target.txt", "real content");
      await fs.symlink("/target.txt", "/link.txt");
      const s = await fs.lstat("/link.txt");
      expect(s.isSymbolicLink).toBe(true);
    });
  });

  describe("link (hard link)", () => {
    test("creates a copy", async () => {
      await fs.writeFile("/orig.txt", "data");
      await fs.link("/orig.txt", "/hardlink.txt");
      expect(await fs.readFile("/hardlink.txt")).toBe("data");
    });
  });

  describe("realpath", () => {
    test("resolves non-symlink as-is", async () => {
      await fs.writeFile("/test.txt", "hi");
      expect(await fs.realpath("/test.txt")).toBe("/test.txt");
    });

    test("resolves through symlink", async () => {
      await fs.writeFile("/target.txt", "hi");
      await fs.symlink("/target.txt", "/link.txt");
      expect(await fs.realpath("/link.txt")).toBe("/target.txt");
    });
  });

  describe("resolvePath", () => {
    test("resolves absolute path", () => {
      expect(fs.resolvePath("/home", "/etc/file")).toBe("/etc/file");
    });

    test("resolves relative path", () => {
      expect(fs.resolvePath("/home/user", "docs/file.txt")).toBe("/home/user/docs/file.txt");
    });

    test("resolves .. segments", () => {
      expect(fs.resolvePath("/home/user", "../other/file")).toBe("/home/other/file");
    });

    test("resolves . segments", () => {
      expect(fs.resolvePath("/home", "./file")).toBe("/home/file");
    });
  });
```

**Step 2: Run tests to verify they pass**

Run: `bun test tests/pg-filesystem.test.ts`
Expected: all tests PASS (implementation was written in Task 4)

**Step 3: Fix any failures, refactor if needed**

Review test output. If any test fails, fix the implementation in `src/pg-filesystem.ts`. Common issues:
- Edge cases in path handling
- ltree depth calculation off by one
- Symlink resolution loops

**Step 4: Commit**

```bash
git add tests/pg-filesystem.test.ts
git commit -m "test: comprehensive IFileSystem method tests"
```

---

### Task 6: Full-Text Search

**Files:**
- Create: `src/search.ts`
- Create: `tests/search.test.ts`
- Modify: `src/pg-filesystem.ts` (add search methods)
- Modify: `src/index.ts` (export SearchResult)

**Step 1: Write failing tests**

`tests/search.test.ts`:
```typescript
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createTestSql, resetDb } from "./helpers";
import { PgFileSystem } from "../src/pg-filesystem";
import type postgres from "postgres";

describe("Full-text search", () => {
  let sql: postgres.Sql;
  let fs: PgFileSystem;

  beforeAll(() => {
    sql = createTestSql();
  });

  afterAll(async () => {
    await resetDb(sql);
    await sql.end();
  });

  beforeEach(async () => {
    await resetDb(sql);
    fs = new PgFileSystem({ sql, userId: 1 });
    await fs.setup();

    // Seed test files
    await fs.mkdir("/docs", { recursive: true });
    await fs.mkdir("/projects", { recursive: true });
    await fs.writeFile("/docs/meeting-notes.md", "Discussed quarterly revenue targets and marketing budget allocation for next year");
    await fs.writeFile("/docs/readme.md", "This project handles data processing pipelines for analytics");
    await fs.writeFile("/projects/plan.md", "Revenue forecasting model using machine learning techniques");
    await fs.writeFile("/binary.dat", new Uint8Array([1, 2, 3]));
  });

  test("finds files by content keyword", async () => {
    const results = await fs.search("revenue");
    expect(results.length).toBeGreaterThanOrEqual(2);
    const paths = results.map(r => r.path);
    expect(paths).toContain("/docs/meeting-notes.md");
    expect(paths).toContain("/projects/plan.md");
  });

  test("ranks filename matches higher", async () => {
    await fs.writeFile("/revenue-report.txt", "some generic content");
    const results = await fs.search("revenue");
    // File with "revenue" in name should rank higher due to weight A
    expect(results[0].path).toBe("/revenue-report.txt");
  });

  test("scopes search to subtree", async () => {
    const results = await fs.search("revenue", { path: "/docs" });
    const paths = results.map(r => r.path);
    expect(paths).toContain("/docs/meeting-notes.md");
    expect(paths).not.toContain("/projects/plan.md");
  });

  test("returns empty for no matches", async () => {
    const results = await fs.search("xyznonexistent");
    expect(results).toEqual([]);
  });

  test("supports websearch syntax", async () => {
    const results = await fs.search('"machine learning"');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].path).toBe("/projects/plan.md");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test tests/search.test.ts`
Expected: FAIL — `fs.search` is not a function

**Step 3: Implement search**

`src/search.ts`:
```typescript
import type postgres from "postgres";

export interface SearchResult {
  path: string;
  name: string;
  rank: number;
  snippet?: string;
}

export async function fullTextSearch(
  sql: postgres.Sql,
  userId: number,
  ltreePrefix: string,
  query: string,
  opts?: { path?: string; limit?: number }
): Promise<SearchResult[]> {
  const limit = opts?.limit ?? 20;
  const scopeLtree = opts?.path ? `${ltreePrefix}${opts.path === "/" ? "" : "." + opts.path.split("/").filter(Boolean).join(".")}` : ltreePrefix;

  // Import path-encoding to convert ltree back to posix
  const { ltreeToPath: toLtree } = await import("./path-encoding");

  const rows = await sql`
    SELECT
      path::text as path,
      name,
      ts_rank(search_vector, websearch_to_tsquery('english', ${query})) AS rank,
      ts_headline('english', coalesce(content, ''), websearch_to_tsquery('english', ${query}),
        'MaxWords=35, MinWords=15, MaxFragments=1') AS snippet
    FROM fs_nodes
    WHERE owner_id = ${userId}
      AND path <@ ${scopeLtree}::ltree
      AND node_type = 'file'
      AND search_vector @@ websearch_to_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT ${limit}
  `;

  return rows.map((r: any) => ({
    path: toLtree(r.path),
    name: r.name,
    rank: parseFloat(r.rank),
    snippet: r.snippet || undefined,
  }));
}

export async function semanticSearch(
  sql: postgres.Sql,
  userId: number,
  ltreePrefix: string,
  embedding: number[],
  opts?: { path?: string; limit?: number }
): Promise<SearchResult[]> {
  const limit = opts?.limit ?? 20;
  const scopeLtree = opts?.path ? `${ltreePrefix}${opts.path === "/" ? "" : "." + opts.path.split("/").filter(Boolean).join(".")}` : ltreePrefix;
  const embeddingStr = `[${embedding.join(",")}]`;

  const { ltreeToPath: toLtree } = await import("./path-encoding");

  const rows = await sql`
    SELECT
      path::text as path,
      name,
      1 - (embedding <=> ${embeddingStr}::vector) AS rank
    FROM fs_nodes
    WHERE owner_id = ${userId}
      AND path <@ ${scopeLtree}::ltree
      AND node_type = 'file'
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${embeddingStr}::vector
    LIMIT ${limit}
  `;

  return rows.map((r: any) => ({
    path: toLtree(r.path),
    name: r.name,
    rank: parseFloat(r.rank),
  }));
}

export async function hybridSearch(
  sql: postgres.Sql,
  userId: number,
  ltreePrefix: string,
  query: string,
  embedding: number[],
  opts?: { path?: string; textWeight?: number; vectorWeight?: number; limit?: number }
): Promise<SearchResult[]> {
  const limit = opts?.limit ?? 20;
  const textWeight = opts?.textWeight ?? 0.4;
  const vectorWeight = opts?.vectorWeight ?? 0.6;
  const scopeLtree = opts?.path ? `${ltreePrefix}${opts.path === "/" ? "" : "." + opts.path.split("/").filter(Boolean).join(".")}` : ltreePrefix;
  const embeddingStr = `[${embedding.join(",")}]`;

  const { ltreeToPath: toLtree } = await import("./path-encoding");

  const rows = await sql`
    SELECT
      path::text as path,
      name,
      (${textWeight} * ts_rank(search_vector, websearch_to_tsquery('english', ${query})) +
       ${vectorWeight} * (1 - (embedding <=> ${embeddingStr}::vector))) AS rank
    FROM fs_nodes
    WHERE owner_id = ${userId}
      AND path <@ ${scopeLtree}::ltree
      AND node_type = 'file'
      AND search_vector @@ websearch_to_tsquery('english', ${query})
      AND embedding IS NOT NULL
    ORDER BY rank DESC
    LIMIT ${limit}
  `;

  return rows.map((r: any) => ({
    path: toLtree(r.path),
    name: r.name,
    rank: parseFloat(r.rank),
  }));
}
```

**Step 4: Add search methods to PgFileSystem**

Add these methods to the `PgFileSystem` class in `src/pg-filesystem.ts`:

```typescript
  // Add these imports at top of pg-filesystem.ts:
  import { fullTextSearch, semanticSearch as doSemanticSearch, hybridSearch as doHybridSearch } from "./search";
  import type { SearchResult } from "./search";

  // Add these methods to the class:

  async search(query: string, opts?: { path?: string; limit?: number }): Promise<SearchResult[]> {
    const ltreePrefix = pathToLtree("/", this.userId);
    return fullTextSearch(this.sql, this.userId, ltreePrefix, query, opts);
  }

  async semanticSearch(query: string, opts?: { path?: string; limit?: number }): Promise<SearchResult[]> {
    if (!this.embed) throw new Error("No embedding provider configured");
    const embedding = await this.embed(query);
    const ltreePrefix = pathToLtree("/", this.userId);
    return doSemanticSearch(this.sql, this.userId, ltreePrefix, embedding, opts);
  }

  async hybridSearch(query: string, opts?: {
    path?: string;
    textWeight?: number;
    vectorWeight?: number;
    limit?: number;
  }): Promise<SearchResult[]> {
    if (!this.embed) throw new Error("No embedding provider configured");
    const embedding = await this.embed(query);
    const ltreePrefix = pathToLtree("/", this.userId);
    return doHybridSearch(this.sql, this.userId, ltreePrefix, query, embedding, opts);
  }
```

**Step 5: Export SearchResult from index.ts**

Add to `src/index.ts`:
```typescript
export type { SearchResult } from "./search";
```

**Step 6: Run tests to verify they pass**

Run: `bun test tests/search.test.ts`
Expected: all tests PASS

**Step 7: Commit**

```bash
git add src/search.ts src/pg-filesystem.ts src/index.ts tests/search.test.ts
git commit -m "feat: full-text search with websearch syntax and subtree scoping"
```

---

### Task 7: RLS Isolation Tests

**Files:**
- Create: `tests/rls.test.ts`

**Step 1: Write failing tests for user isolation**

`tests/rls.test.ts`:
```typescript
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createTestSql, resetDb } from "./helpers";
import { PgFileSystem } from "../src/pg-filesystem";
import type postgres from "postgres";

describe("RLS User Isolation", () => {
  let sql: postgres.Sql;
  let fsUser1: PgFileSystem;
  let fsUser2: PgFileSystem;

  beforeAll(() => {
    sql = createTestSql();
  });

  afterAll(async () => {
    await resetDb(sql);
    await sql.end();
  });

  beforeEach(async () => {
    await resetDb(sql);
    fsUser1 = new PgFileSystem({ sql, userId: 1 });
    fsUser2 = new PgFileSystem({ sql, userId: 2 });
    await fsUser1.setup();
    await fsUser2.setup();
  });

  test("user cannot see other user's files", async () => {
    await fsUser1.writeFile("/secret.txt", "user1 secret");
    await fsUser2.writeFile("/secret.txt", "user2 secret");

    expect(await fsUser1.readFile("/secret.txt")).toBe("user1 secret");
    expect(await fsUser2.readFile("/secret.txt")).toBe("user2 secret");
  });

  test("user cannot list other user's directories", async () => {
    await fsUser1.mkdir("/private");
    await fsUser1.writeFile("/private/data.txt", "secret");

    const entries = await fsUser2.readdir("/");
    expect(entries).not.toContain("private");
  });

  test("user cannot stat other user's files", async () => {
    await fsUser1.writeFile("/hidden.txt", "secret");
    expect(fsUser2.stat("/hidden.txt")).rejects.toThrow("ENOENT");
  });

  test("user file counts are independent", async () => {
    await fsUser1.writeFile("/a.txt", "a");
    await fsUser1.writeFile("/b.txt", "b");
    await fsUser2.writeFile("/x.txt", "x");

    const user1Files = await fsUser1.readdir("/");
    const user2Files = await fsUser2.readdir("/");
    expect(user1Files).toEqual(["a.txt", "b.txt"]);
    expect(user2Files).toEqual(["x.txt"]);
  });

  test("deleting user1's file doesn't affect user2", async () => {
    await fsUser1.writeFile("/shared-name.txt", "user1 data");
    await fsUser2.writeFile("/shared-name.txt", "user2 data");

    await fsUser1.rm("/shared-name.txt");
    expect(await fsUser1.exists("/shared-name.txt")).toBe(false);
    expect(await fsUser2.readFile("/shared-name.txt")).toBe("user2 data");
  });

  test("search is scoped to user", async () => {
    await fsUser1.writeFile("/report.md", "quarterly revenue analysis");
    await fsUser2.writeFile("/notes.md", "quarterly planning notes");

    const results1 = await fsUser1.search("quarterly");
    const results2 = await fsUser2.search("quarterly");

    expect(results1.map(r => r.path)).toEqual(["/report.md"]);
    expect(results2.map(r => r.path)).toEqual(["/notes.md"]);
  });
});
```

**Step 2: Run tests**

Run: `bun test tests/rls.test.ts`
Expected: all tests PASS (isolation is already built into PgFileSystem via owner_id filtering)

**Step 3: Commit**

```bash
git add tests/rls.test.ts
git commit -m "test: verify complete per-user filesystem isolation"
```

---

### Task 8: Vector Search Tests

**Files:**
- Create: `tests/vector-search.test.ts`

This task tests semantic and hybrid search with a mock embedding provider.

**Step 1: Write failing tests**

`tests/vector-search.test.ts`:
```typescript
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createTestSql, resetDb } from "./helpers";
import { PgFileSystem } from "../src/pg-filesystem";
import type postgres from "postgres";

// Simple deterministic mock embedder: hashes text into a 3-dimensional vector
function mockEmbed(text: string): Promise<number[]> {
  let h1 = 0, h2 = 0, h3 = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = (h1 + c * 31) % 1000;
    h2 = (h2 + c * 37) % 1000;
    h3 = (h3 + c * 41) % 1000;
  }
  return Promise.resolve([h1 / 1000, h2 / 1000, h3 / 1000]);
}

describe("Vector Search", () => {
  let sql: postgres.Sql;
  let fs: PgFileSystem;

  beforeAll(() => {
    sql = createTestSql();
  });

  afterAll(async () => {
    await resetDb(sql);
    await sql.end();
  });

  beforeEach(async () => {
    await resetDb(sql);
    fs = new PgFileSystem({
      sql,
      userId: 1,
      embed: mockEmbed,
      embeddingDimensions: 3,
    });
    await fs.setup();

    await fs.writeFile("/ml-paper.md", "deep learning neural networks transformers");
    await fs.writeFile("/recipe.md", "chocolate cake baking instructions flour sugar");
    await fs.writeFile("/code.md", "typescript postgres database queries functions");
  });

  test("semantic search returns results ordered by similarity", async () => {
    const results = await fs.semanticSearch("neural networks deep learning");
    expect(results.length).toBeGreaterThan(0);
    // All results should have a rank (similarity score)
    for (const r of results) {
      expect(typeof r.rank).toBe("number");
    }
  });

  test("semantic search scoped to subtree", async () => {
    await fs.mkdir("/papers", { recursive: true });
    await fs.writeFile("/papers/ml.md", "deep learning research");
    const results = await fs.semanticSearch("deep learning", { path: "/papers" });
    const paths = results.map(r => r.path);
    expect(paths).toContain("/papers/ml.md");
    expect(paths).not.toContain("/ml-paper.md");
  });

  test("hybrid search combines text and vector scores", async () => {
    const results = await fs.hybridSearch("learning neural");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.rank).toBe("number");
    }
  });

  test("throws when no embed provider configured", async () => {
    const fsNoEmbed = new PgFileSystem({ sql, userId: 1 });
    // Don't call setup since schema already exists
    expect(fsNoEmbed.semanticSearch("test")).rejects.toThrow("No embedding provider");
  });

  test("binary files don't get embeddings", async () => {
    await fs.writeFile("/bin.dat", new Uint8Array([1, 2, 3]));
    // Should not throw — binary write skips embedding
    const results = await fs.semanticSearch("binary data");
    const paths = results.map(r => r.path);
    expect(paths).not.toContain("/bin.dat");
  });
});
```

**Step 2: Run tests**

Run: `bun test tests/vector-search.test.ts`
Expected: PASS if pgvector extension is available. If pgvector is not installed, tests will fail on setup — that's expected and documents the dependency.

**Step 3: Commit**

```bash
git add tests/vector-search.test.ts
git commit -m "test: vector semantic and hybrid search with mock embedder"
```

---

### Task 9: Integration Test with just-bash

**Files:**
- Create: `tests/integration.test.ts`

**Step 1: Write integration test**

`tests/integration.test.ts`:
```typescript
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Bash } from "just-bash";
import { createTestSql, resetDb } from "./helpers";
import { PgFileSystem } from "../src/pg-filesystem";
import type postgres from "postgres";

describe("just-bash integration", () => {
  let sql: postgres.Sql;
  let pgFs: PgFileSystem;
  let bash: InstanceType<typeof Bash>;

  beforeAll(() => {
    sql = createTestSql();
  });

  afterAll(async () => {
    await resetDb(sql);
    await sql.end();
  });

  beforeEach(async () => {
    await resetDb(sql);
    pgFs = new PgFileSystem({ sql, userId: 1 });
    await pgFs.setup();
    bash = new Bash({ fs: pgFs, cwd: "/" });
  });

  test("echo writes to file via bash", async () => {
    await bash.exec('echo "hello world" > /greeting.txt');
    const content = await pgFs.readFile("/greeting.txt");
    expect(content.trim()).toBe("hello world");
  });

  test("cat reads file via bash", async () => {
    await pgFs.writeFile("/test.txt", "file content here");
    const result = await bash.exec("cat /test.txt");
    expect(result.stdout.trim()).toBe("file content here");
  });

  test("mkdir + ls works", async () => {
    await bash.exec("mkdir -p /mydir/sub");
    await bash.exec('echo "a" > /mydir/file1.txt');
    await bash.exec('echo "b" > /mydir/file2.txt');
    const result = await bash.exec("ls /mydir");
    const entries = result.stdout.trim().split("\n").sort();
    expect(entries).toContain("file1.txt");
    expect(entries).toContain("file2.txt");
    expect(entries).toContain("sub");
  });

  test("rm removes files", async () => {
    await bash.exec('echo "doomed" > /temp.txt');
    await bash.exec("rm /temp.txt");
    const result = await bash.exec("ls /");
    expect(result.stdout).not.toContain("temp.txt");
  });

  test("mv renames files", async () => {
    await bash.exec('echo "data" > /old.txt');
    await bash.exec("mv /old.txt /new.txt");
    const result = await bash.exec("cat /new.txt");
    expect(result.stdout.trim()).toBe("data");
  });

  test("cp copies files", async () => {
    await bash.exec('echo "original" > /src.txt');
    await bash.exec("cp /src.txt /dst.txt");
    const result = await bash.exec("cat /dst.txt");
    expect(result.stdout.trim()).toBe("original");
  });
});
```

**Step 2: Run tests**

Run: `bun test tests/integration.test.ts`
Expected: all tests PASS

**Step 3: Commit**

```bash
git add tests/integration.test.ts
git commit -m "test: just-bash integration — echo, cat, mkdir, ls, rm, mv, cp"
```

---

### Task 10: Documentation + Package Finalization

**Files:**
- Create: `README.md`
- Modify: `package.json` (add exports, scripts, metadata)

**Step 1: Write README**

`README.md`: Write a clear README covering:
- What this is (one paragraph)
- Installation (`bun add just-bash-postgres`)
- Quick start example (PgFileSystem + Bash)
- Schema setup (auto-migration via `fs.setup()`)
- Search features (FTS, semantic, hybrid) with examples
- User isolation (pass userId, complete isolation)
- Configuration options (PgFileSystemOptions interface)
- Prerequisites (PostgreSQL with ltree; pgvector optional)

**Step 2: Update package.json**

Add these fields:
```json
{
  "name": "just-bash-postgres",
  "version": "0.1.0",
  "description": "PostgreSQL filesystem provider for just-bash with ltree, FTS, vector search, and RLS",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "just-bash": ">=0.1.0"
  },
  "keywords": ["just-bash", "filesystem", "postgresql", "ltree", "vector-search", "full-text-search"]
}
```

**Step 3: Run all tests**

Run: `bun test`
Expected: all tests PASS

**Step 4: Commit**

```bash
git add README.md package.json
git commit -m "docs: README and package metadata"
```
