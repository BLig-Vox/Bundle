import { Argument, Command, CommanderError, Option } from "commander";
import { resolve } from "node:path";
import type { ServiceContainer, ServiceScope } from "./services.ts";
import { acquireCommandLock } from "./isolation.ts";
import { createPrompts } from "./prompts.ts";

export type LifecycleEvent = Readonly<{ phase: "start"; args: readonly string[] } | { phase: "finish"; args: readonly string[]; status: number }>;
export type LifecycleListener = (event: LifecycleEvent) => void | Promise<void>;

/** Listeners run sequentially in subscription order; each emission uses a snapshot. */
export class LifecycleRegistry {
  private readonly listeners = new Set<{ listener: LifecycleListener }>();
  subscribe(listener: LifecycleListener): () => void {
    const subscription = { listener };
    this.listeners.add(subscription);
    return () => { this.listeners.delete(subscription); };
  }
  async emit(event: LifecycleEvent): Promise<void> {
    const errors: unknown[] = [];
    for (const { listener } of [...this.listeners]) {
      try { await listener(event); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, `Lifecycle listeners failed: ${errors.map(String).join('; ')}`);
  }
}

export type CommandArgumentValue = string | readonly string[] | undefined;
export type CommandOptionValue = CommandArgumentValue | boolean | number;

export type CommandArgument = Readonly<{
  /** Bare argument name, without brackets. Arguments are required unless required is false. */
  name: string;
  description?: string;
  required?: boolean;
  /** Ask for an omitted required scalar argument; optional/variadic arguments cannot prompt. */
  prompt?: string;
  /** Only the final argument may be variadic. */
  variadic?: boolean;
  /** Defaults are only meaningful for optional arguments. */
  default?: string | readonly string[];
}>;

export type CommandOption = Readonly<{
  /** Commander flags, e.g. "-g, --greeting <text>", "--tag <values...>", or "--no-color". */
  flags: string;
  description?: string;
  /** CLI values remain strings; a numeric default does not coerce supplied values. */
  default?: CommandOptionValue;
}>;

export type CommandInput = Readonly<{
  args: Readonly<Record<string, CommandArgumentValue>>;
  /** Command-local options, keyed by Commander's camelCase attribute name. */
  options: Readonly<Record<string, CommandOptionValue>>;
}>;

export type CommandContext = Readonly<{
  root: string;
  env: Readonly<Record<string, string | undefined>>;
  output: (text: string) => void;
  error: (text: string) => void;
  services?: ServiceScope;
  /** Explicit adapter injection is recommended for embedded/non-terminal hosts. */
  prompts?: ReturnType<typeof createPrompts>;
  signal?: AbortSignal;
  call?: (args: readonly string[]) => Promise<number>;
}>;

export type ApplicationCommandContext = Partial<CommandContext> & {
  container?: ServiceContainer;
  onLifecycle?: LifecycleListener;
  lifecycle?: LifecycleRegistry;
  maxCallDepth?: number;
  handleSignals?: boolean;
};

/** A handler's nonzero result, consumed by the host's existing Commander error boundary. */
export class CommandExitError extends CommanderError {
  constructor(readonly commandName: string, exitCode: number) {
    super(exitCode, "bundle.commandExit", `Command ${commandName} exited with code ${exitCode}.`);
    this.name = "CommandExitError";
  }
}

export type CommandDefinition = Readonly<{
  /** Lowercase colon-separated command name, e.g. "report:daily". */
  name: string;
  description: string;
  arguments?: readonly CommandArgument[];
  options?: readonly CommandOption[];
  /** Always isolate this command; this does not add an --isolated option. */
  isolation?: Readonly<{ key?: string; contentionExitCode?: number }>;
  /** Return undefined/0 for success, or an integer 1–255 for failure. Thrown errors propagate. */
  handle: (input: CommandInput, context: CommandContext) => void | number | Promise<void | number>;
}>;

const commandName = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/;
const argumentName = /^[A-Za-z][A-Za-z0-9_-]*$/;
const optionFlags = /^(?:-[A-Za-z0-9],\s+)?--[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\s+(?:<[A-Za-z][A-Za-z0-9_-]*(?:\.\.\.)?>|\[[A-Za-z][A-Za-z0-9_-]*(?:\.\.\.)?\]))?$/;
const unsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
const logicalRequirements = new WeakMap<Argument, boolean>();

/** Preserve logical requirements when prompt-enabled parsing defers validation. */
export function isRequiredCommandArgument(argument: Argument): boolean {
  return logicalRequirements.get(argument) ?? argument.required;
}

// Commander 15 exposes no public getters for implicit help entries. Their visibility
// affects rendering, not whether their names and flags are reserved at runtime.
type CommandWithImplicitHelp = Command & {
  _getHelpCommand(): Command | null;
  _getHelpOption(): Option | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function description(value: unknown, required = false): void {
  if ((value !== undefined && typeof value !== "string") || (required && (typeof value !== "string" || !value.trim()))) {
    throw new Error("Command descriptions must be strings (the command description must not be empty).");
  }
}

function copyDefault<T extends CommandOptionValue>(value: T): T {
  return (Array.isArray(value) ? Object.freeze([...value]) : value) as T;
}

function optionFrom(definition: CommandOption): Option {
  const option = new Option(definition.flags, definition.description);
  // Commander only recognizes variadics whose placeholder ends in a word character;
  // Bundle also permits a trailing hyphen in placeholder names.
  option.variadic = /\.\.\.[>\]]$/.test(definition.flags);
  if (definition.default !== undefined) {
    // Commander owns its defaults; don't hand it the frozen definition's array.
    option.default(Array.isArray(definition.default) ? [...definition.default] : definition.default);
  }
  return option;
}

/**
 * Define a reusable, validated command without touching a terminal or a Commander root.
 *
 * @example
 * export default defineCommand({
 *   name: "greet", description: "Greet someone",
 *   arguments: [{ name: "name", required: false, default: "World" }],
 *   options: [{ flags: "-g, --greeting <text>", default: "Hello" }],
 *   async handle({ args, options }, { output }) {
 *     output(`${options.greeting}, ${args.name}!`);
 *     return 0;
 *   },
 * });
 *
 * Positional defaults are strings (or string arrays for variadics). Options support boolean,
 * string, finite numeric and string-array defaults. There are no implicit numeric parsers,
 * interactive prompts or shared database entity managers. Runner-provided services, signal,
 * and nested calls are optional when invoking commands directly.
 */
export function defineCommand(definition: CommandDefinition): CommandDefinition {
  if (!record(definition)) throw new Error("A command definition must be an object.");
  if (typeof definition.name !== "string" || !commandName.test(definition.name)) {
    throw new Error("Command names must be lowercase words separated by colons, using letters, digits and hyphens.");
  }
  description(definition.description, true);
  if (typeof definition.handle !== "function") throw new Error(`Command ${definition.name} needs a handle function.`);
  if (definition.arguments !== undefined && !Array.isArray(definition.arguments)) throw new Error("Command arguments must be an array.");
  if (definition.options !== undefined && !Array.isArray(definition.options)) throw new Error("Command options must be an array.");

  let isolation: CommandDefinition["isolation"];
  if (definition.isolation !== undefined) {
    const value = definition.isolation;
    if (!record(value) || Object.keys(value).some(key => key !== "key" && key !== "contentionExitCode") ||
        (value.key !== undefined && (typeof value.key !== "string" || !value.key.trim())) ||
        (value.contentionExitCode !== undefined && (!Number.isInteger(value.contentionExitCode) || typeof value.contentionExitCode !== "number" || value.contentionExitCode < 0 || value.contentionExitCode > 255))) {
      throw new Error("Invalid command isolation metadata.");
    }
    isolation = Object.freeze({ key: value.key as string | undefined, contentionExitCode: value.contentionExitCode as number | undefined });
  }

  const argumentKeys = new Set<string>();
  let optionalSeen = false;
  const argumentDefinitions: readonly CommandArgument[] = definition.arguments ?? [];
  const args = argumentDefinitions.map((argument, index, all) => {
    if (!record(argument) || typeof argument.name !== "string" || !argumentName.test(argument.name) || unsafeKeys.has(argument.name)) {
      throw new Error(`Command ${definition.name} has an invalid argument name.`);
    }
    if (argumentKeys.has(argument.name)) throw new Error(`Command ${definition.name} has duplicate argument ${argument.name}.`);
    argumentKeys.add(argument.name);
    description(argument.description);
    if (argument.prompt !== undefined && (typeof argument.prompt !== "string" || !argument.prompt.trim() || argument.required === false || argument.variadic)) {
      throw new Error("Argument prompt must be a nonempty message for a required scalar argument.");
    }
    if ((argument.required !== undefined && typeof argument.required !== "boolean") ||
        (argument.variadic !== undefined && typeof argument.variadic !== "boolean")) {
      throw new Error(`Argument ${argument.name} required/variadic settings must be booleans.`);
    }
    const required = argument.required !== false;
    if (required && optionalSeen) throw new Error("Required arguments must precede optional arguments.");
    if (!required) optionalSeen = true;
    if (argument.variadic && index !== all.length - 1) throw new Error("Only the last argument may be variadic.");
    if (argument.default !== undefined) {
      if (required) throw new Error("Required arguments cannot have defaults.");
      const valid = argument.variadic
        ? Array.isArray(argument.default) && argument.default.every(value => typeof value === "string")
        : typeof argument.default === "string";
      if (!valid) throw new Error(`Argument ${argument.name} has an invalid default.`);
    }
    return Object.freeze({ ...argument, default: copyDefault(argument.default) });
  });

  const flags = new Set<string>(["-h", "--help"]);
  const attributes = new Set<string>(["help"]);
  const optionDefinitions: readonly CommandOption[] = definition.options ?? [];
  const options = optionDefinitions.map(option => {
    if (!record(option) || typeof option.flags !== "string" || !optionFlags.test(option.flags)) {
      throw new Error(`Command ${definition.name} has invalid option flags; use "-s, --long-name <value>" syntax.`);
    }
    description(option.description);
    const parsed = optionFrom(option);
    const key = parsed.attributeName();
    if (unsafeKeys.has(key) || attributes.has(key)) throw new Error(`Command ${definition.name} has a duplicate or reserved option key ${key}.`);
    attributes.add(key);
    for (const flag of [parsed.short, parsed.long]) {
      if (!flag) continue;
      if (flags.has(flag)) throw new Error(`Command ${definition.name} has a duplicate or reserved option flag ${flag}.`);
      flags.add(flag);
    }
    if (option.default !== undefined) {
      const value = option.default;
      const valid = parsed.variadic
        ? Array.isArray(value) && value.every(item => typeof item === "string")
        : parsed.required || parsed.optional
          ? typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || (parsed.optional && typeof value === "boolean")
          : typeof value === "boolean";
      if (!valid) throw new Error(`Option ${parsed.long} has an invalid default.`);
    }
    return Object.freeze({ ...option, default: copyDefault(option.default) });
  });

  return Object.freeze({
    name: definition.name, description: definition.description,
    arguments: Object.freeze(args), options: Object.freeze(options), isolation, handle: definition.handle.bind(definition),
  });
}

/** Resolve injectable I/O and take an environment snapshot, without modifying process state. */
export function resolveCommandContext(context: ApplicationCommandContext = {}): CommandContext {
  return Object.freeze({
    root: resolve(context.root ?? process.cwd()),
    env: Object.freeze({ ...(context.env ?? process.env) }),
    output: context.output ?? console.log,
    error: context.error ?? console.error,
    services: context.services,
    prompts: context.prompts ?? createPrompts({ input: process.stdin, output: process.stderr }),
    signal: context.signal,
    call: context.call,
  });
}

/** Invoke a handler directly for reusable in-process tests. No parsing, printing or process exit. */
export async function executeCommand(definition: CommandDefinition, input: CommandInput, context: CommandContext): Promise<number> {
  const isolation = definition.isolation;
  const release = isolation ? await acquireCommandLock(context.root, isolation.key ?? definition.name) : undefined;
  if (isolation && !release) {
    context.output(`Command ${definition.name} skipped: isolation lock is already held.`);
    return isolation.contentionExitCode ?? 0;
  }
  let failure: unknown;
  let failed = false;
  try {
    const result = await definition.handle(input, context);
    const code = result === undefined ? 0 : result;
    if (!Number.isInteger(code) || code < 0 || code > 255) {
      throw new Error(`Command ${definition.name} must return an integer exit code from 0 to 255, or undefined.`);
    }
    return code;
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    if (release) {
      try { await release(); } catch (error) {
        if (failed) throw new AggregateError([failure, error], "Command and isolation lock release both failed.");
        throw error;
      }
    }
  }
}

/**
 * Preflight every definition and name/option collision, then attach the whole batch.
 * Nonzero handler results throw CommandExitError, preserving the exact status for a host's
 * CommanderError boundary. This library never exits or changes process.exitCode.
 * Handler exceptions and Commander validation/help exceptions propagate to the host.
 */
export function registerCommands(program: Command, definitions: readonly CommandDefinition[], context: ApplicationCommandContext = {}): readonly CommandDefinition[] {
  const validated = definitions.map(definition => defineCommand(definition));
  const names = new Set(["help"]);
  // Include hidden commands, aliases, and implicit help independently of help rendering.
  const helpCommand = (program as CommandWithImplicitHelp)._getHelpCommand();
  for (const command of [...program.commands, ...(helpCommand ? [helpCommand] : [])]) {
    for (const name of [command.name(), ...command.aliases()]) names.add(name);
  }
  const reservedFlags = new Set<string>();
  const reservedAttributes = new Set<string>();
  for (let ancestor: Command | null = program; ancestor; ancestor = ancestor.parent) {
    const helpOption = (ancestor as CommandWithImplicitHelp)._getHelpOption();
    for (const option of [...ancestor.options, ...(helpOption ? [helpOption] : [])]) {
      if (option.short) reservedFlags.add(option.short);
      if (option.long) reservedFlags.add(option.long);
      reservedAttributes.add(option.attributeName());
    }
  }
  for (const definition of validated) {
    if (names.has(definition.name)) throw new Error(`Application command ${definition.name} conflicts with an existing or reserved command.`);
    names.add(definition.name);
    for (const option of definition.options ?? []) {
      const parsed = optionFrom(option);
      if (reservedAttributes.has(parsed.attributeName()) || [parsed.short, parsed.long].some(flag => flag && reservedFlags.has(flag))) {
        throw new Error(`Application command ${definition.name} option ${parsed.long} conflicts with a global or help option.`);
      }
    }
  }

  const handlerContext = resolveCommandContext(context);
  const prepared = validated.map(definition => {
    const command = new Command(definition.name)
      .copyInheritedSettings(program)
      // Application options must never overwrite Commander's own methods or fields.
      .storeOptionsAsProperties(false)
      .description(definition.description)
      .allowExcessArguments(false)
      .exitOverride()
      .configureOutput({
        writeOut: text => handlerContext.output(text.replace(/\n$/, "")),
        writeErr: text => handlerContext.error(text.replace(/\n$/, "")),
      });
    // Commander validates required arguments before action hooks. For prompt-enabled
    // commands, parse them as optional then enforce original requirements below.
    const prompting = definition.arguments?.some(argument => argument.prompt !== undefined) ?? false;
    for (const argument of definition.arguments ?? []) {
      const label = `${argument.name}${argument.variadic ? "..." : ""}`;
      const parsed = new Argument(argument.required === false || prompting ? `[${label}]` : `<${label}>`, argument.prompt ? `${argument.description ?? argument.name} (prompts if omitted)` : argument.description);
      if (argument.default !== undefined) parsed.default(Array.isArray(argument.default) ? [...argument.default] : argument.default);
      logicalRequirements.set(parsed, argument.required !== false);
      command.addArgument(parsed);
    }
    if (prompting) {
      const usageArgs = (definition.arguments ?? []).map(argument => {
        const label = `${argument.name}${argument.variadic ? "..." : ""}`;
        return argument.required === false ? `[${label}]` : `<${label}>`;
      });
      command.usage(`[options] ${usageArgs.join(" ")}`);
    }
    for (const option of definition.options ?? []) command.addOption(optionFrom(option));
    command.action(async () => {
      const args = Object.fromEntries((definition.arguments ?? []).map((argument, index) => [argument.name, copyDefault(command.processedArgs[index])]));
      const missing = (argument: CommandArgument) => args[argument.name] === undefined || (argument.variadic && (args[argument.name] as readonly string[]).length === 0);
      if (prompting) {
        for (const argument of definition.arguments ?? []) {
          if (argument.required !== false && argument.prompt === undefined && missing(argument)) {
            command.error(`Missing required argument '${argument.name}'.`, { exitCode: 1, code: "commander.missingArgument" });
          }
        }
        for (const argument of definition.arguments ?? []) {
          if (argument.prompt !== undefined && missing(argument)) {
            args[argument.name] = await handlerContext.prompts!.text({ message: argument.prompt, signal: handlerContext.signal, validate: value => value.trim() ? undefined : "A value is required." });
          }
        }
      }
      const options = Object.fromEntries(Object.entries(command.opts()).map(([name, value]) => [name, copyDefault(value)]));
      const code = await executeCommand(definition, { args: Object.freeze(args), options: Object.freeze(options) }, handlerContext);
      if (code !== 0) throw new CommandExitError(definition.name, code);
    });
    return command;
  });
  // All validation and command construction happened above; no partial registration on invalid input.
  for (const command of prepared) program.addCommand(command);
  return Object.freeze(validated);
}
