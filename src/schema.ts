import type postgres from "postgres";
import migration from "../sql/001-setup.sql" with { type: "text" };

export async function setupSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(migration);
}

const MAX_VECTOR_DIMENSIONS = 16000;

export async function setupVectorColumn(sql: postgres.Sql, dimensions: number): Promise<void> {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > MAX_VECTOR_DIMENSIONS) {
    throw new Error(`Invalid vector dimensions: ${dimensions} (must be integer between 1 and ${MAX_VECTOR_DIMENSIONS})`);
  }
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);

  await sql.unsafe(`
    DO $$ BEGIN
      ALTER TABLE fs_nodes ADD COLUMN embedding vector(${dimensions});
    EXCEPTION WHEN duplicate_column THEN
      NULL;
    END $$
  `);
  await sql.unsafe(`
    CREATE INDEX IF NOT EXISTS idx_fs_embedding ON fs_nodes
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)
  `);
}
