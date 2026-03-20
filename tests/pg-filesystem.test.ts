import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createTestSql, resetDb } from "./helpers";
import { PgFileSystem } from "../src/pg-filesystem";
import type postgres from "postgres";

describe("PgFileSystem", () => {
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
    fs = new PgFileSystem({ sql, userId: 1 });
    await fs.setup();
  });

  describe("writeFile + readFile", () => {
    test("writes and reads text file", async () => {
      await fs.writeFile("/hello.txt", "world");
      const content = await fs.readFile("/hello.txt");
      expect(content).toBe("world");
    });

    test("writes and reads nested file", async () => {
      await fs.mkdir("/docs", { recursive: true });
      await fs.writeFile("/docs/readme.md", "# Hello");
      const content = await fs.readFile("/docs/readme.md");
      expect(content).toBe("# Hello");
    });

    test("overwrites existing file", async () => {
      await fs.writeFile("/test.txt", "first");
      await fs.writeFile("/test.txt", "second");
      expect(await fs.readFile("/test.txt")).toBe("second");
    });

    test("throws ENOENT for non-existent file", async () => {
      expect(fs.readFile("/nope.txt")).rejects.toThrow("ENOENT");
    });
  });

  describe("readFileBuffer", () => {
    test("reads text as buffer", async () => {
      await fs.writeFile("/hello.txt", "world");
      const buf = await fs.readFileBuffer("/hello.txt");
      expect(buf).toBeInstanceOf(Uint8Array);
      expect(new TextDecoder().decode(buf)).toBe("world");
    });

    test("reads binary data", async () => {
      const data = new Uint8Array([0x00, 0x01, 0xff, 0xfe]);
      await fs.writeFile("/bin.dat", data);
      const buf = await fs.readFileBuffer("/bin.dat");
      expect(buf).toEqual(data);
    });
  });

  describe("appendFile", () => {
    test("appends to existing file", async () => {
      await fs.writeFile("/log.txt", "line1\n");
      await fs.appendFile("/log.txt", "line2\n");
      expect(await fs.readFile("/log.txt")).toBe("line1\nline2\n");
    });

    test("creates file if not exists", async () => {
      await fs.appendFile("/new.txt", "content");
      expect(await fs.readFile("/new.txt")).toBe("content");
    });
  });

  describe("exists", () => {
    test("returns false for non-existent path", async () => {
      expect(await fs.exists("/nope")).toBe(false);
    });

    test("returns true for existing file", async () => {
      await fs.writeFile("/test.txt", "hi");
      expect(await fs.exists("/test.txt")).toBe(true);
    });

    test("returns true for directory", async () => {
      await fs.mkdir("/mydir");
      expect(await fs.exists("/mydir")).toBe(true);
    });
  });

  describe("stat", () => {
    test("returns file stat", async () => {
      await fs.writeFile("/test.txt", "hello");
      const s = await fs.stat("/test.txt");
      expect(s.isFile).toBe(true);
      expect(s.isDirectory).toBe(false);
      expect(s.isSymbolicLink).toBe(false);
      expect(s.size).toBe(5);
      expect(s.mtime).toBeInstanceOf(Date);
    });

    test("returns directory stat", async () => {
      await fs.mkdir("/mydir");
      const s = await fs.stat("/mydir");
      expect(s.isFile).toBe(false);
      expect(s.isDirectory).toBe(true);
    });

    test("throws ENOENT for non-existent", async () => {
      expect(fs.stat("/nope")).rejects.toThrow("ENOENT");
    });
  });

  describe("mkdir", () => {
    test("creates a directory", async () => {
      await fs.mkdir("/newdir");
      const s = await fs.stat("/newdir");
      expect(s.isDirectory).toBe(true);
    });

    test("recursive creates nested dirs", async () => {
      await fs.mkdir("/a/b/c", { recursive: true });
      expect(await fs.exists("/a")).toBe(true);
      expect(await fs.exists("/a/b")).toBe(true);
      expect(await fs.exists("/a/b/c")).toBe(true);
    });

    test("throws EEXIST for existing dir without recursive", async () => {
      await fs.mkdir("/mydir");
      expect(fs.mkdir("/mydir")).rejects.toThrow("EEXIST");
    });

    test("recursive is idempotent", async () => {
      await fs.mkdir("/mydir", { recursive: true });
      await fs.mkdir("/mydir", { recursive: true }); // no throw
    });
  });

  describe("readdir", () => {
    test("lists immediate children", async () => {
      await fs.mkdir("/parent");
      await fs.writeFile("/parent/a.txt", "a");
      await fs.writeFile("/parent/b.txt", "b");
      await fs.mkdir("/parent/sub");
      const entries = await fs.readdir("/parent");
      expect(entries.sort()).toEqual(["a.txt", "b.txt", "sub"]);
    });

    test("does not list grandchildren", async () => {
      await fs.mkdir("/parent/sub", { recursive: true });
      await fs.writeFile("/parent/sub/deep.txt", "deep");
      await fs.writeFile("/parent/top.txt", "top");
      const entries = await fs.readdir("/parent");
      expect(entries.sort()).toEqual(["sub", "top.txt"]);
    });

    test("throws ENOENT for non-existent dir", async () => {
      expect(fs.readdir("/nope")).rejects.toThrow("ENOENT");
    });
  });

  describe("readdirWithFileTypes", () => {
    test("returns typed entries", async () => {
      await fs.mkdir("/parent");
      await fs.writeFile("/parent/file.txt", "hi");
      await fs.mkdir("/parent/dir");
      const entries = await fs.readdirWithFileTypes!("/parent");
      const file = entries.find(e => e.name === "file.txt")!;
      const dir = entries.find(e => e.name === "dir")!;
      expect(file.isFile).toBe(true);
      expect(dir.isDirectory).toBe(true);
    });
  });

  describe("rm", () => {
    test("removes a file", async () => {
      await fs.writeFile("/doomed.txt", "bye");
      await fs.rm("/doomed.txt");
      expect(await fs.exists("/doomed.txt")).toBe(false);
    });

    test("removes empty directory", async () => {
      await fs.mkdir("/empty");
      await fs.rm("/empty");
      expect(await fs.exists("/empty")).toBe(false);
    });

    test("throws ENOTEMPTY for non-empty dir without recursive", async () => {
      await fs.mkdir("/full");
      await fs.writeFile("/full/file.txt", "hi");
      expect(fs.rm("/full")).rejects.toThrow("ENOTEMPTY");
    });

    test("recursive removes dir and contents", async () => {
      await fs.mkdir("/tree/sub", { recursive: true });
      await fs.writeFile("/tree/sub/file.txt", "data");
      await fs.rm("/tree", { recursive: true });
      expect(await fs.exists("/tree")).toBe(false);
      expect(await fs.exists("/tree/sub")).toBe(false);
    });

    test("force ignores non-existent", async () => {
      await fs.rm("/nope", { force: true }); // no throw
    });
  });

  describe("cp", () => {
    test("copies a file", async () => {
      await fs.writeFile("/src.txt", "data");
      await fs.cp("/src.txt", "/dst.txt");
      expect(await fs.readFile("/dst.txt")).toBe("data");
    });

    test("recursive copies directory", async () => {
      await fs.mkdir("/srcdir");
      await fs.writeFile("/srcdir/a.txt", "a");
      await fs.cp("/srcdir", "/dstdir", { recursive: true });
      expect(await fs.readFile("/dstdir/a.txt")).toBe("a");
    });
  });

  describe("mv", () => {
    test("renames a file", async () => {
      await fs.writeFile("/old.txt", "data");
      await fs.mv("/old.txt", "/new.txt");
      expect(await fs.exists("/old.txt")).toBe(false);
      expect(await fs.readFile("/new.txt")).toBe("data");
    });

    test("moves file to different directory", async () => {
      await fs.mkdir("/target");
      await fs.writeFile("/src.txt", "data");
      await fs.mv("/src.txt", "/target/moved.txt");
      expect(await fs.readFile("/target/moved.txt")).toBe("data");
    });

    test("moves directory with descendants", async () => {
      await fs.mkdir("/srcdir/sub", { recursive: true });
      await fs.writeFile("/srcdir/sub/file.txt", "data");
      await fs.mkdir("/dest");
      await fs.mv("/srcdir", "/dest/moved");
      expect(await fs.readFile("/dest/moved/sub/file.txt")).toBe("data");
    });
  });

  describe("chmod", () => {
    test("changes file mode", async () => {
      await fs.writeFile("/test.txt", "hi");
      await fs.chmod("/test.txt", 755);
      const s = await fs.stat("/test.txt");
      expect(s.mode).toBe(755);
    });
  });

  describe("utimes", () => {
    test("updates mtime", async () => {
      await fs.writeFile("/test.txt", "hi");
      const date = new Date("2020-01-01T00:00:00Z");
      await fs.utimes("/test.txt", date, date);
      const s = await fs.stat("/test.txt");
      expect(s.mtime.getTime()).toBe(date.getTime());
    });
  });

  describe("symlink + readlink + lstat", () => {
    test("creates and reads symlink", async () => {
      await fs.writeFile("/target.txt", "real content");
      await fs.symlink("/target.txt", "/link.txt");
      expect(await fs.readlink("/link.txt")).toBe("/target.txt");
    });

    test("readFile follows symlink", async () => {
      await fs.writeFile("/target.txt", "real content");
      await fs.symlink("/target.txt", "/link.txt");
      expect(await fs.readFile("/link.txt")).toBe("real content");
    });

    test("lstat returns symlink info", async () => {
      await fs.writeFile("/target.txt", "real content");
      await fs.symlink("/target.txt", "/link.txt");
      const s = await fs.lstat("/link.txt");
      expect(s.isSymbolicLink).toBe(true);
    });

    test("throws ELOOP on symlink cycle", async () => {
      await fs.symlink("/b.txt", "/a.txt");
      await fs.symlink("/a.txt", "/b.txt");
      expect(fs.readFile("/a.txt")).rejects.toThrow("ELOOP");
    });
  });

  describe("link (hard link)", () => {
    test("creates a copy", async () => {
      await fs.writeFile("/orig.txt", "data");
      await fs.link("/orig.txt", "/hardlink.txt");
      expect(await fs.readFile("/hardlink.txt")).toBe("data");
    });
  });

  describe("realpath", () => {
    test("resolves non-symlink as-is", async () => {
      await fs.writeFile("/test.txt", "hi");
      expect(await fs.realpath("/test.txt")).toBe("/test.txt");
    });

    test("resolves through symlink", async () => {
      await fs.writeFile("/target.txt", "hi");
      await fs.symlink("/target.txt", "/link.txt");
      expect(await fs.realpath("/link.txt")).toBe("/target.txt");
    });
  });

  describe("resolvePath", () => {
    test("resolves absolute path", () => {
      expect(fs.resolvePath("/home", "/etc/file")).toBe("/etc/file");
    });

    test("resolves relative path", () => {
      expect(fs.resolvePath("/home/user", "docs/file.txt")).toBe("/home/user/docs/file.txt");
    });

    test("resolves .. segments", () => {
      expect(fs.resolvePath("/home/user", "../other/file")).toBe("/home/other/file");
    });

    test("resolves . segments", () => {
      expect(fs.resolvePath("/home", "./file")).toBe("/home/file");
    });
  });
});
