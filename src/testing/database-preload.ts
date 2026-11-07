import { reserveDatabaseTestWorker } from "./test-databases.ts";

// Executed only by the explicit owned native test child, never ordinary CLI startup.
try {
  const run = process.env.BUNDLE_TEST_DATABASE_RUN;
  if (!run) throw new Error("Missing owned test run.");
  const worker = await reserveDatabaseTestWorker(run);
  Object.assign(process.env, worker.environment);
  await worker.initialize();
} catch {
  throw new Error("Isolated SQLite test database setup failed.");
}
