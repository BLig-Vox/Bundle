import { InvalidArgumentError, type Command } from "commander";
import type { openDatabase } from "../database/connection.ts";

type PruningDatabase = Awaited<ReturnType<typeof openDatabase>>;
export interface ModelPruneContext {
  root: string;
  output: (text: string) => void;
  signal?: AbortSignal;
  database: <T>(work: (orm: PruningDatabase) => Promise<T>) => Promise<T>;
}
function positive(max: number): (value: string) => number {
  return value => {
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new InvalidArgumentError(`Expected an integer from 1 to ${max}.`);
    return Number(value);
  };
}
function models(value: string): string[] {
  const names = value.split(",");
  if (!names.length || names.length > 32 || new Set(names).size !== names.length || names.some(name => !/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(name) || ["__proto__", "prototype", "constructor"].includes(name))) throw new InvalidArgumentError("Expected unique registered model names, comma-separated.");
  return names;
}

/** Source imports are trusted; force guards this command's own destructive database work. */
export function registerModelPrune(program: Command, context: ModelPruneContext): void {
  const checkSignal = () => { if (context.signal?.aborted) throw new Error("Model pruning cancelled."); };
  program.command("model:prune").description("Count or force-prune explicit native rules in bounded chunks")
    .option("--model <names>", "Registered rule names, comma-separated", models)
    .option("--pretend", "Count matching targets without deleting")
    .option("--chunk <count>", "Targets per transaction, 1 to 1000", positive(1000), 100)
    .option("--limit <count>", "Maximum targets per selected rule, 1 to 10000", positive(10000), 1000)
    .action(async (options: { model?: string[]; pretend?: boolean; chunk: number; limit: number }) => {
      const pretend = options.pretend === true, force = program.opts().force === true;
      if (!pretend && !force) throw new Error("Model pruning requires --force; use --pretend to inspect counts.");
      const selected = options.model?.slice(), chunkSize = options.chunk, limit = options.limit;
      checkSignal();
      try {
        const { loadPruning } = await import("../database/pruning-definitions.ts");
        checkSignal();
        const definitions = await loadPruning(context.root, context.signal);
        checkSignal();
        if (selected?.some(name => !definitions.some(rule => rule.name === name))) throw new Error("Unknown model pruning selection.");
        const { pruneModels } = await import("../database/pruning.ts");
        checkSignal();
        const result = await context.database(async orm => {
          checkSignal();
          return pruneModels(orm.em, definitions, { pretend, force, ...(selected ? { models: selected } : {}), chunkSize, limit, ...(context.signal ? { signal: context.signal } : {}) });
        });
        checkSignal();
        context.output(JSON.stringify(result));
      } catch {
        checkSignal();
        throw new Error("Model pruning failed. Check explicit pruning rules and the existing selected database; earlier committed chunks are not rolled back.");
      }
    });
}
