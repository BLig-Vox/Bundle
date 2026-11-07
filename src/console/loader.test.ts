import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { loadApplicationCommands } from "./loader.ts";

const commandModule = new URL("./command.ts", import.meta.url).href;
const loaderModule = new URL("./loader.ts", import.meta.url).href;
const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

async function fixture(makeDirectory = true) {
  const root = await mkdtemp(join(tmpdir(), "bundle-commands-"));
  roots.push(root);
  const directory = join(root, "src", "commands");
  if (makeDirectory) await mkdir(directory, { recursive: true });
  const program = new Command("bundle").exitOverride();
  program.command("list").alias("ls").action(() => {});
  const output: string[] = [];
  const error: string[] = [];
  const context = {
    root, env: { APP_LABEL: "injected", SECRET: "never-dump-this" },
    output: (text: string) => { output.push(text); }, error: (text: string) => { error.push(text); },
  };
  const module = (filename: string, source: string) => writeFile(join(directory, filename), source);
  return { root, directory, program, output, error, context, module };
}

function source(name: string) {
  return `export default { name: ${JSON.stringify(name)}, description: "Fixture command", async handle() { return 0; } };`;
}

describe("application command loader", () => {
  test("imports a genuine TypeScript command with positional/options parsing and async I/O", async () => {
    const { program, context, root, module, output, error } = await fixture();
    await module("Greet.ts", `
      import { defineCommand } from ${JSON.stringify(commandModule)};
      const punctuation: string = "!";
      export default defineCommand({
        name: "demo:greet", description: "A project command",
        arguments: [{ name: "name", required: false, default: "World" }],
        options: [{ flags: "-g, --greeting <text>", default: "Hello" }, { flags: "--loud" }],
        async handle({ args, options }, { root, env, output, error }) {
          await Promise.resolve();
          output(JSON.stringify({ text: options.greeting + ", " + args.name + punctuation, loud: options.loud, root, label: env.APP_LABEL }));
          error("fixture diagnostic");
          return 3;
        }
      });
    `);
    const definitions = await loadApplicationCommands(program, context);
    expect(definitions.map(command => command.name)).toEqual(["demo:greet"]);
    expect(program.helpInformation()).toContain("demo:greet");
    await expect(program.parseAsync(["demo:greet", "Ada", "-g", "Hi", "--loud"], { from: "user" })).rejects.toMatchObject({ code: "bundle.commandExit", exitCode: 3 });
    expect(JSON.parse(output[0]!)).toEqual({ text: "Hi, Ada!", loud: true, root, label: "injected" });
    expect(output.join("\n")).not.toContain("never-dump-this");
    expect(error).toEqual(["fixture diagnostic"]);
    await expect(program.parseAsync(["demo:greet"], { from: "user" })).rejects.toMatchObject({ code: "bundle.commandExit", exitCode: 3 });
    expect(JSON.parse(output[1]!).text).toBe("Hello, World!");
  });

  test("loads named/default definitions in deterministic file/export order and deduplicates export aliases", async () => {
    const { program, context, module } = await fixture();
    await module("z.ts", source("last"));
    await module("a.ts", `
      export const zCommand = { name: "named:z", description: "Z", handle() {} };
      export const aCommand = { name: "named:a", description: "A", handle() {} };
      export default aCommand;
    `);
    const definitions = await loadApplicationCommands(program, context);
    expect(definitions.map(command => command.name)).toEqual(["named:a", "named:z", "last"]);
    expect(program.commands.map(command => command.name())).toEqual(["list", "named:a", "named:z", "last"]);
  });

  test("missing command directory is empty; tests, declarations, nested files and symlinks are not executed", async () => {
    const missing = await fixture(false);
    expect(await loadApplicationCommands(missing.program, missing.context)).toEqual([]);
    expect(missing.program.commands.map(command => command.name())).toEqual(["list"]);
    const { program, context, root, directory, module } = await fixture();
    for (const filename of ["bad.test.ts", "bad.spec.ts", "bad.d.ts", "bad.js"]) {
      await module(filename, `throw new Error("Excluded file executed");`);
    }
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "nested", "Bad.ts"), `throw new Error("Nested file executed");`);
    await writeFile(join(root, "external.ts"), `throw new Error("Symlink executed");`);
    await symlink(join(root, "external.ts"), join(directory, "Link.ts"));
    await module("Valid.ts", source("valid"));
    expect((await loadApplicationCommands(program, context)).map(command => command.name)).toEqual(["valid"]);
  });

  test("does not mistake non-directory or other I/O errors for an empty command directory", async () => {
    const { program, context, root, directory } = await fixture(false);
    await mkdir(join(root, "src"));
    await writeFile(directory, "not a directory");
    await expect(loadApplicationCommands(program, context)).rejects.toMatchObject({ code: "ENOTDIR" });
    expect(program.commands).toHaveLength(1);
  });

  test("invalid later exports do not partially register earlier modules", async () => {
    const badSources = [
      `export default { name: "bad", description: "Missing handler" };`,
      `export const invalid = 42;`,
      `export {};`,
      `export default ${JSON.stringify("never-dump-this")};`,
      `export default { name: "bad", description: "Bad argument", arguments: [{ name: "x", variadic: true }, { name: "y" }], handle() {} };`,
      `const broken: = 1;`,
    ];
    for (const bad of badSources) {
      const { program, context, module, output, error } = await fixture();
      await module("a-valid.ts", source("valid"));
      await module("z-invalid.ts", bad);
      await expect(loadApplicationCommands(program, context)).rejects.toThrow();
      expect(program.commands.map(command => command.name())).toEqual(["list"]);
      expect(output).toEqual([]);
      expect(error).toEqual([]);
    }
  });

  test("reports import failures without copying exception secrets into the CLI message", async () => {
    const { program, context, module } = await fixture();
    await module("Bad.ts", `throw new Error("never-dump-this"); export default {};`);
    try {
      await loadApplicationCommands(program, context);
      throw new Error("Expected an import failure");
    } catch (failure) {
      expect((failure as Error).message).toContain("Unable to import application command module src/commands/Bad.ts");
      expect((failure as Error).message).not.toContain("never-dump-this");
    }
    expect(program.commands.map(command => command.name())).toEqual(["list"]);
  });

  test("preflights duplicate, built-in, alias, reserved help and global option collisions", async () => {
    for (const name of ["duplicate", "list", "ls", "help"]) {
      const { program, context, module } = await fixture();
      await module("a.ts", source("duplicate"));
      await module("z.ts", source(name));
      await expect(loadApplicationCommands(program, context)).rejects.toThrow("conflicts");
      expect(program.commands.map(command => command.name())).toEqual(["list"]);
    }
    const { program, context, module } = await fixture();
    program.option("--force");
    await module("a.ts", source("valid"));
    await module("z.ts", `export default { name: "bad", description: "Bad option", options: [{ flags: "--force" }], handle() {} };`);
    await expect(loadApplicationCommands(program, context)).rejects.toThrow("global or help option");
    expect(program.commands.map(command => command.name())).toEqual(["list"]);
  });

  test("rejects duplicate distinct named definitions but accepts an intentionally empty directory", async () => {
    const { program, context, module } = await fixture();
    expect(await loadApplicationCommands(program, context)).toEqual([]);
    await module("Both.ts", `
      export const one = { name: "same", description: "One", handle() {} };
      export const two = { name: "same", description: "Two", handle() {} };
    `);
    await expect(loadApplicationCommands(program, context)).rejects.toThrow("conflicts");
    expect(program.commands.map(command => command.name())).toEqual(["list"]);
  });

  test("real Bun hosts apply numeric exit codes and handle parsing/async failures without global test mutation", async () => {
    const { root, module } = await fixture();
    await module("Status.ts", `
      import { defineCommand } from ${JSON.stringify(commandModule)};
      export const status = defineCommand({
        name: "exit:status", description: "Return an exit status",
        arguments: [{ name: "code", required: false, default: "0" }],
        async handle({ args }, { output }) { await Promise.resolve(); output("completed"); return Number(args.code); }
      });
      export const fail = defineCommand({
        name: "exit:fail", description: "Fail asynchronously",
        async handle() { await Promise.resolve(); throw new Error("handler failed"); }
      });
    `);
    const runner = join(root, "runner.ts");
    await writeFile(runner, `
      import { Command, CommanderError } from ${JSON.stringify(import.meta.resolve("commander"))};
      import { loadApplicationCommands } from ${JSON.stringify(loaderModule)};
      const program = new Command("fixture").exitOverride();
      try {
        await loadApplicationCommands(program, { root: ${JSON.stringify(root)}, env: {} });
        await program.parseAsync(process.argv.slice(2), { from: "user" });
      } catch (error) {
        if (error instanceof CommanderError) process.exitCode = error.exitCode;
        else { console.error(error.message); process.exitCode = 1; }
      }
    `);
    const cases = [
      { args: ["exit:status"], code: 0, stdout: "completed", stderr: "" },
      { args: ["exit:status", "9"], code: 9, stdout: "completed", stderr: "" },
      { args: ["exit:status", "256"], code: 1, stdout: "completed", stderr: "integer exit code" },
      { args: ["exit:fail"], code: 1, stdout: "", stderr: "handler failed" },
      { args: ["exit:status", "--unknown"], code: 1, stdout: "", stderr: "unknown option" },
      { args: ["exit:status", "--help"], code: 0, stdout: "Return an exit status", stderr: "" },
    ];
    for (const fixture of cases) {
      const child = Bun.spawn([process.execPath, runner, ...fixture.args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(code).toBe(fixture.code);
      expect(stdout).toContain(fixture.stdout);
      expect(stderr).toContain(fixture.stderr);
      if (!fixture.stdout) expect(stdout).toBe("");
      if (!fixture.stderr) expect(stderr).toBe("");
    }
  });
});
