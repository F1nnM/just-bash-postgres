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
import { pathToLtree, ltreeToPath, encodeLabel, decodeLabel } from "./path-encoding";
import { setupSchema, setupVectorColumn } from "./schema";

// These types are used by IFileSystem but not exported from just-bash's public API
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
  userId: number;
  embed?: (text: string) => Promise<number[]>;
  embeddingDimensions?: number;
}

interface FsRow {
  id: number;
  owner_id: number;
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

export class PgFileSystem implements IFileSystem {
  private sql: postgres.Sql;
  private userId: number;
  private embed?: (text: string) => Promise<number[]>;
  private embeddingDimensions?: number;

  constructor(options: PgFileSystemOptions) {
    this.sql = options.sql;
    this.userId = options.userId;
    this.embed = options.embed;
    this.embeddingDimensions = options.embeddingDimensions;
  }

  async setup(): Promise<void> {
    await setupSchema(this.sql);
    if (this.embeddingDimensions) {
      await setupVectorColumn(this.sql, this.embeddingDimensions);
    }
    // Ensure root directory exists for this user
    const rootLtree = pathToLtree("/", this.userId);
    await this.sql`
      INSERT INTO fs_nodes (owner_id, name, node_type, path, mode)
      VALUES (${this.userId}, '/', 'directory', ${rootLtree}::ltree, 755)
      ON CONFLICT (owner_id, path) DO NOTHING
    `;
  }

  private ltree(posixPath: string): string {
    return pathToLtree(posixPath, this.userId);
  }

  private async getNode(posixPath: string): Promise<FsRow | null> {
    const lt = this.ltree(posixPath);
    const rows = await this.sql<FsRow[]>`
      SELECT * FROM fs_nodes
      WHERE owner_id = ${this.userId} AND path = ${lt}::ltree
      LIMIT 1
    `;
    return rows.length > 0 ? rows[0] : null;
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

  // -- File I/O ---------------------------------------------------------------

  async readFile(path: string, options?: ReadFileOptions | BufferEncoding): Promise<string> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    if (node.node_type === "directory") throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);

    if (node.node_type === "symlink") {
      return this.readFile(node.symlink_target!, options);
    }

    if (node.content !== null) return node.content;
    if (node.binary_data !== null) return new TextDecoder().decode(node.binary_data);
    return "";
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    if (node.node_type === "directory") throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);

    if (node.node_type === "symlink") {
      return this.readFileBuffer(node.symlink_target!);
    }

    if (node.binary_data !== null) return node.binary_data;
    if (node.content !== null) return new TextEncoder().encode(node.content);
    return new Uint8Array(0);
  }

  async writeFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const name = this.fileName(path);
    const parentPosix = this.parentPath(path);
    const parent = await this.getNode(parentPosix);
    if (!parent) throw new Error(`ENOENT: no such file or directory, open '${path}'`);

    const lt = this.ltree(path);
    const isText = typeof content === "string";
    const textContent = isText ? content : null;
    const binaryData = isText ? null : content;
    const sizeBytes = isText ? Buffer.byteLength(content) : content.byteLength;

    let embedding: number[] | null = null;
    if (isText && this.embed && content.length > 0) {
      embedding = await this.embed(content);
    }

    if (embedding) {
      const embeddingStr = `[${embedding.join(",")}]`;
      await this.sql`
        INSERT INTO fs_nodes (owner_id, parent_id, name, node_type, path, content, binary_data, size_bytes, mtime, embedding)
        VALUES (${this.userId}, ${parent.id}, ${name}, 'file', ${lt}::ltree, ${textContent}, ${binaryData}, ${sizeBytes}, now(), ${embeddingStr}::vector)
        ON CONFLICT (owner_id, path) DO UPDATE SET
          content = EXCLUDED.content,
          binary_data = EXCLUDED.binary_data,
          size_bytes = EXCLUDED.size_bytes,
          mtime = now(),
          embedding = EXCLUDED.embedding
      `;
    } else {
      await this.sql`
        INSERT INTO fs_nodes (owner_id, parent_id, name, node_type, path, content, binary_data, size_bytes, mtime)
        VALUES (${this.userId}, ${parent.id}, ${name}, 'file', ${lt}::ltree, ${textContent}, ${binaryData}, ${sizeBytes}, now())
        ON CONFLICT (owner_id, path) DO UPDATE SET
          content = EXCLUDED.content,
          binary_data = EXCLUDED.binary_data,
          size_bytes = EXCLUDED.size_bytes,
          mtime = now()
      `;
    }
  }

  async appendFile(path: string, content: FileContent, options?: WriteFileOptions | BufferEncoding): Promise<void> {
    const existing = await this.getNode(path);
    if (!existing) {
      await this.writeFile(path, content, options);
      return;
    }

    const textContent = typeof content === "string" ? content : new TextDecoder().decode(content);
    const currentContent = existing.content ?? "";
    const newContent = currentContent + textContent;
    const sizeBytes = Buffer.byteLength(newContent);

    const lt = this.ltree(path);
    await this.sql`
      UPDATE fs_nodes
      SET content = ${newContent}, size_bytes = ${sizeBytes}, mtime = now()
      WHERE owner_id = ${this.userId} AND path = ${lt}::ltree
    `;
  }

  // -- Path queries ------------------------------------------------------------

  async exists(path: string): Promise<boolean> {
    const node = await this.getNode(path);
    return node !== null;
  }

  async stat(path: string): Promise<FsStat> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, stat '${path}'`);

    return {
      isFile: node.node_type === "file",
      isDirectory: node.node_type === "directory",
      isSymbolicLink: node.node_type === "symlink",
      mode: node.mode,
      size: Number(node.size_bytes),
      mtime: new Date(node.mtime),
    };
  }

  async lstat(path: string): Promise<FsStat> {
    // lstat doesn't follow symlinks -- same as stat for our implementation
    // since stat on a symlink node already returns isSymbolicLink: true
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);

    return {
      isFile: node.node_type === "file",
      isDirectory: node.node_type === "directory",
      isSymbolicLink: node.node_type === "symlink",
      mode: node.mode,
      size: Number(node.size_bytes),
      mtime: new Date(node.mtime),
    };
  }

  async realpath(path: string): Promise<string> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    if (node.node_type === "symlink" && node.symlink_target) {
      return this.realpath(node.symlink_target);
    }
    return path;
  }

  // -- Directory operations ----------------------------------------------------

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const recursive = options?.recursive ?? false;

    if (recursive) {
      const segments = path.split("/").filter(Boolean);
      let current = "/";
      for (const segment of segments) {
        const parentPosix = current;
        current = current === "/" ? `/${segment}` : `${current}/${segment}`;
        const existing = await this.getNode(current);
        if (existing) {
          if (existing.node_type !== "directory") {
            throw new Error(`ENOTDIR: not a directory, mkdir '${current}'`);
          }
          continue;
        }
        const parent = await this.getNode(parentPosix);
        if (!parent) throw new Error(`ENOENT: no such file or directory, mkdir '${current}'`);
        const lt = this.ltree(current);
        await this.sql`
          INSERT INTO fs_nodes (owner_id, parent_id, name, node_type, path, mode)
          VALUES (${this.userId}, ${parent.id}, ${segment}, 'directory', ${lt}::ltree, 755)
          ON CONFLICT (owner_id, path) DO NOTHING
        `;
      }
    } else {
      const existing = await this.getNode(path);
      if (existing) throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
      const parentPosix = this.parentPath(path);
      const parent = await this.getNode(parentPosix);
      if (!parent) throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      const name = this.fileName(path);
      const lt = this.ltree(path);
      await this.sql`
        INSERT INTO fs_nodes (owner_id, parent_id, name, node_type, path, mode)
        VALUES (${this.userId}, ${parent.id}, ${name}, 'directory', ${lt}::ltree, 755)
      `;
    }
  }

  async readdir(path: string): Promise<string[]> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    if (node.node_type !== "directory") throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);

    const lt = this.ltree(path);
    const depth = lt.split(".").length + 1;
    const rows = await this.sql<{ name: string }[]>`
      SELECT name FROM fs_nodes
      WHERE owner_id = ${this.userId}
        AND path <@ ${lt}::ltree
        AND nlevel(path) = ${depth}
      ORDER BY name
    `;
    return rows.map(r => r.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    if (node.node_type !== "directory") throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);

    const lt = this.ltree(path);
    const depth = lt.split(".").length + 1;
    const rows = await this.sql<{ name: string; node_type: string }[]>`
      SELECT name, node_type FROM fs_nodes
      WHERE owner_id = ${this.userId}
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
  }

  // -- Mutation ----------------------------------------------------------------

  async rm(path: string, options?: RmOptions): Promise<void> {
    const node = await this.getNode(path);
    if (!node) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }

    if (node.node_type === "directory") {
      if (!options?.recursive) {
        // Check if directory has children
        const children = await this.sql`
          SELECT 1 FROM fs_nodes
          WHERE owner_id = ${this.userId} AND parent_id = ${node.id}
          LIMIT 1
        `;
        if (children.length > 0) {
          throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
        }
      }
    }

    // Delete node and all descendants (CASCADE handles children via parent_id,
    // but we also need to handle ltree descendants for recursive)
    if (options?.recursive && node.node_type === "directory") {
      const lt = this.ltree(path);
      await this.sql`
        DELETE FROM fs_nodes
        WHERE owner_id = ${this.userId} AND path <@ ${lt}::ltree
      `;
    } else {
      await this.sql`
        DELETE FROM fs_nodes
        WHERE owner_id = ${this.userId} AND id = ${node.id}
      `;
    }
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcNode = await this.getNode(src);
    if (!srcNode) throw new Error(`ENOENT: no such file or directory, cp '${src}'`);

    if (srcNode.node_type === "directory") {
      if (!options?.recursive) {
        throw new Error(`EISDIR: illegal operation on a directory, cp '${src}'`);
      }
      // Recursive copy
      await this.mkdir(dest, { recursive: true });
      const children = await this.readdir(src);
      for (const child of children) {
        const srcChild = src === "/" ? `/${child}` : `${src}/${child}`;
        const destChild = dest === "/" ? `/${child}` : `${dest}/${child}`;
        await this.cp(srcChild, destChild, options);
      }
      return;
    }

    // Copy file
    const content = srcNode.content !== null ? srcNode.content : await this.readFileBuffer(src);
    await this.writeFile(dest, content);
  }

  async mv(src: string, dest: string): Promise<void> {
    const srcNode = await this.getNode(src);
    if (!srcNode) throw new Error(`ENOENT: no such file or directory, mv '${src}'`);

    const destParentPosix = this.parentPath(dest);
    const destParent = await this.getNode(destParentPosix);
    if (!destParent) throw new Error(`ENOENT: no such file or directory, mv '${dest}'`);

    const newName = this.fileName(dest);
    const newLtree = this.ltree(dest);
    const oldLtree = this.ltree(src);

    if (srcNode.node_type === "directory") {
      // Update all descendants' paths
      const oldPrefix = oldLtree;
      const newPrefix = newLtree;
      // Update descendants first (those whose path starts with old path)
      await this.sql`
        UPDATE fs_nodes
        SET path = (${newPrefix}::ltree || subpath(path, nlevel(${oldPrefix}::ltree)))
        WHERE owner_id = ${this.userId}
          AND path <@ ${oldPrefix}::ltree
          AND path != ${oldPrefix}::ltree
      `;
    }

    // Update the node itself
    await this.sql`
      UPDATE fs_nodes
      SET name = ${newName}, path = ${newLtree}::ltree, parent_id = ${destParent.id}, mtime = now()
      WHERE owner_id = ${this.userId} AND id = ${srcNode.id}
    `;
  }

  async chmod(path: string, mode: number): Promise<void> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);

    await this.sql`
      UPDATE fs_nodes SET mode = ${mode}
      WHERE owner_id = ${this.userId} AND id = ${node.id}
    `;
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);

    await this.sql`
      UPDATE fs_nodes SET mtime = ${mtime}
      WHERE owner_id = ${this.userId} AND id = ${node.id}
    `;
  }

  // -- Links -------------------------------------------------------------------

  async symlink(target: string, linkPath: string): Promise<void> {
    const parentPosix = this.parentPath(linkPath);
    const parent = await this.getNode(parentPosix);
    if (!parent) throw new Error(`ENOENT: no such file or directory, symlink '${linkPath}'`);

    const name = this.fileName(linkPath);
    const lt = this.ltree(linkPath);

    await this.sql`
      INSERT INTO fs_nodes (owner_id, parent_id, name, node_type, path, symlink_target, mode)
      VALUES (${this.userId}, ${parent.id}, ${name}, 'symlink', ${lt}::ltree, ${target}, 777)
    `;
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    // Hard links: copy the content (PostgreSQL doesn't have real hard links)
    const srcNode = await this.getNode(existingPath);
    if (!srcNode) throw new Error(`ENOENT: no such file or directory, link '${existingPath}'`);
    if (srcNode.node_type === "directory") throw new Error(`EPERM: operation not permitted, link '${existingPath}'`);

    const content = srcNode.content !== null ? srcNode.content : await this.readFileBuffer(existingPath);
    await this.writeFile(newPath, content);
  }

  async readlink(path: string): Promise<string> {
    const node = await this.getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    if (node.node_type !== "symlink") throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    return node.symlink_target!;
  }

  // -- Utility -----------------------------------------------------------------

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) return normalizePath(path);
    if (base === "/") return normalizePath("/" + path);
    return normalizePath(base + "/" + path);
  }

  getAllPaths(): string[] {
    // Synchronous -- cannot query DB. Return empty as AgentFS does.
    return [];
  }
}

function normalizePath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") { resolved.pop(); continue; }
    resolved.push(part);
  }
  return "/" + resolved.join("/");
}
