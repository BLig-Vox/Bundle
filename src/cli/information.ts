import type { Command } from "commander";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { currentEnvironment } from "../environment/environment.ts";

export interface InformationContext {
  root: string;
  env: Record<string, string | undefined>;
  output: (text: string) => void;
  version: string;
  database: () => Promise<{ connection: string; database: string; migrationsPath: string; host?: string; port?: number }>;
  documentationOpener?: readonly string[];
}

async function localFileState(root: string, parts: readonly string[]): Promise<"present" | "missing" | "unsafe"> {
  let path = root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) return "unsafe";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }
  return "present";
}

async function documentationPages(root: string): Promise<string[]> {
  const pages: string[] = [];
  if (await localFileState(root, ["README.md"]) === "present") pages.push("readme");
  const directory = join(root, "docs");
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Documentation directory must be a real directory, not a symlink.");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && /^[a-z][a-z0-9_-]*\.md$/.test(entry.name)) pages.push(entry.name.slice(0, -3));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return [...new Set(pages)].sort();
}

async function openDocumentation(path: string, configured?: readonly string[]): Promise<void> {
  const command = configured ?? (process.platform === "linux" ? ["xdg-open"] : process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["explorer.exe"] : []);
  if (!command.length || command.some(argument => typeof argument !== "string" || !argument || argument.includes("\0"))) {
    throw new Error("No valid documentation opener is configured for this platform.");
  }
  try {
    const child = Bun.spawn([...command, path], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    if (await child.exited !== 0) throw new Error("Nonzero opener status.");
  } catch {
    throw new Error("Documentation opener failed; install or configure a local file opener.");
  }
}

/** Read-only application metadata and explicit local documentation opening; no DB connection or network fetch. */
export function registerInformation(program: Command, context: InformationContext): void {
  program.command("about").description("Show selected application/environment information without connecting or exposing credentials")
    .option("--only <sections>", "Comma-separated environment,database,cache sections")
    .option("--json", "Print structured JSON (also the default)")
    .action(async (options: { only?: string; json?: boolean }) => {
      const sections = options.only === undefined ? ["environment", "database", "cache"] : options.only.split(",");
      if (!sections.length || sections.some(section => !["environment", "database", "cache"].includes(section))) throw new Error("Unknown or empty information section.");
      const value: Record<string, unknown> = { name: "Bundle", version: context.version, runtime: `Bun ${Bun.version}` };
      if (sections.includes("environment")) value.environment = {
        application: context.env.APP_NAME ?? "Bundle", name: currentEnvironment(context.env),
        debug: context.env.APP_DEBUG === "true" || context.env.APP_DEBUG === "1",
        platform: process.platform, architecture: process.arch,
      };
      if (sections.includes("database")) value.database = await context.database();
      if (sections.includes("cache")) value.cache = { configuration: await localFileState(await realpath(context.root), ["bootstrap", "cache", "config.json"]) };
      context.output(JSON.stringify(value, null, 2));
    });

  program.command("docs [page]").description("Locate Bundle's local documentation; opening a browser/file handler requires --open")
    .option("--list", "List available local Markdown page names")
    .option("--open", "Explicitly open a validated local documentation file with the platform handler")
    .option("--json", "Print structured locations or available page names")
    .action(async (page: string | undefined, options: { list?: boolean; open?: boolean; json?: boolean }) => {
      if (options.list && (page !== undefined || options.open)) throw new Error("Use --list without a page or --open.");
      const root = await realpath(context.root);
      if (options.list) {
        const pages = await documentationPages(root);
        context.output(options.json ? JSON.stringify(pages, null, 2) : pages.join("\n"));
        return;
      }
      const selected = (page ?? "readme").replace(/\.md$/, "");
      if (!/^[a-z][a-z0-9_-]*$/.test(selected)) throw new Error("Documentation page must be a local page name without directories.");
      // Validate each ancestor and the file before opening; never follow linked docs.
      const parts = selected === "readme" ? ["README.md"] : ["docs", `${selected}.md`];
      const state = await localFileState(root, parts);
      if (state === "unsafe") throw new Error("Documentation must be a regular local file with real directory parents.");
      if (state === "missing") throw new Error("Documentation page not found; use docs --list.");
      const path = join(root, ...parts);
      if (options.open) await openDocumentation(path, context.documentationOpener);
      context.output(options.json ? JSON.stringify({ page: selected, path, opened: !!options.open }, null, 2) : `${options.open ? "Opened" : "Documentation"}: ${path}`);
    });
}
