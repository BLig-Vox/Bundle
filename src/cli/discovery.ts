import { Command, InvalidArgumentError } from "commander";
import { isRequiredCommandArgument } from "../console/command.ts";

/** Discovery reads registered commands only; it never resolves database settings. */
export function registerDiscovery(program: Command, output: (text: string) => void) {
  program.addHelpCommand(false);
  program.command("list [namespace]")
    .description("List registered commands, optionally filtered by namespace")
    .option("--raw", "Print command names and descriptions without a heading")
    .option("--format <format>", "Output format: txt or json", value => {
      if (value !== "txt" && value !== "json") throw new InvalidArgumentError("Use txt or json.");
      return value;
    }, "txt")
    .action((namespace: string | undefined, options: { raw?: boolean; format: string }) => {
      const commands = program.commands
        .filter(command => !namespace || command.name().split(":")[0] === namespace)
        .sort((a, b) => a.name().localeCompare(b.name(), "en"));
      if (options.format === "json") {
        output(JSON.stringify({ name: program.name(), commands: commands.map(command => ({
          name: command.name(), description: command.description(), aliases: command.aliases(),
          arguments: command.registeredArguments.map(argument => ({
            name: argument.name(), description: argument.description,
            required: isRequiredCommandArgument(argument), variadic: argument.variadic,
          })),
          options: command.options.map(option => ({
            flags: option.flags, description: option.description,
            required: option.required, optional: option.optional,
          })),
        })) }, null, 2));
      } else if (!namespace && !options.raw) {
        output(program.helpInformation());
      } else {
        const lines = commands.map(command => `${command.name()}  ${command.description()}`);
        output((options.raw ? "" : `Available commands (${namespace}):\n`) + lines.join("\n"));
      }
    });

  program.command("help [command...]")
    .description("Show help for a registered command")
    .action((names: string[]) => {
      let selected = program;
      for (const name of names) {
        const child = selected.commands.find(command => command.name() === name || command.aliases().includes(name));
        if (!child) throw new Error(`Unknown command: ${names.join(" ")}`);
        selected = child;
      }
      output(selected.helpInformation());
    });
}
