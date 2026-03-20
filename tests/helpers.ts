import postgres from "postgres";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5433/just_bash_postgres_test";

export function createTestSql() {
  const url = new URL(TEST_DB_URL);
  // Safety: refuse to run against a non-test database
  const dbName = url.pathname.slice(1) || "just_bash_postgres_test";
  if (!dbName.includes("test")) {
    throw new Error(`Refusing to run tests against non-test database: "${dbName}". Database name must contain "test".`);
  }

  const socketDir = process.env.TEST_PG_SOCKET_DIR;
  const onnotice = () => {};
  if (socketDir) {
    return postgres({
      host: socketDir,
      port: parseInt(url.port || "5432"),
      database: dbName,
      username: url.username || "postgres",
      password: url.password || undefined,
      onnotice,
    });
  }
  return postgres(TEST_DB_URL, { onnotice });
}

export async function resetDb(sql: postgres.Sql) {
  await sql`DROP TABLE IF EXISTS fs_nodes CASCADE`;
}
