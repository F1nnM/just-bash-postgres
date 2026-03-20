import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createTestSql, resetDb } from "./helpers";
import { PgFileSystem } from "../src/pg-filesystem";
import type postgres from "postgres";

describe("RLS Session Isolation", () => {
  let sql: postgres.Sql;
  let fsSession1: PgFileSystem;
  let fsSession2: PgFileSystem;

  beforeAll(() => {
    sql = createTestSql();
  });

  afterAll(async () => {
    await resetDb(sql);
    await sql.end();
  });

  beforeEach(async () => {
    await resetDb(sql);
    fsSession1 = new PgFileSystem({ sql, sessionId: 1 });
    fsSession2 = new PgFileSystem({ sql, sessionId: 2 });
    await fsSession1.setup();
    await fsSession2.setup();
  });

  test("session cannot see other session's files", async () => {
    await fsSession1.writeFile("/secret.txt", "session1 secret");
    await fsSession2.writeFile("/secret.txt", "session2 secret");

    expect(await fsSession1.readFile("/secret.txt")).toBe("session1 secret");
    expect(await fsSession2.readFile("/secret.txt")).toBe("session2 secret");
  });

  test("session cannot list other session's directories", async () => {
    await fsSession1.mkdir("/private");
    await fsSession1.writeFile("/private/data.txt", "secret");

    const entries = await fsSession2.readdir("/");
    expect(entries).not.toContain("private");
  });

  test("session cannot stat other session's files", async () => {
    await fsSession1.writeFile("/hidden.txt", "secret");
    expect(fsSession2.stat("/hidden.txt")).rejects.toThrow("ENOENT");
  });

  test("session file counts are independent", async () => {
    await fsSession1.writeFile("/a.txt", "a");
    await fsSession1.writeFile("/b.txt", "b");
    await fsSession2.writeFile("/x.txt", "x");

    const session1Files = await fsSession1.readdir("/");
    const session2Files = await fsSession2.readdir("/");
    expect(session1Files).toEqual(["a.txt", "b.txt"]);
    expect(session2Files).toEqual(["x.txt"]);
  });

  test("deleting session1's file doesn't affect session2", async () => {
    await fsSession1.writeFile("/shared-name.txt", "session1 data");
    await fsSession2.writeFile("/shared-name.txt", "session2 data");

    await fsSession1.rm("/shared-name.txt");
    expect(await fsSession1.exists("/shared-name.txt")).toBe(false);
    expect(await fsSession2.readFile("/shared-name.txt")).toBe("session2 data");
  });

  test("search is scoped to session", async () => {
    await fsSession1.writeFile("/report.md", "quarterly revenue analysis");
    await fsSession2.writeFile("/notes.md", "quarterly planning notes");

    const results1 = await fsSession1.search("quarterly");
    const results2 = await fsSession2.search("quarterly");

    expect(results1.map(r => r.path)).toEqual(["/report.md"]);
    expect(results2.map(r => r.path)).toEqual(["/notes.md"]);
  });
});
