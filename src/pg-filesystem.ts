import type postgres from "postgres";
import type {
  IFileSystem,
  FsStat,
  MkdirOptions,
  RmOptions,
  CpOptions,
  BufferEncoding,
  FileContent,
} from "just-bash";
import { pathToLtree, ltreeToPath, normalizePath, encodeLabel, decodeLabel } from "./path-encoding";
import { setupSchema, setupVectorColumn } from "./schema";
import {
  fullTextSearch,
  semanticSearch as doSemanticSearch,
  hybridSearch as doHybridSearch,
  validateEmbedding,
} from "./search";
import type { SearchResult } from "./search";

interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

interface WriteFileOptions {
  encoding?: BufferEncoding;
}

interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface PgFileSystemOptions {
  sql: postgres.Sql;
  sessionId: number;
  embed?: (text: string) => Promise<number[]>;
  embeddingDimensions?: number;
  maxFileSize?: number;
}

interface FsRow {
  id: number;
  session_id: number;
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

const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_SYMLINK_DEPTH = 16;
const MAX_PATH_DEPTH = 256;

function fsError(code: string, op: string, path: string): Error {
  return new Error(`${code}: ${op}, '${path}'`);
}

export class PgFileSystem implements IFileSystem {
  private sql: postgres.Sql;
  private sessionId: number;
  private embed?: (text: string) => Promise<number[]>;
  private embeddingDimensions?: number;
  private maxFileSize: number;

  constructor(options: PgFileSystemOptions) {
    if (!Number.isInteger(options.sessionId) || options.sessionId < 1 || options.sessionId > Number.MAX_SAFE_INTEGER) {
      throw new Error(`Invalid sessionId: must be a positive integer, got ${options.sessionId}`);
    }
    this.sql = options.sql;
    this.sessionId = options.sessionId;
    this.embed = options.embed;
    this.embeddingDimensions = options.embeddingDimensions;
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  }

  async setup(): Promise<void> {
    // DDL runs outside transaction (may require elevated privileges)
    await setupSchema(this.sql);
    if (this.embeddingDimensions) {
      await setupVectorColumn(this.sql, this.embeddingDimensions);
    }
    // Root directory creation within session context
    await this.withSession(async (tx) => {
      const rootLtree = pathToLtree("/", this.sessionId);
      await tx`
        INSERT INTO fs_nodes (session_id, name, node_type, path, mode)
        VALUES (${this.sessionId}, '/', 'directory', ${rootLtree}::ltree, 755)
        ON CONFLICT (session_id, path) DO NOTHING
      `;
    });
  }

  // -- Transaction wrapper (sets RLS context) ---------------------------------

  private withSession<T>(fn: (tx: postgres.Sql) => Promise<T>): Promise<T> {
    // Cast through any: TransactionSql supports the same tagged template interface as Sql
    // but has incompatible generic types. The cast is safe at runtime.
    return this.sql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.session_id', ${String(this.sessionId)}, true)`;
      await tx`SELECT set_config('statement_timeout', '30000', true)`;
      return fn(tx);
    }) as Promise<T>;
  }

  // -- Low-level helpers (operate within a transaction) -----------------------

  private async getNode(tx: postgres.Sql, posixPath: string): Promise<FsRow | null> {
    const lt = pathToLtree(posixPath, this.sessionId);
    const rows = await tx<FsRow[]>`
      SELECT * FROM fs_nodes
      WHERE session_id = ${this.sessionId} AND path = ${lt}::ltree
      LIMIT 1
    `;
    return rows.length > 0 ? rows[0] : null;
  }

  private async resolveSymlink(tx: postgres.Sql, path: string, maxDepth = MAX_SYMLINK_DEPTH): Promise<FsRow> {
    const node = await this.getNode(tx, path);
    if (!node) throw fsError("ENOENT", "no such file or directory", path);
    if (node.node_type === "symlink" && node.symlink_target) {
      if (maxDepth <= 0) throw fsError("ELOOP", "too many levels of symbolic links", path);
      return this.resolveSymlink(tx, normalizePath(node.symlink_target), maxDepth - 1);
    }
    return node;
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

  private validateFileSize(content: FileContent): void {
    const size = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
    if (size > this.maxFileSize) {
      throw new Error(`File too large: ${size} bytes exceeds maximum of ${this.maxFileSize} bytes`);
    }
  }

  private validatePathDepth(path: string): void {
    const depth = path.split("/").filter(Boolean).length;
    if (depth > MAX_PATH_DEPTH) {
      throw new Error(`Path too deep: ${depth} levels exceeds maximum of ${MAX_PATH_DEPTH}`);
    }
  }

  // -- Internal write (shared by writeFile, appendFile, link, cp) -------------

  private async internalWriteFile(
    tx: postgres.Sql,
    path: string,
    content: FileContent,
    _options?: WriteFileOptions | BufferEncoding,
    precomputedEmbedding?: number[] | null
  ): Promise<void> {
    this.validateFileSize(content);
    this.validatePathDepth(path);

    const name = this.fileName(path);
    const parentPosix = this.parentPath(path);
    const parent = await this.getNode(tx, parentPosix);
    if (!parent) throw fsError("ENOENT", "no such file or directory, open", path);

    const existing = await this.getNode(tx, path);
    if (existing?.node_type === "directory") throw fsError("EISDIR", "illegal operation on a directory, open", path);

    const lt = pathToLtree(path, this.sessionId);
    const isText = typeof content === "string";
    const textContent = isText ? content : null;
    const binaryData = isText ? null : content;
    const sizeBytes = isText ? Buffer.byteLength(content) : content.byteLength;

    let embedding: number[] | null = precomputedEmbedding ?? null;
    if (embedding === null && isText && this.embed && content.length > 0) {
      embedding = await this.embed(content);
      if (embedding) {
        validateEmbedding(embedding, this.embeddingDimensions);
      }
    }

    if (embedding) {
      const embeddingStr = `[${embedding.join(",")}]`;
      await tx`
        INSERT INTO fs_nodes (session_id, parent_id, name, node_type, path, content, binary_data, size_bytes, mtime, embedding)
        VALUES (${this.sessionId}, ${parent.id}, ${name}, 'file', ${lt}::ltree, ${textContent}, ${binaryData}, ${sizeBytes}, now(), ${embeddingStr}::vector)
        ON CONFLICT (session_id, path) DO UPDATE SET
          content = EXCLUDED.content,
          binary_data = EXCLUDED.binary_data,
          size_bytes = EXCLUDED.size_bytes,
          mtime = now(),
          embedding = EXCLUDED.embedding
      `;
    } else {
      await tx`
        INSERT INTO fs_nodes (session_id, parent_id, name, node_type, path, content, binary_data, size_bytes, mtime)
        VALUES (${this.sessionId}, ${parent.id}, ${name}, 'file', ${lt}::ltree, ${textContent}, ${binaryData}, ${sizeBytes}, now())
        ON CONFLICT (session_id, path) DO UPDATE SET
          content = EXCLUDED.content,
          binary_data = EXCLUDED.binary_data,
          size_bytes = EXCLUDED.size_bytes,
          mtime = now()
      `;
    }
  }

  // -- Internal mkdir (shared by mkdir, cp) -----------------------------------

  private async internalMkdir(tx: postgres.Sql, path: string, options?: MkdirOptions): Promise<void> {
    this.validatePathDepth(path);
    const recursive = options?.recursive ?? false;

    if (recursive) {
      const segments = path.split("/").filter(Boolean);
      let current = "/";
      for (const segment of segments) {
        const parentPosix = current;
        current = current === "/" ? `/${segment}` : `${current}/${segment}`;
        const existing = await this.getNode(tx, current);
        if (existing) {
          if (existing.node_type !== "directory") {
            throw fsError("ENOTDIR", "not a directory, mkdir", current);
          }
          continue;
        }
        const parent = await this.getNode(tx, parentPosix);
        if (!parent) throw fsError("ENOENT", "no such file or directory, mkdir", current);
        const lt = pathToLtree(current, this.sessionId);
        await tx`
          INSERT INTO fs_nodes (session_id, parent_id, name, node_type, path, mode)
          VALUES (${this.sessionId}, ${parent.id}, ${segment}, 'directory', ${lt}::ltree, 755)
          ON CONFLICT (session_id, path) DO NOTHING
        `;
      }
    } else {
      const existing = await this.getNode(tx, path);
      if (existing) throw fsError("EEXIST", "file already exists, mkdir", path);
      const parentPosix = this.parentPath(path);
      const parent = await this.getNode(tx, parentPosix);
      if (!parent) throw fsError("ENOENT", "no such file or directory, mkdir", path);
      const name = this.fileName(path);
      const lt = pathToLtree(path, this.sessionId);
      await tx`
        INSERT INTO fs_nodes (session_id, parent_id, name, node_type, path, mode)
        VALUES (${this.sessionId}, ${parent.id}, ${name}, 'directory', ${lt}::ltree, 755)
      `;
    }
  }

  // -- Internal readdir (shared by readdir, cp) -------------------------------

  private async internalReaddir(tx: postgres.Sql, path: string): Promise<string[]> {
    const node = await this.getNode(tx, path);
    if (!node) throw fsError("ENOENT", "no such file or directory, scandir", path);
    if (node.node_type !== "directory") throw fsError("ENOTDIR", "not a directory, scandir", path);

    const lt = pathToLtree(path, this.sessionId);
    const depth = lt.split(".").length + 1;
    const rows = await tx<{ name: string }[]>`
      SELECT name FROM fs_nodes
      WHERE session_id = ${this.sessionId}
        AND path <@ ${lt}::ltree
        AND nlevel(path) = ${depth}
      ORDER BY name
    `;
    return rows.map(r => r.name);
  }

  // -- Internal cp (recursive, stays in same tx) -----------------------------

  private async internalCp(tx: postgres.Sql, src: string, dest: string, options?: CpOptions): Promise<void> {
    // Overlap detection
    if (dest.startsWith(src + "/") || dest === src) {
      throw new Error(`EINVAL: cannot copy '${src}' to a subdirectory of itself '${dest}'`);
    }

    const srcNode = await this.getNode(tx, src);
    if (!srcNode) throw fsError("ENOENT", "no such file or directory, cp", src);

    if (srcNode.node_type === "directory") {
      if (!options?.recursive) {
        throw fsError("EISDIR", "illegal operation on a directory, cp", src);
      }
      await this.internalMkdir(tx, dest, { recursive: true });
      const children = await this.internalReaddir(tx, src);
      for (const child of children) {
        const srcChild = src === "/" ? `/${child}` : `${src}/${child}`;
        const destChild = dest === "/" ? `/${child}` : `${dest}/${child}`;
        await this.internalCp(tx, srcChild, destChild, options);
      }
      return;
    }

    const content = srcNode.content !== null ? srcNode.content : await this.internalReadFileBuffer(tx, src);
    await this.internalWriteFile(tx, dest, content);
  }

  // -- Internal readFileBuffer (shared by readFileBuffer, link, cp) ----------

  private async internalReadFileBuffer(tx: postgres.Sql, path: string): Promise<Uint8Array> {
    const node = await this.resolveSymlink(tx, path);
    if (node.node_type === "directory") throw fsError("EISDIR", "illegal operation on a directory, read", path);
    if (node.binary_data !== null) return node.binary_data;
    if (node.content !== null) return new TextEncoder().encode(node.content);
    return new Uint8Array(0);
  }

  // -- File I/O ---------------------------------------------------------------

  async readFile(path: string, _options?: ReadFileOptions | BufferEncoding): Promise<string> {
    return this.withSession(async (tx) => {
      const p = normalizePath(path);
      const node = await this.resolveSymlink(tx, p);
      if (node.node_type === "directory") throw fsError("EISDIR", "illegal operation on a directory, read", path);
      if (node.content !== null) return node.content;
      if (node.binary_data !== null) return new TextDecoder().decode(node.binary_data);
      return "";
    });
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return this.withSession(async (tx) => {
      return this.internalReadFileBuffer(tx, normalizePath(path));
    });
  }

  async writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const normalized = normalizePath(path);
    // Compute embedding outside transaction to avoid holding connection during API calls
    let embedding: number[] | null = null;
    if (typeof content === "string" && this.embed && content.length > 0) {
      embedding = await this.embed(content);
      if (embedding) {
        validateEmbedding(embedding, this.embeddingDimensions);
      }
    }
    return this.withSession(async (tx) => {
      await this.internalWriteFile(tx, normalized, content, options, embedding);
    });
  }

  async appendFile(path: string, content: FileContent, _options?: WriteFileOptions | BufferEncoding): Promise<void> {
    return this.withSession(async (tx) => {
      const p = normalizePath(path);
      const existing = await this.getNode(tx, p);
      if (!existing) {
        await this.internalWriteFile(tx, p, content);
        return;
      }
      const textContent = typeof content === "string" ? content : new TextDecoder().decode(content);
      const currentContent = existing.content ??
        (existing.binary_data ? new TextDecoder().decode(existing.binary_data) : "");
      await this.internalWriteFile(tx, p, currentContent + textContent);
    });
  }

  // -- Path queries -----------------------------------------------------------

  async exists(path: string): Promise<boolean> {
    return this.withSession(async (tx) => {
      const node = await this.getNode(tx, normalizePath(path));
      return node !== null;
    });
  }

  async stat(path: string): Promise<FsStat> {
    return this.withSession(async (tx) => {
      const node = await this.resolveSymlink(tx, normalizePath(path));
      return {
        isFile: node.node_type === "file",
        isDirectory: node.node_type === "directory",
        isSymbolicLink: false,
        mode: node.mode,
        size: Number(node.size_bytes),
        mtime: new Date(node.mtime),
      };
    });
  }

  async lstat(path: string): Promise<FsStat> {
    return this.withSession(async (tx) => {
      const p = normalizePath(path);
      const node = await this.getNode(tx, p);
      if (!node) throw fsError("ENOENT", "no such file or directory, lstat", path);
      return {
        isFile: node.node_type === "file",
        isDirectory: node.node_type === "directory",
        isSymbolicLink: node.node_type === "symlink",
        mode: node.mode,
        size: Number(node.size_bytes),
        mtime: new Date(node.mtime),
      };
    });
  }

  async realpath(path: string): Promise<string> {
    return this.withSession(async (tx) => {
      return this.internalRealpath(tx, normalizePath(path));
    });
  }

  private async internalRealpath(tx: postgres.Sql, path: string, maxDepth = MAX_SYMLINK_DEPTH): Promise<string> {
    const node = await this.getNode(tx, path);
    if (!node) throw fsError("ENOENT", "no such file or directory, realpath", path);
    if (node.node_type === "symlink" && node.symlink_target) {
      if (maxDepth <= 0) throw fsError("ELOOP", "too many levels of symbolic links, realpath", path);
      return this.internalRealpath(tx, normalizePath(node.symlink_target), maxDepth - 1);
    }
    return ltreeToPath(node.path);
  }

  // -- Directory operations ---------------------------------------------------

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    return this.withSession(async (tx) => {
      await this.internalMkdir(tx, normalizePath(path), options);
    });
  }

  async readdir(path: string): Promise<string[]> {
    return this.withSession(async (tx) => {
      return this.internalReaddir(tx, normalizePath(path));
    });
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    return this.withSession(async (tx) => {
      const p = normalizePath(path);
      const node = await this.getNode(tx, p);
      if (!node) throw fsError("ENOENT", "no such file or directory, scandir", path);
      if (node.node_type !== "directory") throw fsError("ENOTDIR", "not a directory, scandir", path);

      const lt = pathToLtree(p, this.sessionId);
      const depth = lt.split(".").length + 1;
      const rows = await tx<{ name: string; node_type: string }[]>`
        SELECT name, node_type FROM fs_nodes
        WHERE session_id = ${this.sessionId}
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
    });
  }

  // -- Mutation ---------------------------------------------------------------

  async rm(path: string, options?: RmOptions): Promise<void> {
    return this.withSession(async (tx) => {
      const p = normalizePath(path);
      const node = await this.getNode(tx, p);
      if (!node) {
        if (options?.force) return;
        throw fsError("ENOENT", "no such file or directory, rm", path);
      }

      if (node.node_type === "directory") {
        if (!options?.recursive) {
          const children = await tx`
            SELECT 1 FROM fs_nodes
            WHERE session_id = ${this.sessionId} AND parent_id = ${node.id}
            LIMIT 1
          `;
          if (children.length > 0) {
            throw fsError("ENOTEMPTY", "directory not empty, rm", path);
          }
        }
      }

      if (options?.recursive && node.node_type === "directory") {
        const lt = pathToLtree(p, this.sessionId);
        await tx`
          DELETE FROM fs_nodes
          WHERE session_id = ${this.sessionId} AND path <@ ${lt}::ltree
        `;
      } else {
        await tx`
          DELETE FROM fs_nodes
          WHERE session_id = ${this.sessionId} AND id = ${node.id}
        `;
      }
    });
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    return this.withSession(async (tx) => {
      await this.internalCp(tx, normalizePath(src), normalizePath(dest), options);
    });
  }

  async mv(src: string, dest: string): Promise<void> {
    return this.withSession(async (tx) => {
      const srcPath = normalizePath(src);
      const destPath = normalizePath(dest);

      // Overlap detection
      if (destPath.startsWith(srcPath + "/") || destPath === srcPath) {
        throw new Error(`EINVAL: cannot move '${src}' to a subdirectory of itself '${dest}'`);
      }

      const srcNode = await this.getNode(tx, srcPath);
      if (!srcNode) throw fsError("ENOENT", "no such file or directory, mv", src);

      const destParentPosix = this.parentPath(destPath);
      const destParent = await this.getNode(tx, destParentPosix);
      if (!destParent) throw fsError("ENOENT", "no such file or directory, mv", dest);

      const newName = this.fileName(destPath);
      const newLtree = pathToLtree(destPath, this.sessionId);
      const oldLtree = pathToLtree(srcPath, this.sessionId);

      // Update the node itself
      await tx`
        UPDATE fs_nodes
        SET name = ${newName}, path = ${newLtree}::ltree, parent_id = ${destParent.id}, mtime = now()
        WHERE session_id = ${this.sessionId} AND id = ${srcNode.id}
      `;

      if (srcNode.node_type === "directory") {
        // Update all descendants' paths
        await tx`
          UPDATE fs_nodes
          SET path = (${newLtree}::ltree || subpath(path, nlevel(${oldLtree}::ltree)))
          WHERE session_id = ${this.sessionId}
            AND path <@ ${oldLtree}::ltree
        `;

        // Rebuild parent_id for all descendants based on new paths
        await tx`
          UPDATE fs_nodes AS child
          SET parent_id = parent.id
          FROM fs_nodes AS parent
          WHERE child.session_id = ${this.sessionId}
            AND parent.session_id = ${this.sessionId}
            AND child.path <@ ${newLtree}::ltree
            AND child.path != ${newLtree}::ltree
            AND parent.path = subltree(child.path, 0, nlevel(child.path) - 1)
        `;
      }
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    return this.withSession(async (tx) => {
      const p = normalizePath(path);
      const node = await this.getNode(tx, p);
      if (!node) throw fsError("ENOENT", "no such file or directory, chmod", path);
      await tx`
        UPDATE fs_nodes SET mode = ${mode}
        WHERE session_id = ${this.sessionId} AND id = ${node.id}
      `;
    });
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    return this.withSession(async (tx) => {
      const p = normalizePath(path);
      const node = await this.getNode(tx, p);
      if (!node) throw fsError("ENOENT", "no such file or directory, utimes", path);
      await tx`
        UPDATE fs_nodes SET mtime = ${mtime}
        WHERE session_id = ${this.sessionId} AND id = ${node.id}
      `;
    });
  }

  // -- Links ------------------------------------------------------------------

  async symlink(target: string, linkPath: string): Promise<void> {
    return this.withSession(async (tx) => {
      const normalizedTarget = normalizePath(target);
      const p = normalizePath(linkPath);

      if (normalizedTarget.length > 4096) {
        throw new Error("Symlink target exceeds maximum length of 4096 characters");
      }

      const parentPosix = this.parentPath(p);
      const parent = await this.getNode(tx, parentPosix);
      if (!parent) throw fsError("ENOENT", "no such file or directory, symlink", linkPath);

      const name = this.fileName(p);
      const lt = pathToLtree(p, this.sessionId);

      await tx`
        INSERT INTO fs_nodes (session_id, parent_id, name, node_type, path, symlink_target, mode)
        VALUES (${this.sessionId}, ${parent.id}, ${name}, 'symlink', ${lt}::ltree, ${normalizedTarget}, 777)
      `;
    });
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    return this.withSession(async (tx) => {
      const src = normalizePath(existingPath);
      const srcNode = await this.getNode(tx, src);
      if (!srcNode) throw fsError("ENOENT", "no such file or directory, link", existingPath);
      if (srcNode.node_type === "directory") throw fsError("EPERM", "operation not permitted, link", existingPath);

      const content = srcNode.content !== null ? srcNode.content : await this.internalReadFileBuffer(tx, src);
      await this.internalWriteFile(tx, normalizePath(newPath), content);
    });
  }

  async readlink(path: string): Promise<string> {
    return this.withSession(async (tx) => {
      const p = normalizePath(path);
      const node = await this.getNode(tx, p);
      if (!node) throw fsError("ENOENT", "no such file or directory, readlink", path);
      if (node.node_type !== "symlink") throw fsError("EINVAL", "invalid argument, readlink", path);
      return node.symlink_target!;
    });
  }

  // -- Utility ----------------------------------------------------------------

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    if (base === "/") return normalizePath("/" + path);
    return normalizePath(base + "/" + path);
  }

  getAllPaths(): string[] {
    return [];
  }

  // -- Search -----------------------------------------------------------------

  async search(query: string, opts?: { path?: string; limit?: number }): Promise<SearchResult[]> {
    return this.withSession(async (tx) => {
      const ltreePrefix = pathToLtree("/", this.sessionId);
      return fullTextSearch(tx, this.sessionId, ltreePrefix, query, opts);
    });
  }

  async semanticSearch(query: string, opts?: { path?: string; limit?: number }): Promise<SearchResult[]> {
    if (!this.embed) throw new Error("No embedding provider configured");
    const embedding = await this.embed(query);
    validateEmbedding(embedding, this.embeddingDimensions);
    return this.withSession(async (tx) => {
      const ltreePrefix = pathToLtree("/", this.sessionId);
      return doSemanticSearch(tx, this.sessionId, ltreePrefix, embedding, opts);
    });
  }

  async hybridSearch(query: string, opts?: {
    path?: string;
    textWeight?: number;
    vectorWeight?: number;
    limit?: number;
  }): Promise<SearchResult[]> {
    if (!this.embed) throw new Error("No embedding provider configured");
    const embedding = await this.embed(query);
    validateEmbedding(embedding, this.embeddingDimensions);
    return this.withSession(async (tx) => {
      const ltreePrefix = pathToLtree("/", this.sessionId);
      return doHybridSearch(tx, this.sessionId, ltreePrefix, query, embedding, opts);
    });
  }
}
