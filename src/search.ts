import type postgres from "postgres";
import { ltreeToPath, encodeLabel } from "./path-encoding";

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
  const scopeLtree = buildScopeLtree(ltreePrefix, opts?.path);

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
    path: ltreeToPath(r.path),
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
  const scopeLtree = buildScopeLtree(ltreePrefix, opts?.path);
  const embeddingStr = `[${embedding.join(",")}]`;

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
    path: ltreeToPath(r.path),
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
  const scopeLtree = buildScopeLtree(ltreePrefix, opts?.path);
  const embeddingStr = `[${embedding.join(",")}]`;

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
