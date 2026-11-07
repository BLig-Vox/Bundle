import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Command } from "commander";
import { defineCommand, registerCommands, type ApplicationCommandContext, type CommandDefinition } from "./command.ts";

/**
 * Load trusted project commands from root/src/commands/*.ts before program.parseAsync().
 *
 * Modules export a default command definition, named definitions, or both. All runtime exports
 * must be command definitions; keep helpers private or in another directory. An object exported
 * both by name and as default is loaded once. Multiple distinct definitions with the same name
 * are errors, including collisions with built-ins, their aliases, help, and global option flags.
 *
 * Only regular top-level .ts files are imported; .d.ts, .test.ts and .spec.ts are excluded.
 * File and export order use a deterministic lexical sort. A missing directory is an empty batch.
 * Every module is imported and every definition preflighted before any command is attached.
 * This guarantee covers registration, not import-time side effects: imported TypeScript is
 * executable, trusted project code, NOT sandboxed. Never use this to load untrusted uploads.
 * Module imports follow Bun's normal module cache; source edits require a fresh process/watch restart.
 *
 * Returns registered definitions. Inject output/error to test without patching global terminals.
 * Nonzero handler results throw CommandExitError (a CommanderError) for the host to translate
 * into process status. This library changes no process state. Other handler errors propagate
 * and should be formatted safely by the host.
 */
export async function loadApplicationCommands(program: Command, context: ApplicationCommandContext = {}): Promise<readonly CommandDefinition[]> {
  const root = resolve(context.root ?? process.cwd());
  const directory = join(root, "src", "commands");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  const filenames = entries
    .filter(entry => entry.isFile() && entry.name.endsWith(".ts") && !/\.(?:d|test|spec)\.ts$/.test(entry.name))
    .map(entry => entry.name)
    .sort();
  const definitions: CommandDefinition[] = [];
  const seen = new Set<unknown>();
  for (const filename of filenames) {
    let module: Record<string, unknown>;
    try {
      module = await import(pathToFileURL(join(directory, filename)).href) as Record<string, unknown>;
    } catch (cause) {
      // Don't include arbitrary module exceptions (which can contain secrets) in normal CLI output.
      throw new Error(`Unable to import application command module src/commands/${filename}.`, { cause });
    }
    const exportNames = Object.keys(module).sort();
    if (!exportNames.length) throw new Error(`Application command module src/commands/${filename} exports no definitions.`);
    for (const exportName of exportNames) {
      const exported = module[exportName];
      if (seen.has(exported)) continue;
      seen.add(exported);
      try {
        definitions.push(defineCommand(exported as CommandDefinition));
      } catch {
        throw new Error(`Invalid command definition exported as ${exportName} from src/commands/${filename}.`);
      }
    }
  }
  return registerCommands(program, definitions, { ...context, root });
}
