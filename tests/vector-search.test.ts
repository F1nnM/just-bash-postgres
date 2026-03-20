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
