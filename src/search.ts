import type postgres from "postgres";
import { ltreeToPath, encodeLabel } from "./path-encoding";

export interface SearchResult {
  path: string;
  name: string;
  rank: number;
  snippet?: string;
}

const MAX_SEARCH_LIMIT = 1000;

function clampLimit(limit: number | undefined): number {
  const val = limit ?? 20;
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
  ltreePrefix: string,
  query: string,
  opts?: { path?: string; limit?: number }
): Promise<SearchResult[]> {
  const limit = clampLimit(opts?.limit);
  const scopeLtree = buildScopeLtree(ltreePrefix, opts?.path);

  const rows = await sql<FtsRow[]>`
    SELECT
      path::text as path,
      name,
      ts_rank(search_vector, websearch_to_tsquery('english', ${query})) AS rank,
      ts_headline('english', coalesce(content, ''), websearch_to_tsquery('english', ${query}),
        'MaxWords=35, MinWords=15, MaxFragments=1') AS snippet
    FROM fs_nodes
    WHERE session_id = ${sessionId}
      AND path <@ ${scopeLtree}::ltree
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
  ltreePrefix: string,
  embedding: number[],
  opts?: { path?: string; limit?: number }
): Promise<SearchResult[]> {
  const limit = clampLimit(opts?.limit);
  const scopeLtree = buildScopeLtree(ltreePrefix, opts?.path);
  validateEmbedding(embedding);
  const embeddingStr = `[${embedding.join(",")}]`;

  const rows = await sql<VectorRow[]>`
    SELECT
      path::text as path,
      name,
      1 - (embedding <=> ${embeddingStr}::vector) AS rank
    FROM fs_nodes
    WHERE session_id = ${sessionId}
      AND path <@ ${scopeLtree}::ltree
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
  ltreePrefix: string,
  query: string,
  embedding: number[],
  opts?: { path?: string; textWeight?: number; vectorWeight?: number; limit?: number }
): Promise<SearchResult[]> {
  const limit = clampLimit(opts?.limit);
  const textWeight = opts?.textWeight ?? 0.4;
  const vectorWeight = opts?.vectorWeight ?? 0.6;
  const scopeLtree = buildScopeLtree(ltreePrefix, opts?.path);
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
      AND path <@ ${scopeLtree}::ltree
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

function buildScopeLtree(ltreePrefix: string, path?: string): string {
  if (!path || path === "/") return ltreePrefix;
  const segments = path.split("/").filter(Boolean);
  const encodedSegments = segments.map(encodeLabel);
  return ltreePrefix + "." + encodedSegments.join(".");
}
