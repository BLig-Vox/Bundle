import { CommanderError, type Command } from "commander";
import { Writable } from "node:stream";
import type { ServiceScope } from "../console/services.ts";
import { runTinker } from "../console/tinker.ts";

type OwnedDatabase = { close(force?: boolean): unknown | Promise<unknown> };

export function registerTinker(program: Command, context: { root: string; services?: ServiceScope; output?: (text: string) => void; signal?: AbortSignal; openDatabase: () => Promise<OwnedDatabase> }): void {
  program.command("tinker").description("Run trusted local JavaScript with the bootstrapped application; NOT a sandbox")
    .option("--execute <source>", "Explicit trusted noninteractive JavaScript (visible in process argv; do not put secrets here)")
    .option("--allow-database", "Enable explicit lazy owned database access; production also requires global --force")
    .action(async (options: { execute?: string; allowDatabase?: boolean }) => {
      const output = context.output === undefined ? undefined : new Writable({ write(chunk, _encoding, done) {
        try { context.output!(chunk.toString()); done(); } catch (error) { done(error instanceof Error ? error : new Error("Tinker output failed.")); }
      } });
      try {
        const result = await runTinker({ root: context.root,
          ...(context.services === undefined ? {} : { services: context.services }),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          ...(output === undefined ? {} : { output }),
          ...(options.execute === undefined ? {} : { execute: options.execute }),
          ...(options.allowDatabase === true ? { openDatabase: context.openDatabase } : {}),
        });
        if (result.interrupted) throw new CommanderError(130, "bundle.tinkerInterrupt", "Tinker interrupted.");
        if (result.aborted) throw new Error("Tinker cancelled.");
        if (result.failures > 0) throw new CommanderError(1, "bundle.tinkerEvaluation", "Native JavaScript evaluation failed.");
      } finally { output?.destroy(); }
    });
}
