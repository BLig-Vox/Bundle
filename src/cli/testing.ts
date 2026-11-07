import { CommanderError, InvalidArgumentError, type Command } from "commander";
import { runIsolatedDatabaseTests } from "../testing/test-databases.ts";

export interface TestCommandContext {
  root: string;
  env?: Record<string, string | undefined>;
  output?: (text: string) => void;
  error?: (text: string) => void;
  signal?: AbortSignal;
  globalOptions?: () => Readonly<Record<string, unknown>>;
}

function workerCount(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new InvalidArgumentError("Worker count must be a positive safe integer.");
  }
  return Number(value);
}

async function forward(stream: ReadableStream<Uint8Array>, write: (text: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (text) write(text);
  }
  const remainder = decoder.decode();
  if (remainder) write(remainder);
}

/** Run trusted project tests with Bun, not a shell or package-script recursion.
 * Parallel mode uses Bun's isolated worker processes (two by default). It does
 * `--isolated-databases` adds explicitly owned, pre-migrated SQLite databases per native worker. It does not isolate external services.
 */
export function registerTesting(program: Command, context: TestCommandContext): void {
  program.command("test [files...]")
    .description("Run native Bun tests; opt in to disposable per-worker SQLite databases")
    .option("--filter <pattern>", "Run test names matching this regular expression")
    .option("--coverage", "Generate Bun's native text coverage report")
    .option("--parallel", "Use native isolated worker processes (defaults to two)")
    .option("--processes <count>", "Number of native workers; requires --parallel", workerCount)
    .option("--isolated-databases", "Create and migrate disposable SQLite databases per native test worker")
    .action(async (files: string[], options: { filter?: string; coverage?: boolean; parallel?: boolean; processes?: number; isolatedDatabases?: boolean }) => {
      if (options.processes !== undefined && !options.parallel) throw new Error("--processes requires --parallel.");
      if (files.some(file => file.startsWith("-") || file.includes("\0"))) {
        throw new Error("Test file patterns must not start with '-' or contain null bytes.");
      }
      if (options.isolatedDatabases && !options.parallel) throw new Error("--isolated-databases requires --parallel.");
      const globals = context.globalOptions?.() ?? {};
      if (options.isolatedDatabases && (globals.database !== undefined || globals.path !== undefined || globals.realpath === true)) throw new Error("--isolated-databases refuses global database/path selection.");
      if (options.isolatedDatabases) {
        const status = await runIsolatedDatabaseTests({ root: context.root, env: context.env, files, processes: options.processes ?? 2, filter: options.filter, coverage: options.coverage, signal: context.signal, output: context.output, error: context.error });
        if (status !== 0) throw new CommanderError(status, "bundle.testExit", `Bun tests exited with status ${status}.`);
        return;
      }
      const args = [process.execPath, "test"];
      if (options.filter !== undefined) args.push("--test-name-pattern", options.filter);
      if (options.coverage) args.push("--coverage");
      if (options.parallel) args.push(`--parallel=${options.processes ?? 2}`, "--parallel-delay=0");
      args.push(...files);
      const child = Bun.spawn(args, {
        cwd: context.root, env: { ...(context.env ?? process.env) },
        stdout: "pipe", stderr: "pipe", stdin: "inherit",
      });
      let receivedSignal: NodeJS.Signals | undefined;
      const interrupt = () => { receivedSignal = "SIGINT"; child.kill("SIGINT"); };
      const terminate = () => { receivedSignal = "SIGTERM"; child.kill("SIGTERM"); };
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);
      try {
        const [code] = await Promise.all([
          child.exited,
          forward(child.stdout, context.output ?? (text => { process.stdout.write(text); })),
          forward(child.stderr, context.error ?? (text => { process.stderr.write(text); })),
        ]);
        const status = receivedSignal === "SIGINT" ? 130 : receivedSignal === "SIGTERM" ? 143 : code;
        if (status !== 0) throw new CommanderError(status, "bundle.testExit", `Bun tests exited with status ${status}.`);
      } finally {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          await child.exited;
        }
      }
    });
}
