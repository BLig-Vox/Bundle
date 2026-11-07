import { afterEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerInformation } from "./information.ts";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bundle-information-"));
  roots.push(root);
  await mkdir(join(root, "docs"));
  await writeFile(join(root, "README.md"), "# Fixture\n");
  await writeFile(join(root, "docs", "database.md"), "# Database\n");
  await writeFile(join(root, "docs", "migrations.md"), "# Migrations\n");
  const output: string[] = [];
  let databaseReads = 0;
  const run = async (args: string[], opener?: readonly string[]) => {
    const program = new Command("bundle").allowExcessArguments(false).exitOverride().configureOutput({ writeErr: () => {} });
    registerInformation(program, {
      root, env: { APP_NAME: "Fixture App", APP_ENV: "staging", APP_DEBUG: "false", DB_PASSWORD: "never-echo-this" },
      output: text => output.push(text), version: "0.1.0",
      database: async () => { databaseReads++; return { connection: "sqlite", database: "fixture.sqlite", migrationsPath: "database/migrations/sqlite" }; },
      documentationOpener: opener,
    });
    await program.parseAsync(args, { from: "user" });
    return output.at(-1)!;
  };
  return { root, output, run, databaseReads: () => databaseReads };
}

describe("application information and local documentation", () => {
  test("about reports actual supplied environment without exposing secrets or connecting", async () => {
    const { run, databaseReads } = await fixture();
    const value = JSON.parse(await run(["about"]));
    expect(value.name).toBe("Bundle");
    expect(value.version).toBe("0.1.0");
    expect(value.runtime).toContain("Bun");
    expect(value.environment.application).toBe("Fixture App");
    expect(value.environment.name).toBe("staging");
    expect(value.environment.debug).toBe(false);
    expect(value.database.connection).toBe("sqlite");
    expect(JSON.stringify(value)).not.toContain("never-echo-this");
    expect(databaseReads()).toBe(1);
  });

  test("about section filtering skips unselected database configuration and detects cache state", async () => {
    const { root, run, databaseReads } = await fixture();
    const environment = JSON.parse(await run(["about", "--only", "environment"]));
    expect(environment.environment.name).toBe("staging");
    expect(environment.database).toBeUndefined();
    expect(databaseReads()).toBe(0);
    await mkdir(join(root, "bootstrap", "cache"), { recursive: true });
    await writeFile(join(root, "bootstrap", "cache", "config.json"), "{}");
    expect(JSON.parse(await run(["about", "--only", "cache"])).cache.configuration).toBe("present");
    await expect(run(["about", "--only", "password"])).rejects.toThrow("section");
  });

  test("docs lists safe local Markdown pages and resolves a selected file without launching", async () => {
    const { root, run } = await fixture();
    expect(JSON.parse(await run(["docs", "--list", "--json"]))).toEqual(["database", "migrations", "readme"]);
    expect(JSON.parse(await run(["docs", "migrations", "--json"]))).toEqual({ page: "migrations", path: join(root, "docs", "migrations.md"), opened: false });
    expect(await run(["docs"])).toContain(join(root, "README.md"));
  });

  test("explicit docs opening passes only a validated local file to a native subprocess", async () => {
    const { root, run } = await fixture();
    const resultFile = join(root, "opened.json");
    const opener = join(root, "opener.ts");
    await writeFile(opener, "await Bun.write(process.argv[2]!, JSON.stringify(process.argv.slice(3)));\n");
    const value = JSON.parse(await run(["docs", "database", "--open", "--json"], [process.execPath, opener, resultFile]));
    expect(value.opened).toBe(true);
    expect(JSON.parse(await readFile(resultFile, "utf8"))).toEqual([join(root, "docs", "database.md")]);
    const failed = join(root, "failed-opener.ts");
    await writeFile(failed, "process.exitCode = 4;\n");
    await expect(run(["docs", "database", "--open"], [process.execPath, failed])).rejects.toThrow("opener");
  });

  test("documentation refuses traversal, missing pages, unsafe entries and ambiguous flags", async () => {
    const { root, run } = await fixture();
    await expect(run(["docs", "../README"])).rejects.toThrow();
    await expect(run(["docs", "missing"])).rejects.toThrow("not found");
    await symlink(join(root, "README.md"), join(root, "docs", "linked.md"));
    await expect(run(["docs", "linked"])).rejects.toThrow("regular");
    expect(JSON.parse(await run(["docs", "--list", "--json"]))).not.toContain("linked");
    await expect(run(["docs", "database", "--list"])).rejects.toThrow();
    await expect(run(["docs", "--list", "--open"])).rejects.toThrow();
  });
});
