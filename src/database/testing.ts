import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { projectRoot, type DatabaseConnection, type Environment } from "./config.ts";

/** Isolated fixtures stay under the project so copied TS files resolve its dependencies. */
export async function databaseFixture(connection: DatabaseConnection = "sqlite", url?: string) {
  const directory = join(projectRoot, ".data");
  await mkdir(directory, { recursive: true });
  const root = await mkdtemp(join(directory, "orm-test-"));
  try {
    await cp(join(projectRoot, "src/models"), join(root, "src/models"), { recursive: true });
    await cp(join(projectRoot, "database/migrations", connection), join(root, "database/migrations", connection), { recursive: true });
    await cp(join(projectRoot, "database/seeders"), join(root, "database/seeders"), { recursive: true });
    const env: Environment = {
      DB_CONNECTION: connection,
      ...(url ? { DATABASE_URL: url } : { DB_DATABASE: "test.sqlite" }),
    };
    return { root, env, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
