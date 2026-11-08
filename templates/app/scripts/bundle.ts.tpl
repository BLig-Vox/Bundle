import { fileURLToPath } from "node:url";
import { createCli, safeError } from "bundle/src/cli/program.ts";

// Always use this app's models, migrations and route manifest, regardless of cwd.
const root = fileURLToPath(new URL("../", import.meta.url));
try {
  const args = process.argv.slice(2);
  await createCli({ root }).parseAsync(args.length ? args : ["list"], { from: "user" });
} catch (error) {
  if (error && typeof error === "object" && "exitCode" in error && typeof error.exitCode === "number") process.exitCode = error.exitCode;
  else { console.error(`Error: ${safeError(error)}`); process.exitCode = 1; }
}
