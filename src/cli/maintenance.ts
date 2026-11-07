import type { Command } from "commander";
import { disableMaintenance, enableMaintenance } from "../maintenance/maintenance.ts";

function seconds(value: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error("Seconds must be an integer.");
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error("Seconds must be an integer.");
  return result;
}

export function registerMaintenance(program: Command, context: { root: string; output: (text: string) => void }): void {
  program.command("down").description("Enable maintenance mode")
    .option("--retry <seconds>", "Set Retry-After seconds")
    .option("--refresh <seconds>", "Set Refresh seconds")
    .action(async (options: { retry?: string; refresh?: string }) => {
      await enableMaintenance(context.root, {
        ...(options.retry !== undefined ? { retrySeconds: seconds(options.retry) } : {}),
        ...(options.refresh !== undefined ? { refreshSeconds: seconds(options.refresh) } : {}),
      });
      context.output("Maintenance mode enabled.");
    });
  program.command("up").description("Disable maintenance mode").action(async () => {
    context.output(await disableMaintenance(context.root) ? "Maintenance mode disabled." : "Maintenance mode is not enabled.");
  });
}
