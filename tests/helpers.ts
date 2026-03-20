import postgres from "postgres";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5433/just_bash_postgres_test";

export function createTestSql() {
  const url = new URL(TEST_DB_URL);
  const socketDir = process.env.TEST_PG_SOCKET_DIR;
  const onnotice = () => {}; // suppress NOTICE messages in tests
  if (socketDir) {
    return postgres({
      host: socketDir,
      port: parseInt(url.port || "5432"),
      database: url.pathname.slice(1) || "just_bash_postgres_test",
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
