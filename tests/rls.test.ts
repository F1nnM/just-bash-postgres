import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createTestSql, resetDb } from "./helpers";
import { PgFileSystem } from "../src/pg-filesystem";
import type postgres from "postgres";

describe("RLS User Isolation", () => {
  let sql: postgres.Sql;
  let fsUser1: PgFileSystem;
  let fsUser2: PgFileSystem;

  beforeAll(() => {
    sql = createTestSql();
  });

  afterAll(async () => {
    await resetDb(sql);
    await sql.end();
  });

  beforeEach(async () => {
    await resetDb(sql);
    fsUser1 = new PgFileSystem({ sql, userId: 1 });
    fsUser2 = new PgFileSystem({ sql, userId: 2 });
    await fsUser1.setup();
    await fsUser2.setup();
  });

  test("user cannot see other user's files", async () => {
    await fsUser1.writeFile("/secret.txt", "user1 secret");
    await fsUser2.writeFile("/secret.txt", "user2 secret");

    expect(await fsUser1.readFile("/secret.txt")).toBe("user1 secret");
    expect(await fsUser2.readFile("/secret.txt")).toBe("user2 secret");
  });

  test("user cannot list other user's directories", async () => {
    await fsUser1.mkdir("/private");
    await fsUser1.writeFile("/private/data.txt", "secret");

    const entries = await fsUser2.readdir("/");
    expect(entries).not.toContain("private");
  });

  test("user cannot stat other user's files", async () => {
    await fsUser1.writeFile("/hidden.txt", "secret");
    expect(fsUser2.stat("/hidden.txt")).rejects.toThrow("ENOENT");
  });

  test("user file counts are independent", async () => {
    await fsUser1.writeFile("/a.txt", "a");
    await fsUser1.writeFile("/b.txt", "b");
    await fsUser2.writeFile("/x.txt", "x");

    const user1Files = await fsUser1.readdir("/");
    const user2Files = await fsUser2.readdir("/");
    expect(user1Files).toEqual(["a.txt", "b.txt"]);
    expect(user2Files).toEqual(["x.txt"]);
  });

  test("deleting user1's file doesn't affect user2", async () => {
    await fsUser1.writeFile("/shared-name.txt", "user1 data");
    await fsUser2.writeFile("/shared-name.txt", "user2 data");

    await fsUser1.rm("/shared-name.txt");
    expect(await fsUser1.exists("/shared-name.txt")).toBe(false);
    expect(await fsUser2.readFile("/shared-name.txt")).toBe("user2 data");
  });

  test("search is scoped to user", async () => {
    await fsUser1.writeFile("/report.md", "quarterly revenue analysis");
    await fsUser2.writeFile("/notes.md", "quarterly planning notes");

    const results1 = await fsUser1.search("quarterly");
    const results2 = await fsUser2.search("quarterly");

    expect(results1.map(r => r.path)).toEqual(["/report.md"]);
    expect(results2.map(r => r.path)).toEqual(["/notes.md"]);
  });
});
