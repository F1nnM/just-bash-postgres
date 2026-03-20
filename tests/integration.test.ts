import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Bash } from "just-bash";
import { createTestSql, resetDb } from "./helpers";
import { PgFileSystem } from "../src/pg-filesystem";
import type postgres from "postgres";

describe("just-bash integration", () => {
  let sql: postgres.Sql;
  let pgFs: PgFileSystem;
  let bash: InstanceType<typeof Bash>;

  beforeAll(() => {
    sql = createTestSql();
  });

  afterAll(async () => {
    await resetDb(sql);
    await sql.end();
  });

  beforeEach(async () => {
    await resetDb(sql);
    pgFs = new PgFileSystem({ sql, userId: 1 });
    await pgFs.setup();
    bash = new Bash({ fs: pgFs, cwd: "/", defenseInDepth: false });
  });

  test("echo writes to file via bash", async () => {
    await bash.exec('echo "hello world" > /greeting.txt');
    const content = await pgFs.readFile("/greeting.txt");
    expect(content.trim()).toBe("hello world");
  });

  test("cat reads file via bash", async () => {
    await pgFs.writeFile("/test.txt", "file content here");
    const result = await bash.exec("cat /test.txt");
    expect(result.stdout.trim()).toBe("file content here");
  });

  test("mkdir + ls works", async () => {
    await bash.exec("mkdir -p /mydir/sub");
    await bash.exec('echo "a" > /mydir/file1.txt');
    await bash.exec('echo "b" > /mydir/file2.txt');
    const result = await bash.exec("ls /mydir");
    const entries = result.stdout.trim().split("\n").sort();
    expect(entries).toContain("file1.txt");
    expect(entries).toContain("file2.txt");
    expect(entries).toContain("sub");
  });

  test("rm removes files", async () => {
    await bash.exec('echo "doomed" > /temp.txt');
    await bash.exec("rm /temp.txt");
    const result = await bash.exec("ls /");
    expect(result.stdout).not.toContain("temp.txt");
  });

  test("mv renames files", async () => {
    await bash.exec('echo "data" > /old.txt');
    await bash.exec("mv /old.txt /new.txt");
    const result = await bash.exec("cat /new.txt");
    expect(result.stdout.trim()).toBe("data");
  });

  test("cp copies files", async () => {
    await bash.exec('echo "original" > /src.txt');
    await bash.exec("cp /src.txt /dst.txt");
    const result = await bash.exec("cat /dst.txt");
    expect(result.stdout.trim()).toBe("original");
  });
});
