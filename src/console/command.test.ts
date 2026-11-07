import { describe, expect, test } from "bun:test";
import { Command, CommanderError, Option } from "commander";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApplicationCommands } from "./loader.ts";
import {
  CommandExitError, defineCommand, executeCommand, registerCommands, resolveCommandContext,
  type CommandDefinition, type CommandInput,
} from "./command.ts";

const noop = () => {};
const definition = (name = "example"): CommandDefinition => ({ name, description: "An example", handle: noop });

function harness() {
  const output: string[] = [];
  const error: string[] = [];
  const program = new Command("bundle").exitOverride();
  const context = {
    root: "/tmp/bundle-custom-command", env: { EXAMPLE: "injected" },
    output: (text: string) => { output.push(text); },
    error: (text: string) => { error.push(text); },
  };
  return { program, context, output, error };
}

async function fixture(run: (root: string, directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "bundle-command-loader-"));
  const directory = join(root, "src", "commands");
  try {
    await mkdir(directory, { recursive: true });
    await run(root, directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const moduleSource = (name: string) => `export default {
  name: ${JSON.stringify(name)}, description: "Loaded fixture command",
  handle(_, { output }) { output(${JSON.stringify(name)}); }
};`;

describe("application command loading", () => {
  test("missing directories are empty and return an immutable result", async () => {
    await fixture(async root => {
      await rm(join(root, "src"), { recursive: true });
      const { program, context } = harness();
      const loaded = await loadApplicationCommands(program, { ...context, root });
      expect(loaded).toEqual([]);
      expect(Object.isFrozen(loaded)).toBe(true);
      expect(program.commands).toEqual([]);
    });
  });

  test("loads sorted files and exports, deduplicates exports and excludes noncommand files", async () => {
    await fixture(async (root, directory) => {
      await writeFile(join(directory, "z.ts"), moduleSource("last"));
      await writeFile(join(directory, "a.ts"), `
        const shared = { name: "first", description: "Shared command", handle() {} };
        export const z = { name: "second", description: "Named command", handle() {} };
        export { shared as a, shared as default };
      `);
      for (const name of ["ignored.d.ts", "ignored.test.ts", "ignored.spec.ts", "ignored.js"]) {
        await writeFile(join(directory, name), "throw new Error('excluded file imported');");
      }
      await mkdir(join(directory, "nested.ts"));
      await writeFile(join(directory, "nested.ts", "nested.ts"), moduleSource("nested"));
      await writeFile(join(root, "external.ts"), "throw new Error('symlink imported');");
      await symlink(join(root, "external.ts"), join(directory, "linked.ts"));
      const { program, context, output } = harness();
      const loaded = await loadApplicationCommands(program, { ...context, root });
      expect(loaded.map(item => item.name)).toEqual(["first", "second", "last"]);
      expect(Object.isFrozen(loaded)).toBe(true);
      await program.parseAsync(["last"], { from: "user" });
      expect(output).toEqual(["last"]);
    });
  });

  test("rejects invalid, empty, conflicting and throwing modules without partial registration", async () => {
    for (const source of [
      "export const helper = 42;",
      "export {};",
      moduleSource("first"),
      moduleSource("reserved"),
      "throw new Error('private-import-secret'); export default {};",
    ]) {
      await fixture(async (root, directory) => {
        await writeFile(join(directory, "a.ts"), moduleSource("first"));
        await writeFile(join(directory, "z.ts"), source);
        const { program, context } = harness();
        program.command("reserved").action(noop);
        const original = [...program.commands];
        try {
          await loadApplicationCommands(program, { ...context, root });
          throw new Error("Expected loader rejection");
        } catch (failure) {
          expect(failure).toBeInstanceOf(Error);
          expect((failure as Error).message).not.toBe("Expected loader rejection");
          expect((failure as Error).message).not.toContain("private-import-secret");
        }
        expect(program.commands).toEqual(original);
      });
    }
  });

  test("real Bun process loads typed runtime code and preserves a returned failure status", async () => {
    await fixture(async (root, directory) => {
      const commandUrl = new URL("./command.ts", import.meta.url).href;
      const loaderUrl = new URL("./loader.ts", import.meta.url).href;
      await writeFile(join(directory, "Status.ts"), `
        import { defineCommand } from ${JSON.stringify(commandUrl)};
        export default defineCommand({
          name: "status:fixture", description: "Runtime status fixture",
          arguments: [{ name: "recipient" }], options: [{ flags: "-t, --tag <values...>" }],
          async handle({ args, options }, { output, env }) {
            await Promise.resolve();
            output(JSON.stringify({ recipient: args.recipient, tags: options.tag, marker: env.BUNDLE_COMMAND_FIXTURE }));
            return 23;
          },
        });
      `);
      const runner = join(root, "runner.ts");
      await writeFile(runner, `
        import { Command, CommanderError } from ${JSON.stringify(import.meta.resolve("commander"))};
        import { loadApplicationCommands } from ${JSON.stringify(loaderUrl)};
        const program = new Command("bundle").exitOverride();
        try {
          await loadApplicationCommands(program, { root: ${JSON.stringify(root)} });
          await program.parseAsync(["status:fixture", "Ada", "-t", "a", "b"], { from: "user" });
        } catch (error) {
          if (!(error instanceof CommanderError)) throw error;
          process.exitCode = error.exitCode;
        }
      `);
      const child = Bun.spawn({
        cmd: [process.execPath, runner], cwd: root,
        env: { ...process.env, BUNDLE_COMMAND_FIXTURE: "injected-runtime" },
        stdout: "pipe", stderr: "pipe",
      });
      const [status, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      expect(status).toBe(23);
      expect(JSON.parse(stdout)).toEqual({ recipient: "Ada", tags: ["a", "b"], marker: "injected-runtime" });
      expect(stderr).toBe("");
    });
  });
});

describe("custom command definitions", () => {
  test("defines immutable metadata without mutating the caller's input", () => {
    const args = [{ name: "targets", required: false, variadic: true, default: ["first"] }];
    const options = [{ flags: "--tags <values...>", default: ["original"] }];
    const command = defineCommand({ ...definition(), arguments: args, options });
    args[0]!.name = "changed";
    args[0]!.default.push("second");
    options[0]!.default.push("changed");
    expect(command.arguments?.[0]?.name).toBe("targets");
    expect(command.arguments?.[0]?.default).toEqual(["first"]);
    expect(command.options?.[0]?.default).toEqual(["original"]);
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.options?.[0]?.default)).toBe(true);
  });

  test("class-based command handlers retain private instance state through normalization and registration", async () => {
    const { program, context, output } = harness();
    class GreetingCommand {
      readonly name = "class:greet";
      readonly description = "A reusable stateful command";
      #greeting = "Hello from the instance";
      calls = 0;
      handle(_input: CommandInput, commandContext: { output: (text: string) => void }) {
        this.calls++;
        commandContext.output(this.#greeting);
      }
    }
    const command = new GreetingCommand();
    const normalized = defineCommand(command);
    await executeCommand(normalized, { args: {}, options: {} }, resolveCommandContext(context));
    registerCommands(program, [normalized], context);
    await program.parseAsync(["class:greet"], { from: "user" });
    expect(output).toEqual(["Hello from the instance", "Hello from the instance"]);
    expect(command.calls).toBe(2);
  });

  test("parses short aliases, option defaults, optional arguments and async injected output", async () => {
    const { program, context, output, error } = harness();
    const before = process.exitCode;
    registerCommands(program, [defineCommand({
      name: "greet", description: "Greet someone",
      arguments: [{ name: "name", required: false, default: "World" }],
      options: [
        { flags: "-g, --greeting <text>", default: "Hello" },
        { flags: "--dry-run" }, { flags: "--no-color" },
      ],
      async handle({ args, options }, injected) {
        await Promise.resolve();
        expect(injected.root).toBe(context.root);
        expect(injected.env.EXAMPLE).toBe("injected");
        expect(Object.isFrozen(injected.env)).toBe(true);
        injected.output(`${options.greeting}, ${args.name}! dry=${options.dryRun} color=${options.color}`);
        injected.error("an intentional diagnostic");
        return 7;
      },
    })], context);
    for (const args of [["greet", "Ada", "-g", "Hi", "--dry-run", "--no-color"], ["greet"]]) {
      try {
        await program.parseAsync(args, { from: "user" });
        throw new Error("Expected the nonzero handler status to propagate");
      } catch (failure) {
        expect(failure).toBeInstanceOf(CommandExitError);
        expect(failure).toBeInstanceOf(CommanderError);
        expect((failure as CommandExitError).exitCode).toBe(7);
        expect((failure as CommandExitError).commandName).toBe("greet");
      }
    }
    expect(output).toEqual(["Hi, Ada! dry=true color=false", "Hello, World! dry=undefined color=true"]);
    expect(error).toEqual(["an intentional diagnostic", "an intentional diagnostic"]);
    expect(process.exitCode).toBe(before);
  });

  test("parses required and variadic arguments, optional option values and variadic options", async () => {
    const { program, context } = harness();
    const inputs: CommandInput[] = [];
    registerCommands(program, [defineCommand({
      name: "copy:files", description: "Collect inputs",
      arguments: [{ name: "source" }, { name: "targets", required: false, variadic: true, default: ["default"] }],
      options: [{ flags: "-t, --tag <values...>", default: ["base"] }, { flags: "--format [name]", default: "json" }],
      handle(input) { inputs.push(input); },
    })], context);
    await program.parseAsync(["copy:files", "source", "one", "two", "-t", "a", "b", "--format"], { from: "user" });
    await program.parseAsync(["copy:files", "source"], { from: "user" });
    await program.parseAsync(["copy:files", "source", "-t", "a", "--tag", "b"], { from: "user" });
    expect(inputs[2]?.options.tag).toEqual(["a", "b"]);
    expect(inputs[0]).toEqual({ args: { source: "source", targets: ["one", "two"] }, options: { tag: ["a", "b"], format: true } });
    expect(inputs[1]).toEqual({ args: { source: "source", targets: ["default"] }, options: { tag: ["base"], format: "json" } });
    expect(Object.isFrozen(inputs[0]?.args.targets)).toBe(true);
    expect(Object.isFrozen(inputs[0]?.options.tag)).toBe(true);
  });

  test("keeps application options separate from Commander methods on property-based hosts", async () => {
    const { program, context } = harness();
    program.storeOptionsAsProperties();
    const inputs: CommandInput[] = [];
    registerCommands(program, [{
      ...definition(),
      options: [{ flags: "--opts" }, { flags: "--name <value>", default: "default" }],
      handle(input) { inputs.push(input); },
    }], context);
    await program.parseAsync(["example", "--opts", "--name", "custom"], { from: "user" });
    expect(inputs).toEqual([{ args: {}, options: { opts: true, name: "custom" } }]);
    expect(program.commands[0]!.name()).toBe("example");
  });

  test("parses required and optional variadic placeholders ending in hyphens", async () => {
    const { program, context } = harness();
    const inputs: CommandInput[] = [];
    registerCommands(program, [{
      ...definition(),
      options: [
        { flags: "--tags <tag-...>", default: ["base"] },
        { flags: "--labels [label-...]" },
      ],
      handle(input) { inputs.push(input); },
    }], context);
    await program.parseAsync(["example", "--tags", "a", "b", "--labels", "one", "two"], { from: "user" });
    await program.parseAsync(["example"], { from: "user" });
    expect(inputs[0]?.options).toEqual({ tags: ["a", "b"], labels: ["one", "two"] });
    expect(inputs[1]?.options).toEqual({ tags: ["base"] });
  });

  test("routes parser errors/help to injected sinks and never runs the handler for them", async () => {
    const { program, context, output, error } = harness();
    let calls = 0;
    registerCommands(program, [defineCommand({
      ...definition("required"), arguments: [{ name: "value" }], options: [{ flags: "--label <text>" }],
      handle() { calls++; },
    })], context);
    for (const argv of [["required"], ["required", "a", "b"], ["required", "a", "--unknown"], ["required", "a", "--label"]]) {
      await expect(program.parseAsync(argv, { from: "user" })).rejects.toBeInstanceOf(CommanderError);
    }
    try {
      await program.parseAsync(["required", "--help"], { from: "user" });
      throw new Error("Expected Commander help to return via exitOverride");
    } catch (failure) {
      expect(failure).toBeInstanceOf(CommanderError);
      expect((failure as CommanderError).exitCode).toBe(0);
    }
    expect(error).toHaveLength(4);
    expect(output.join("\n")).toContain("--label <text>");
    expect(calls).toBe(0);
  });

  test("executes directly with injected I/O and validates numeric exit codes", async () => {
    const output: string[] = [];
    const context = resolveCommandContext({ root: "/tmp", env: {}, output: text => { output.push(text); }, error: noop });
    const input = { args: {}, options: {} };
    expect(await executeCommand(defineCommand({ ...definition(), handle: (_, { output }) => { output("direct"); } }), input, context)).toBe(0);
    expect(await executeCommand(defineCommand({ ...definition(), handle: async () => 255 }), input, context)).toBe(255);
    expect(output).toEqual(["direct"]);
    for (const code of [-1, 256, 1.5, NaN, Infinity, null, "1"]) {
      const invalid = { ...definition(), handle: () => code } as unknown as CommandDefinition;
      await expect(executeCommand(invalid, input, context)).rejects.toThrow("integer exit code");
    }
  });

  test("propagates handler failures without serializing context or changing process state", async () => {
    const { program, context, output, error } = harness();
    context.env.EXAMPLE = "secret-not-to-dump";
    const failure = new Error("deliberate failure");
    registerCommands(program, [defineCommand({ ...definition(), async handle() { throw failure; } })], context);
    await expect(program.parseAsync(["example"], { from: "user" })).rejects.toBe(failure);
    expect(output).toEqual([]);
    expect(error).toEqual([]);
  });

  test("rejects malformed definitions and argument/option metadata", () => {
    const bad: unknown[] = [
      null, { ...definition(), name: "invalid name" }, { ...definition(), name: "Bad" },
      { ...definition(), description: "" }, { ...definition(), handle: "not a function" },
      { ...definition(), arguments: {} }, { ...definition(), options: {} },
      { ...definition(), arguments: [{ name: "../escape" }] },
      { ...definition(), arguments: [{ name: "same" }, { name: "same" }] },
      { ...definition(), arguments: [{ name: "optional", required: false }, { name: "required" }] },
      { ...definition(), arguments: [{ name: "many", variadic: true }, { name: "other" }] },
      { ...definition(), arguments: [{ name: "required", default: "unused" }] },
      { ...definition(), arguments: [{ name: "optional", required: false, default: [] }] },
      { ...definition(), arguments: [{ name: "many", required: false, variadic: true, default: "not-array" }] },
      { ...definition(), arguments: [{ name: "value", required: "false" }] },
      { ...definition(), options: [{ flags: "not-flags" }] },
      { ...definition(), options: [{ flags: "--help" }] },
      { ...definition(), options: [{ flags: "-h, --host <name>" }] },
      { ...definition(), options: [{ flags: "--constructor" }] },
      { ...definition(), options: [{ flags: "--flag", default: "not-boolean" }] },
      { ...definition(), options: [{ flags: "--amount <value>", default: NaN }] },
      { ...definition(), options: [{ flags: "--tag <values...>", default: [1] }] },
      { ...definition(), options: [{ flags: "--dry-run" }, { flags: "--dryRun" }] },
      { ...definition(), options: [{ flags: "-x, --one" }, { flags: "-x, --two" }] },
      { ...definition(), options: [{ flags: "--color" }, { flags: "--no-color" }] },
      { ...definition(), options: [{ flags: "--foo-bar" }, { flags: "--foo--bar" }] },
    ];
    for (const value of bad) expect(() => defineCommand(value as CommandDefinition)).toThrow();
  });

  test("rejects trailing line terminators in command names, argument names and flags", () => {
    for (const ending of ["\n", "\r", "\r\n", " ", " "]) {
      expect(() => defineCommand({ ...definition(), name: `example${ending}` })).toThrow();
      expect(() => defineCommand({ ...definition(), arguments: [{ name: `name${ending}` }] })).toThrow();
      expect(() => defineCommand({ ...definition(), options: [{ flags: `--flag${ending}` }] })).toThrow();
    }
  });

  test("reserves hidden implicit help commands, aliases and option flags", () => {
    const { program, context } = harness();
    program.addHelpCommand(Object.assign(new Command("usage").alias("guide"), { _hidden: true }));
    program.addHelpOption(new Option("-H, --assist").hideHelp());
    const conflicts = [
      definition("usage"), definition("guide"),
      { ...definition(), options: [{ flags: "--assist" }] },
      { ...definition(), options: [{ flags: "-H, --host <value>" }] },
      { ...definition(), options: [{ flags: "--no-assist" }] },
    ];
    for (const conflict of conflicts) {
      expect(() => registerCommands(program, [definition("first"), conflict], context)).toThrow("conflicts");
      expect(program.commands).toEqual([]);
    }
  });

  test("collision checks do not depend on customized help rendering", () => {
    const { program, context } = harness();
    program.helpCommand("usage [command]").helpOption("-H, --assist");
    program.configureHelp({ visibleCommands: () => [], visibleOptions: () => [] });
    expect(() => registerCommands(program, [definition("usage")], context)).toThrow("conflicts");
    expect(() => registerCommands(program, [{ ...definition(), options: [{ flags: "--assist" }] }], context)).toThrow("conflicts");
    expect(program.commands).toEqual([]);
  });

  test("deduplicates the same command exported through multiple loader modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "bundle-command-reexports-"));
    try {
      const directory = join(root, "src", "commands");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "Greet.ts"), `
        export default {
          name: "greet", description: "A shared command",
          handle(_, { output }) { output("hello"); }
        };
      `);
      await writeFile(join(directory, "index.ts"), `export { default as greet } from "./Greet.ts";`);
      const { program, context, output } = harness();
      const definitions = await loadApplicationCommands(program, { ...context, root });
      expect(definitions.map(command => command.name)).toEqual(["greet"]);
      expect(program.commands.map(command => command.name())).toEqual(["greet"]);
      await program.parseAsync(["greet"], { from: "user" });
      expect(output).toEqual(["hello"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preflights all definitions before registration, preserving built-ins", () => {
    const { program, context } = harness();
    program.command("list").alias("ls").action(noop);
    program.option("-f, --force");
    program.helpCommand("usage [command]");
    program.helpOption("-H, --assist");
    const original = [...program.commands];
    const invalid = [
      definition("list"), definition("ls"), definition("help"), definition("usage"),
      { ...definition("second"), options: [{ flags: "--force" }] },
      { ...definition("second"), options: [{ flags: "-f, --file <path>" }] },
      { ...definition("second"), options: [{ flags: "--no-force" }] },
      { ...definition("second"), options: [{ flags: "--assist" }] },
      { ...definition("second"), arguments: [{ name: "one", variadic: true }, { name: "two" }] },
    ];
    for (const conflict of invalid) {
      expect(() => registerCommands(program, [definition("first"), conflict], context)).toThrow();
      expect(program.commands).toEqual(original);
    }
    expect(() => registerCommands(program, [definition("duplicate"), definition("duplicate")], context)).toThrow("conflicts");
    expect(program.commands).toEqual(original);
  });
});
