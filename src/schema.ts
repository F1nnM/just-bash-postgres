import type postgres from "postgres";
import { readFileSync } from "fs";
import { join } from "path";

export async function setupSchema(sql: postgres.Sql): Promise<void> {
  const migrationPath = join(import.meta.dir, "..", "sql", "001-setup.sql");
  const migration = readFileSync(migrationPath, "utf-8");
  await sql.unsafe(migration);
}

const MAX_VECTOR_DIMENSIONS = 16000;

export async function setupVectorColumn(sql: postgres.Sql, dimensions: number): Promise<void> {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_VECTOR_DIMENSIONS) {
    throw new Error(`Invalid vector dimensions: ${dimensions} (must be integer between 1 and ${MAX_VECTOR_DIMENSIONS})`);
  }
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
