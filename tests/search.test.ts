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
    fs = new PgFileSystem({ sql, sessionId: 1 });
    await fs.setup();

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
    await fs.writeFile("/revenue_report", "some generic content");
    const results = await fs.search("revenue");
    expect(results[0].path).toBe("/revenue_report");
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
