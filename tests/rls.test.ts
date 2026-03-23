import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { createTestSql, createTestAppSql, resetDb } from "./helpers";
import { PgFileSystem } from "../src/pg-filesystem";
import type postgres from "postgres";

describe("RLS Session Isolation (application layer)", () => {
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

describe("RLS Database-Level Enforcement", () => {
  let adminSql: postgres.Sql;
  let appSql: postgres.Sql;

  beforeAll(() => {
    adminSql = createTestSql();
    appSql = createTestAppSql();
  });

  afterAll(async () => {
    await resetDb(adminSql);
    await appSql.end();
    await adminSql.end();
  });

  beforeEach(async () => {
    await resetDb(adminSql);
    // Setup schema as admin (creates table, RLS policies, and grants to fs_app)
    const adminFs = new PgFileSystem({ sql: adminSql, sessionId: 1 });
    await adminFs.setup();
  });

  test("direct query without session_id returns no rows", async () => {
    // Write data as admin
    const adminFs = new PgFileSystem({ sql: adminSql, sessionId: 1 });
    await adminFs.writeFile("/secret.txt", "secret data");

    // Direct query as fs_app without setting session_id sees nothing (RLS blocks)
    const rows = await appSql`SELECT * FROM fs_nodes`;
    expect(rows.length).toBe(0);
  });

  test("fs_app with correct session_id can read own data", async () => {
    // Setup session 1's root directory via admin, then use app role for operations
    const adminFs = new PgFileSystem({ sql: adminSql, sessionId: 1 });
    await adminFs.setup();

    const appFs = new PgFileSystem({ sql: appSql, sessionId: 1 });
    await appFs.writeFile("/visible.txt", "visible data");

    expect(await appFs.readFile("/visible.txt")).toBe("visible data");
  });

  test("fs_app cannot read other session's data even with direct SQL", async () => {
    // Setup both sessions via admin
    const adminFs2 = new PgFileSystem({ sql: adminSql, sessionId: 2 });
    await adminFs2.setup();

    const appFs1 = new PgFileSystem({ sql: appSql, sessionId: 1 });
    const appFs2 = new PgFileSystem({ sql: appSql, sessionId: 2 });

    await appFs1.writeFile("/secret.txt", "session1 data");

    // Session 2 filesystem cannot see session 1's file
    expect(await appFs2.exists("/secret.txt")).toBe(false);

    // Direct SQL as session 2 also cannot see session 1's data
    const rows = await appSql.begin(async (tx: any) => {
      await tx`SELECT set_config('app.session_id', '2', true)`;
      return tx`SELECT * FROM fs_nodes WHERE session_id = 1`;
    });
    expect(rows.length).toBe(0);
  });

  test("fs_app cannot insert rows for another session", async () => {
    // Try to insert a row with a different session_id via direct SQL
    // RLS WITH CHECK prevents inserting rows where session_id != app.session_id
    expect(
      appSql.begin(async (tx: any) => {
        await tx`SELECT set_config('app.session_id', '1', true)`;
        await tx`
          INSERT INTO fs_nodes (session_id, name, node_type, path, mode)
          VALUES (999, 'hack', 'file', 's999.hack'::ltree, 644)
        `;
      })
    ).rejects.toThrow("row-level security");
  });
});
