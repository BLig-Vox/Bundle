import type { Command } from "commander";
import { isAbsolute, resolve } from "node:path";
import { createProject, validateProjectName } from "../installation/project.ts";
import { createPrompts } from "../console/prompts.ts";
import type { DatabaseConnection } from "../database/config.ts";

export function registerProject(program: Command, context: { root: string; output: (text: string) => void; signal?: AbortSignal; prompts?: ReturnType<typeof createPrompts> }): void {
  program.command("new [name]").description("Create a new offline code-first Bun application; never install dependencies or run migrations")
    .option("--parent <directory>", "Existing parent directory (defaults to the current project root)")
    .option("--driver <driver>", "Database configuration: sqlite, postgresql or mariadb (default: sqlite)")
    .option("--without-http", "Omit the example code-first health route")
    .option("--interactive", "Use native prompts for unspecified application choices")
    .action(async (providedName: string | undefined, options: { parent?: string; driver?: string; withoutHttp?: boolean; interactive?: boolean }) => {
      const check = () => { if (context.signal?.aborted) throw new Error("Application creation cancelled."); };
      check();
      let name = providedName; let driver = options.driver; let http = options.withoutHttp !== true;
      if (driver !== undefined && !["sqlite", "postgresql", "mariadb"].includes(driver)) throw new Error("Supported database choices are sqlite, postgresql and mariadb.");
      if (name !== undefined) validateProjectName(name);
      if (options.interactive) {
        const prompts = context.prompts ?? createPrompts({ input: process.stdin, output: process.stderr });
        if (name === undefined) name = await prompts.text({ message: "Application name", signal: context.signal, validate: value => { try { validateProjectName(value); } catch { return "Use a lowercase application name of 1–64 letters, numbers or hyphens."; } } });
        check();
        if (driver === undefined) driver = await prompts.select<DatabaseConnection>({ message: "Database driver", default: "sqlite", signal: context.signal, options: [{ label: "SQLite", value: "sqlite" }, { label: "PostgreSQL (separately provisioned)", value: "postgresql" }, { label: "MariaDB (separately provisioned)", value: "mariadb" }] });
        check();
        if (options.withoutHttp !== true) http = await prompts.confirm({ message: "Include health route", default: true, signal: context.signal });
        check();
      }
      if (name === undefined) throw new Error("Provide an application name or use --interactive in a terminal.");
      const parent = options.parent === undefined ? context.root : isAbsolute(options.parent) ? options.parent : resolve(context.root, options.parent);
      const result = await createProject({ parent, name, driver: (driver ?? "sqlite") as DatabaseConnection, http, signal: context.signal });
      check(); context.output(JSON.stringify(result, null, 2));
    });
}
