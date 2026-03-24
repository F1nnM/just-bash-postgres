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
import { pathToLtree, ltreeToPath, normalizePath } from "./path-encoding";
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
  statementTimeoutMs?: number;
}

export class FsError extends Error {
  code: string;
  constructor(code: string, op: string, path: string) {
    super(`${code}: ${op}, '${path}'`);
    this.code = code;
  }
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

type FsRowMeta = Omit<FsRow, "content" | "binary_data">;

const DEFAULT_MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB
const MAX_SYMLINK_DEPTH = 16;
const MAX_PATH_DEPTH = 256;
const MAX_CP_NODES = 10000;

export class PgFileSystem implements IFileSystem {
  private sql: postgres.Sql;
  private sessionId: number;
  private embed?: (text: string) => Promise<number[]>;
  private embeddingDimensions?: number;
  private maxFileSize: number;
  private statementTimeoutMs: number;

  constructor(options: PgFileSystemOptions) {
    if (!Number.isInteger(options.sessionId) || options.sessionId < 1 || options.sessionId > Number.MAX_SAFE_INTEGER) {
      throw new Error(`Invalid sessionId: must be a positive integer, got ${options.sessionId}`);
    }
    this.sql = options.sql;
    this.sessionId = options.sessionId;
    this.embed = options.embed;
    this.embeddingDimensions = options.embeddingDimensions;
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.statementTimeoutMs = options.statementTimeoutMs ?? 30000;
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
        VALUES (${this.sessionId}, '/', 'directory', ${rootLtree}::ltree, ${0o755})
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
      await tx`SELECT set_config('statement_timeout', ${String(this.statementTimeoutMs)}, true)`;
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

  private async getNodeMeta(tx: postgres.Sql, posixPath: string): Promise<FsRowMeta | null> {
    const lt = pathToLtree(posixPath, this.sessionId);
    const rows = await tx<FsRowMeta[]>`
      SELECT id, session_id, parent_id, name, node_type, path, symlink_target, mode, size_bytes, mtime, created_at
      FROM fs_nodes
      WHERE session_id = ${this.sessionId} AND path = ${lt}::ltree
      LIMIT 1
    `;
    return rows.length > 0 ? rows[0] : null;
  }

  private async getNodeForUpdate(tx: postgres.Sql, posixPath: string): Promise<FsRow | null> {
    const lt = pathToLtree(posixPath, this.sessionId);
    const rows = await tx<FsRow[]>`
      SELECT * FROM fs_nodes
      WHERE session_id = ${this.sessionId} AND path = ${lt}::ltree
      LIMIT 1
      FOR UPDATE
    `;
    return rows.length > 0 ? rows[0] : null;
  }

  private async resolveSymlink(tx: postgres.Sql, path: string, maxDepth = MAX_SYMLINK_DEPTH): Promise<FsRow> {
    const node = await this.getNode(tx, path);
    if (!node) throw new FsError("ENOENT", "no such file or directory", path);
    if (node.node_type === "symlink" && node.symlink_target) {
      if (maxDepth <= 0) throw new FsError("ELOOP", "too many levels of symbolic links", path);
      return this.resolveSymlink(tx, normalizePath(node.symlink_target), maxDepth - 1);
    }
    return node;
  }

  private async resolveSymlinkMeta(tx: postgres.Sql, path: string, maxDepth = MAX_SYMLINK_DEPTH): Promise<FsRowMeta> {
    const node = await this.getNodeMeta(tx, path);
    if (!node) throw new FsError("ENOENT", "no such file or directory", path);
    if (node.node_type === "symlink" && node.symlink_target) {
      if (maxDepth <= 0) throw new FsError("ELOOP", "too many levels of symbolic links", path);
      return this.resolveSymlinkMeta(tx, normalizePath(node.symlink_target), maxDepth - 1);
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

  // precomputedEmbedding: undefined = compute if possible, null = skip embedding
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
    const parent = await this.getNodeMeta(tx, parentPosix);
    if (!parent) throw new FsError("ENOENT", "no such file or directory, open", path);

    const existing = await this.getNodeMeta(tx, path);
    if (existing?.node_type === "directory") throw new FsError("EISDIR", "illegal operation on a directory, open", path);

    const lt = pathToLtree(path, this.sessionId);
    const isText = typeof content === "string";
    const textContent = isText ? content : null;
    const binaryData = isText ? null : content;
    const sizeBytes = isText ? Buffer.byteLength(content) : content.byteLength;

    let embedding: number[] | null = null;
    if (precomputedEmbedding !== undefined) {
      embedding = precomputedEmbedding;
    } else if (isText && this.embed && content.length > 0) {
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

      const allPaths: string[] = [];
      const allLtrees: string[] = [];
      const allNames: string[] = [];
      let current = "/";
      for (const segment of segments) {
        current = current === "/" ? `/${segment}` : `${current}/${segment}`;
        allPaths.push(current);
        allLtrees.push(pathToLtree(current, this.sessionId));
        allNames.push(segment);
      }

      const existingRows = await tx<{ path: string; node_type: string }[]>`
        SELECT path::text, node_type FROM fs_nodes
        WHERE session_id = ${this.sessionId}
          AND path = ANY(${allLtrees}::ltree[])
      `;
      const existingMap = new Map(existingRows.map(r => [r.path, r.node_type]));

      for (let i = 0; i < allLtrees.length; i++) {
        const nodeType = existingMap.get(allLtrees[i]);
        if (nodeType && nodeType !== "directory") {
          throw new FsError("ENOTDIR", "not a directory, mkdir", allPaths[i]);
        }
      }

      const toCreate: { name: string; ltree: string; parentLtree: string }[] = [];
      for (let i = 0; i < allLtrees.length; i++) {
        if (!existingMap.has(allLtrees[i])) {
          const parentLt = i === 0 ? pathToLtree("/", this.sessionId) : allLtrees[i - 1];
          toCreate.push({ name: allNames[i], ltree: allLtrees[i], parentLtree: parentLt });
        }
      }

      for (const dir of toCreate) {
        await tx`
          INSERT INTO fs_nodes (session_id, parent_id, name, node_type, path, mode)
          SELECT ${this.sessionId}, p.id, ${dir.name}, 'directory', ${dir.ltree}::ltree, ${0o755}
          FROM fs_nodes p
          WHERE p.session_id = ${this.sessionId}
            AND p.path = ${dir.parentLtree}::ltree
          ON CONFLICT (session_id, path) DO NOTHING
        `;
      }
    } else {
      const existing = await this.getNodeMeta(tx, path);
      if (existing) throw new FsError("EEXIST", "file already exists, mkdir", path);
      const parentPosix = this.parentPath(path);
      const parent = await this.getNodeMeta(tx, parentPosix);
      if (!parent) throw new FsError("ENOENT", "no such file or directory, mkdir", path);
      const name = this.fileName(path);
      const lt = pathToLtree(path, this.sessionId);
      await tx`
        INSERT INTO fs_nodes (session_id, parent_id, name, node_type, path, mode)
        VALUES (${this.sessionId}, ${parent.id}, ${name}, 'directory', ${lt}::ltree, ${0o755})
      `;
    }
  }

  // -- Internal readdir (shared by readdir, cp) -------------------------------

  private async internalReaddir(tx: postgres.Sql, path: string): Promise<string[]> {
    const node = await this.getNodeMeta(tx, path);
    if (!node) throw new FsError("ENOENT", "no such file or directory, scandir", path);
    if (node.node_type !== "directory") throw new FsError("ENOTDIR", "not a directory, scandir", path);

    const rows = await tx<{ name: string }[]>`
      SELECT name FROM fs_nodes
      WHERE session_id = ${this.sessionId} AND parent_id = ${node.id}
      ORDER BY name
    `;
    return rows.map(r => r.name);
  }

  // -- Internal cp (recursive, stays in same tx) -----------------------------

  private async internalCp(
    tx: postgres.Sql, src: string, dest: string, options?: CpOptions, counter?: { count: number }
  ): Promise<void> {
    const nodeCounter = counter ?? { count: 0 };

    if (dest.startsWith(src + "/") || dest === src) {
      throw new FsError("EINVAL", "cannot copy to a subdirectory of itself, cp", src);
    }

    const srcNode = await this.getNode(tx, src);
    if (!srcNode) throw new FsError("ENOENT", "no such file or directory, cp", src);

    nodeCounter.count++;
    if (nodeCounter.count > MAX_CP_NODES) {
      throw new Error(`cp: too many nodes (exceeds limit of ${MAX_CP_NODES})`);
    }

    if (srcNode.node_type === "directory") {
      if (!options?.recursive) {
        throw new FsError("EISDIR", "illegal operation on a directory, cp", src);
      }
      await this.internalMkdir(tx, dest, { recursive: true });
      const children = await this.internalReaddir(tx, src);
      for (const child of children) {
        const srcChild = src === "/" ? `/${child}` : `${src}/${child}`;
        const destChild = dest === "/" ? `/${child}` : `${dest}/${child}`;
        await this.internalCp(tx, srcChild, destChild, options, nodeCounter);
      }
      return;
    }

    // Skip re-embedding for copies
    const content = srcNode.content !== null ? srcNode.content : await this.internalReadFileBuffer(tx, src);
    await this.internalWriteFile(tx, dest, content, undefined, null);
  }

  // -- Internal readFileBuffer (shared by readFileBuffer, link, cp) ----------

  private async internalReadFileBuffer(tx: postgres.Sql, path: string): Promise<Uint8Array> {
    const node = await this.resolveSymlink(tx, path);
    if (node.node_type === "directory") throw new FsError("EISDIR", "illegal operation on a directory, read", path);
    if (node.binary_data !== null) return node.binary_data;
    if (node.content !== null) return new TextEncoder().encode(node.content);
    return new Uint8Array(0);
  }

  // -- File I/O ---------------------------------------------------------------

  // Encoding options are ignored; always returns UTF-8 text for interface compatibility.
  async readFile(path: string, _options?: ReadFileOptions | BufferEncoding): Promise<string> {
    return this.withSession(async (tx) => {
      const p = normalizePath(path);
      const node = await this.resolveSymlink(tx, p);
      if (node.node_type === "directory") throw new FsError("EISDIR", "illegal operation on a directory, read", path);
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

  // Encoding options are ignored; content is stored as-is (UTF-8 text or binary) for interface compatibility.
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

  // Encoding options are ignored; content is stored as-is (UTF-8 text or binary) for interface compatibility.
  async appendFile(path: string, content: FileContent, _options?: WriteFileOptions | BufferEncoding): Promise<void> {
    return this.withSession(async (tx) => {
      const p = normalizePath(path);
      const existing = await this.getNodeForUpdate(tx, p);
      if (!existing) {
        await this.internalWriteFile(tx, p, content);
        return;
      }

      const appendSize = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
      if (existing.size_bytes + appendSize > this.maxFileSize) {
        throw new Error(`File too large: ${existing.size_bytes + appendSize} bytes exceeds maximum of ${this.maxFileSize} bytes`);
      }

      if (existing.binary_data !== null || typeof content !== "string") {
        const existingBytes = existing.binary_data ?? (existing.content !== null ? new TextEncoder().encode(existing.content) : new Uint8Array(0));
        const appendBytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
        const merged = new Uint8Array(existingBytes.byteLength + appendBytes.byteLength);
        merged.set(existingBytes, 0);
        merged.set(appendBytes, existingBytes.byteLength);
        await this.internalWriteFile(tx, p, merged);
      } else {
        const currentContent = existing.content ?? "";
        await this.internalWriteFile(tx, p, currentContent + content);
      }
    });
  }

  // -- Path queries -----------------------------------------------------------

  async exists(path: string): Promise<boolean> {
    return this.withSession(async (tx) => {
      const node = await this.getNodeMeta(tx, normalizePath(path));
      return node !== null;
    });
  }

  async stat(path: string): Promise<FsStat> {
    return this.withSession(async (tx) => {
      const node = await this.resolveSymlinkMeta(tx, normalizePath(path));
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
      const node = await this.getNodeMeta(tx, p);
      if (!node) throw new FsError("ENOENT", "no such file or directory, lstat", path);
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
    const node = await this.getNodeMeta(tx, path);
    if (!node) throw new FsError("ENOENT", "no such file or directory, realpath", path);
    if (node.node_type === "symlink" && node.symlink_target) {
      if (maxDepth <= 0) throw new FsError("ELOOP", "too many levels of symbolic links, realpath", path);
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
      const node = await this.getNodeMeta(tx, p);
      if (!node) throw new FsError("ENOENT", "no such file or directory, scandir", path);
      if (node.node_type !== "directory") throw new FsError("ENOTDIR", "not a directory, scandir", path);

      const rows = await tx<{ name: string; node_type: string }[]>`
        SELECT name, node_type FROM fs_nodes
        WHERE session_id = ${this.sessionId} AND parent_id = ${node.id}
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
      const node = await this.getNodeMeta(tx, p);
      if (!node) {
        if (options?.force) return;
        throw new FsError("ENOENT", "no such file or directory, rm", path);
      }

      if (node.node_type === "directory") {
        if (!options?.recursive) {
          const children = await tx`
            SELECT 1 FROM fs_nodes
            WHERE session_id = ${this.sessionId} AND parent_id = ${node.id}
            LIMIT 1
          `;
          if (children.length > 0) {
            throw new FsError("ENOTEMPTY", "directory not empty, rm", path);
          }
        }
      }

      if (options?.recursive && node.node_type === "directory") {
        const lt = pathToLtree(p, this.sessionId);
        await tx`
          DELETE FROM fs_nodes
          WHERE session_id = ${this.sessionId} AND path <@ ${lt}::text::ltree
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

      if (destPath.startsWith(srcPath + "/") || destPath === srcPath) {
        throw new FsError("EINVAL", "cannot move to a subdirectory of itself, mv", src);
      }

      const srcNode = await this.getNodeForUpdate(tx, srcPath);
      if (!srcNode) throw new FsError("ENOENT", "no such file or directory, mv", src);

      const destParentPosix = this.parentPath(destPath);
      const destParent = await this.getNodeMeta(tx, destParentPosix);
      if (!destParent) throw new FsError("ENOENT", "no such file or directory, mv", dest);

      // Handle existing destination
      const destNode = await this.getNodeMeta(tx, destPath);
      if (destNode) {
        if (destNode.node_type === "directory" && srcNode.node_type !== "directory") {
          throw new FsError("EISDIR", "cannot overwrite directory with non-directory, mv", dest);
        }
        if (destNode.node_type !== "directory" && srcNode.node_type === "directory") {
          throw new FsError("ENOTDIR", "cannot overwrite non-directory with directory, mv", dest);
        }
        if (destNode.node_type === "directory") {
          const children = await tx`
            SELECT 1 FROM fs_nodes
            WHERE session_id = ${this.sessionId} AND parent_id = ${destNode.id}
            LIMIT 1
          `;
          if (children.length > 0) {
            throw new FsError("ENOTEMPTY", "directory not empty, mv", dest);
          }
        }
        await tx`
          DELETE FROM fs_nodes
          WHERE session_id = ${this.sessionId} AND id = ${destNode.id}
        `;
      }

      const newName = this.fileName(destPath);
      const newLtree = pathToLtree(destPath, this.sessionId);
      const oldLtree = pathToLtree(srcPath, this.sessionId);

      const updated = await tx`
        UPDATE fs_nodes
        SET name = ${newName}, path = ${newLtree}::ltree, parent_id = ${destParent.id}, mtime = now()
        WHERE session_id = ${this.sessionId} AND id = ${srcNode.id}
      `;
      if (updated.count === 0) {
        throw new FsError("ENOENT", "no such file or directory, mv", src);
      }

      if (srcNode.node_type === "directory") {
        await tx`
          UPDATE fs_nodes
          SET path = (${newLtree}::ltree || subpath(path, nlevel(${oldLtree}::ltree)))
          WHERE session_id = ${this.sessionId}
            AND path <@ ${oldLtree}::text::ltree
        `;

        await tx`
          UPDATE fs_nodes AS child
          SET parent_id = parent.id
          FROM fs_nodes AS parent
          WHERE child.session_id = ${this.sessionId}
            AND parent.session_id = ${this.sessionId}
            AND child.path <@ ${newLtree}::text::ltree
            AND child.path != ${newLtree}::text::ltree
            AND parent.path = subltree(child.path, 0, nlevel(child.path) - 1)
        `;
      }
    });
  }

  async chmod(path: string, mode: number): Promise<void> {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
      throw new Error(`Invalid mode: ${mode} (must be integer between 0 and 4095/0o7777)`);
    }
    return this.withSession(async (tx) => {
      const p = normalizePath(path);
      const node = await this.getNodeMeta(tx, p);
      if (!node) throw new FsError("ENOENT", "no such file or directory, chmod", path);
      await tx`
        UPDATE fs_nodes SET mode = ${mode}
        WHERE session_id = ${this.sessionId} AND id = ${node.id}
      `;
    });
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    return this.withSession(async (tx) => {
      const p = normalizePath(path);
      const node = await this.getNodeMeta(tx, p);
      if (!node) throw new FsError("ENOENT", "no such file or directory, utimes", path);
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
      this.validatePathDepth(normalizedTarget);

      const parentPosix = this.parentPath(p);
      const parent = await this.getNodeMeta(tx, parentPosix);
      if (!parent) throw new FsError("ENOENT", "no such file or directory, symlink", linkPath);

      const name = this.fileName(p);
      const lt = pathToLtree(p, this.sessionId);

      await tx`
        INSERT INTO fs_nodes (session_id, parent_id, name, node_type, path, symlink_target, mode)
        VALUES (${this.sessionId}, ${parent.id}, ${name}, 'symlink', ${lt}::ltree, ${normalizedTarget}, ${0o777})
      `;
    });
  }

  // Creates a copy of the file content rather than a true POSIX hard link (no shared inode).
  async link(existingPath: string, newPath: string): Promise<void> {
    return this.withSession(async (tx) => {
      const src = normalizePath(existingPath);
      const srcNode = await this.getNode(tx, src);
      if (!srcNode) throw new FsError("ENOENT", "no such file or directory, link", existingPath);
      if (srcNode.node_type === "directory") throw new FsError("EPERM", "operation not permitted, link", existingPath);

      const content = srcNode.content !== null ? srcNode.content : await this.internalReadFileBuffer(tx, src);
      await this.internalWriteFile(tx, normalizePath(newPath), content);
    });
  }

  async readlink(path: string): Promise<string> {
    return this.withSession(async (tx) => {
      const p = normalizePath(path);
      const node = await this.getNodeMeta(tx, p);
      if (!node) throw new FsError("ENOENT", "no such file or directory, readlink", path);
      if (node.node_type !== "symlink") throw new FsError("EINVAL", "invalid argument, readlink", path);
      if (node.symlink_target === null) {
        throw new Error(`Corrupt symlink node at '${path}': symlink_target is null`);
      }
      return node.symlink_target;
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
      return fullTextSearch(tx, this.sessionId, query, opts);
    });
  }

  async semanticSearch(query: string, opts?: { path?: string; limit?: number }): Promise<SearchResult[]> {
    if (!this.embed) throw new Error("No embedding provider configured");
    const embedding = await this.embed(query);
    validateEmbedding(embedding, this.embeddingDimensions);
    return this.withSession(async (tx) => {
      return doSemanticSearch(tx, this.sessionId, embedding, opts);
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
      return doHybridSearch(tx, this.sessionId, query, embedding, opts);
    });
  }
}
