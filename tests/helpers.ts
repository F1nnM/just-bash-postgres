import postgres from "postgres";

const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:5433/just_bash_postgres_test";
// When connecting via Unix socket, use the container's internal port (5432), not the host mapping port
const TEST_PG_SOCKET_PORT = parseInt(process.env.TEST_PG_SOCKET_PORT || "5432");

function getDbName(): string {
  const url = new URL(TEST_DB_URL);
  const dbName = url.pathname.slice(1) || "just_bash_postgres_test";
  if (!dbName.includes("test")) {
    throw new Error(`Refusing to run tests against non-test database: "${dbName}". Database name must contain "test".`);
  }
  return dbName;
}

export function createTestSql() {
  const dbName = getDbName();
  const url = new URL(TEST_DB_URL);
  const socketDir = process.env.TEST_PG_SOCKET_DIR;
  const onnotice = () => {};
  if (socketDir) {
    return postgres({
      host: socketDir,
      port: TEST_PG_SOCKET_PORT,
      database: dbName,
      username: url.username || "postgres",
      password: url.password || undefined,
      onnotice,
    });
  }
  return postgres(TEST_DB_URL, { onnotice });
}

export function createTestAppSql() {
  const dbName = getDbName();
  const socketDir = process.env.TEST_PG_SOCKET_DIR;
  const onnotice = () => {};
  if (socketDir) {
    return postgres({
      host: socketDir,
      port: TEST_PG_SOCKET_PORT,
      database: dbName,
      username: "fs_app",
      onnotice,
    });
  }
  const appUrl = new URL(TEST_DB_URL);
  appUrl.username = "fs_app";
  return postgres(appUrl.toString(), { onnotice });
}

export async function resetDb(sql: postgres.Sql) {
  await sql`DROP TABLE IF EXISTS fs_nodes CASCADE`;
}
