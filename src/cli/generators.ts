import type { Command } from "commander";
import { generateDeliveryScaffold, generateEventScaffold, generateExecutableScaffold, generateHttpScaffold, generateHttpTestScaffold, generateJobMiddlewareScaffold, generateJobScaffold, generateOrmScaffold, generateProviderScaffold, generateTypeScript, publishScaffoldStubs, type TypeScriptScaffoldKind } from "./scaffolding.ts";

/** Register code-only generators. Existing files are never overwritten. */
export function registerScaffolding(program: Command, context: { root: string; output: (text: string) => void }): void {
  const declarations: ReadonlyArray<[TypeScriptScaffoldKind, string]> = [
    ["class", "Create a TypeScript class"],
    ["interface", "Create a TypeScript interface"],
    ["enum", "Create a TypeScript enum"],
    ["trait", "Create a TypeScript mixin alternative (not a PHP trait)"],
  ];
  for (const [kind, description] of declarations) {
    program.command(`make:${kind} <name>`).description(description).action(async (name: string) => {
      context.output(`Created ${await generateTypeScript(context.root, kind, name)}`);
    });
  }
  for (const [kind, description] of [
    ["command", "Create a loadable custom command"],
    ["test", "Create a Bun test"],
    ["exception", "Create a TypeScript error class"],
    ["config", "Create a TypeScript configuration module"],
  ] as const) {
    const command = program.command(`make:${kind} <name>`).description(description);
    if (kind === "command") command.option("--command <name>", "Select the application command name");
    if (kind === "test") command.option("--unit", "Create a unit test").option("--http <path>", "Create a real-worker HTTP feature test for this application path");
    command.action(async (name: string, options: { command?: string; unit?: boolean; http?: string }) => {
      if (kind === "test" && options.http !== undefined) {
        if (options.unit) throw new Error("--http and --unit cannot be combined.");
        context.output(`Created ${await generateHttpTestScaffold(context.root, name, options.http)}`);
        return;
      }
      // Mirror the loader's implicit-help collision check; Commander exposes no public getter.
      const help = (program as Command & { _getHelpCommand(): Command | null })._getHelpCommand();
      const reservedCommandNames = [...program.commands, ...(help ? [help] : [])]
        .flatMap(command => [command.name(), ...command.aliases()]);
      context.output(`Created ${await generateExecutableScaffold(context.root, kind, name, { reservedCommandNames, commandName: options.command, unit: options.unit })}`);
    });
  }
  for (const kind of ["controller", "middleware", "request", "resource", "rule", "policy"] as const) {
    const command = program.command(`make:${kind} <name>`).description(`Create an HTTP ${kind} scaffold`);
    if (kind === "controller") command.option("--resource", "Create a model resource controller").option("--model <model>", "Existing top-level model class");
    command.action(async (name: string, options: { resource?: boolean; model?: string }) => {
      context.output(`Created ${await generateHttpScaffold(context.root, kind, name, options)}`);
    });
  }
  for (const kind of ["event", "listener"] as const) {
    program.command(`make:${kind} <name>`).description(`Create an ${kind} scaffold`).action(async (name: string) => {
      context.output(`Created ${await generateEventScaffold(context.root, kind, name)}`);
    });
  }
  for (const kind of ["mail", "notification"] as const) {
    program.command(`make:${kind} <name>`).description(`Create a text ${kind} scaffold`).action(async (name: string) => {
      context.output(`Created ${await generateDeliveryScaffold(context.root, kind, name)}`);
    });
  }
  for (const kind of ["factory", "cast", "scope", "observer"] as const) {
    const command = program.command(`make:${kind} <name>`).description(`Create a native ORM ${kind} scaffold`);
    if (kind === "factory") command.requiredOption("--model <model>", "Existing top-level model class");
    command.action(async (name: string, options: { model?: string }) => {
      context.output(`Created ${await generateOrmScaffold(context.root, kind, name, options.model)}`);
    });
  }
  program.command("make:job <name>").description("Create a queue job scaffold").action(async (name: string) => {
    context.output(`Created ${await generateJobScaffold(context.root, name)}`);
  });
  program.command("make:job-middleware <name>").description("Create a queue job middleware scaffold").action(async (name: string) => {
    context.output(`Created ${await generateJobMiddlewareScaffold(context.root, name)}`);
  });
  program.command("make:provider <name>").description("Create an explicitly registered application provider").action(async (name: string) => {
    context.output(`Created ${await generateProviderScaffold(context.root, name)}`);
  });
  program.command("stub:publish").description("Publish code-only scaffold templates").action(async () => {
    for (const path of await publishScaffoldStubs(context.root)) context.output(`Created ${path}`);
  });
}
