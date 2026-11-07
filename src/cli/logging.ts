import { CommanderError, InvalidArgumentError, type Command } from "commander";
import { followLogs, logLevels, readLogs, type LogEntry, type LogLevel } from "../logging/logger.ts";

function positive(value: string): number {
  const number = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number) || number > 2147483647) throw new InvalidArgumentError("Expected a positive bounded integer.");
  return number;
}
function severity(value: string): LogLevel {
  if (!logLevels.includes(value as LogLevel)) throw new InvalidArgumentError(`Log level must be one of: ${logLevels.join(", ")}.`);
  return value as LogLevel;
}
function terminalText(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, character => JSON.stringify(character).slice(1, -1));
}

export function registerLogging(program: Command, context: { root: string; env: Record<string, string | undefined>; output: (text: string) => void; error?: (text: string) => void }): void {
  program.command("pail").description("Inspect Bundle structured local logs; --follow watches append/rotation events")
    .option("--lines <count>", "Maximum recent records (1–1000)", positive, 50)
    .option("--level <severity>", "Minimum severity", severity)
    .option("--filter <pattern>", "Match messages using a regular expression")
    .option("--json", "Print a JSON snapshot or JSONL records in follow mode")
    .option("--follow", "Continue watching until cancelled or timed out")
    .option("--timeout <milliseconds>", "Stop follow mode successfully after this duration", positive)
    .action(async (options: { lines: number; level?: LogLevel; filter?: string; json?: boolean; follow?: boolean; timeout?: number }) => {
      if (options.timeout !== undefined && !options.follow) throw new Error("--timeout requires --follow.");
      const readOptions = { limit: options.lines, minimumLevel: options.level, filter: options.filter };
      const print = (entry: LogEntry) => context.output(options.json ? JSON.stringify(entry) : `${entry.timestamp} ${entry.level.toUpperCase()} ${terminalText(entry.message)} ${JSON.stringify(entry.context)}`);
      if (!options.follow) {
        const result = await readLogs(context.root, readOptions);
        if (options.json) context.output(JSON.stringify(result, null, 2));
        else {
          if (result.truncated) context.output("Log inspection is bounded to the latest 256 KiB; older records were not read.");
          if (!result.entries.length) context.output("No matching log records.");
          for (const entry of result.entries) print(entry);
        }
        return;
      }
      const controller = new AbortController();
      let status = 0;
      const interrupt = () => { status = 130; controller.abort(); };
      const terminate = () => { status = 143; controller.abort(); };
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);
      const timer = options.timeout === undefined ? undefined : setTimeout(() => controller.abort(), options.timeout);
      try {
        for await (const entry of followLogs(context.root, { ...readOptions, signal: controller.signal, onWarning: context.error ?? console.error })) print(entry);
        if (status) throw new CommanderError(status, "bundle.logExit", "Log following was cancelled.");
      } finally {
        clearTimeout(timer);
        controller.abort();
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
      }
    });
}
