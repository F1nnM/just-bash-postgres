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
});
