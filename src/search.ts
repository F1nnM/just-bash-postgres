import type postgres from "postgres";
import { ltreeToPath, pathToLtree } from "./path-encoding";

export interface SearchResult {
  path: string;
  name: string;
  rank: number;
  snippet?: string;
}

const MAX_SEARCH_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  const val = limit ?? 20;
  if (!Number.isFinite(val)) return 20;
  return Math.min(Math.max(1, val), MAX_SEARCH_LIMIT);
}

export function validateEmbedding(embedding: number[], expectedDimensions?: number): void {
  if (expectedDimensions !== undefined && embedding.length !== expectedDimensions) {
    throw new Error(
      `Embedding dimension mismatch: expected ${expectedDimensions}, got ${embedding.length}`
    );
  }
  for (let i = 0; i < embedding.length; i++) {
    if (!Number.isFinite(embedding[i])) {
      throw new Error(`Embedding contains non-finite value at index ${i}: ${embedding[i]}`);
    }
  }
}

interface FtsRow {
  path: string;
  name: string;
  rank: string;
  snippet: string;
}

interface VectorRow {
  path: string;
  name: string;
  rank: string;
}

export async function fullTextSearch(
  sql: postgres.Sql,
  sessionId: number,
  query: string,
  opts?: { path?: string; limit?: number }
): Promise<SearchResult[]> {
  const limit = clampLimit(opts?.limit);
  const scopeLtree = pathToLtree(opts?.path ?? "/", sessionId);

  const rows = await sql<FtsRow[]>`
    SELECT
      path::text as path,
      name,
      ts_rank(search_vector, websearch_to_tsquery('english', ${query})) AS rank,
      ts_headline('english', left(coalesce(content, ''), 100000), websearch_to_tsquery('english', ${query}),
        'MaxWords=35, MinWords=15, MaxFragments=1') AS snippet
    FROM fs_nodes
    WHERE session_id = ${sessionId}
      AND path <@ ${scopeLtree}::text::ltree
      AND node_type = 'file'
      AND search_vector @@ websearch_to_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    path: ltreeToPath(r.path),
    name: r.name,
    rank: parseFloat(r.rank),
    snippet: r.snippet || undefined,
  }));
}

export async function semanticSearch(
  sql: postgres.Sql,
  sessionId: number,
  embedding: number[],
  opts?: { path?: string; limit?: number }
): Promise<SearchResult[]> {
  const limit = clampLimit(opts?.limit);
  const scopeLtree = pathToLtree(opts?.path ?? "/", sessionId);
  validateEmbedding(embedding);
  const embeddingStr = `[${embedding.join(",")}]`;

  const rows = await sql<VectorRow[]>`
    SELECT
      path::text as path,
      name,
      1 - (embedding <=> ${embeddingStr}::vector) AS rank
    FROM fs_nodes
    WHERE session_id = ${sessionId}
      AND path <@ ${scopeLtree}::text::ltree
      AND node_type = 'file'
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${embeddingStr}::vector
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    path: ltreeToPath(r.path),
    name: r.name,
    rank: parseFloat(r.rank),
  }));
}

export async function hybridSearch(
  sql: postgres.Sql,
  sessionId: number,
  query: string,
  embedding: number[],
  opts?: { path?: string; textWeight?: number; vectorWeight?: number; limit?: number }
): Promise<SearchResult[]> {
  const limit = clampLimit(opts?.limit);
  const textWeight = opts?.textWeight ?? 0.4;
  const vectorWeight = opts?.vectorWeight ?? 0.6;
  if (!Number.isFinite(textWeight) || !Number.isFinite(vectorWeight)) {
    throw new Error("Search weights must be finite numbers");
  }
  const scopeLtree = pathToLtree(opts?.path ?? "/", sessionId);
  validateEmbedding(embedding);
  const embeddingStr = `[${embedding.join(",")}]`;

  const rows = await sql<VectorRow[]>`
    SELECT
      path::text as path,
      name,
      (${textWeight} * ts_rank(search_vector, websearch_to_tsquery('english', ${query})) +
       ${vectorWeight} * (1 - (embedding <=> ${embeddingStr}::vector))) AS rank
    FROM fs_nodes
    WHERE session_id = ${sessionId}
      AND path <@ ${scopeLtree}::text::ltree
      AND node_type = 'file'
      AND search_vector @@ websearch_to_tsquery('english', ${query})
      AND embedding IS NOT NULL
    ORDER BY rank DESC
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    path: ltreeToPath(r.path),
    name: r.name,
    rank: parseFloat(r.rank),
  }));
}
