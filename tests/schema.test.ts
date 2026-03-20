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
    expect(columns).toContain("session_id");
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
    await setupSchema(sql);
  });
});
