import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { createCli } from "./program.ts";
import { registerDiscovery } from "./discovery.ts";

async function run(...args: string[]) {
  const messages: string[] = [];
  const program = createCli({ env: { DB_CONNECTION: "invalid" }, output: message => messages.push(message) });
  await program.parseAsync(args, { from: "user" });
  return messages.join("\n");
}

describe("command discovery without database configuration", () => {
  test("filters namespace rather than matching partial names", async () => {
    const listing = await run("list", "make");
    expect(listing).toContain("make:model");
    expect(listing).toContain("make:migration");
    expect(listing).not.toContain("db:seed");
    expect(await run("list", "mak", "--raw")).toBe("");
  });

  test("raw listing is sorted and has no heading", async () => {
    const listing = await run("list", "migrate", "--raw");
    expect(listing.startsWith("migrate  ")).toBe(true);
    expect(listing).toContain("migrate:rollback");
    expect(listing).not.toContain("Available commands");
    const names = listing.split("\n").map(line => line.split("  ")[0]!);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
  });

  test("JSON enumerates real command arguments, options and aliases", async () => {
    const listing = JSON.parse(await run("list", "make", "--format", "json"));
    expect(listing.name).toBe("bundle");
    const model = listing.commands.find((command: { name: string }) => command.name === "make:model");
    expect(model.arguments[0]).toMatchObject({ name: "name", required: true });
    expect(model.options.some((option: { flags: string }) => option.flags === "-m, --migration")).toBe(true);
    expect(listing.commands.every((command: { name: string }) => command.name.startsWith("make:"))).toBe(true);
  });

  test("help resolves commands, aliases and nested commands without running their actions", async () => {
    expect(await run("help", "migrate")).toContain("--pretend");
    expect(await run("help")).toContain("Usage: bundle");
    const messages: string[] = [];
    const root = new Command().name("bundle").exitOverride();
    registerDiscovery(root, message => messages.push(message));
    root.command("tools").command("inspect").alias("peek").description("Inspect fixture").action(() => { throw new Error("Must not run"); });
    await root.parseAsync(["help", "tools", "peek"], { from: "user" });
    expect(messages[0]).toContain("Inspect fixture");
    await expect(run("help", "unknown")).rejects.toThrow("Unknown command");
  });

  test("unsupported output formats fail and help/version return successful exit codes", async () => {
    const program = new Command().name("test").exitOverride().configureOutput({ writeErr() {} });
    registerDiscovery(program, () => {});
    await expect(program.parseAsync(["list", "--format", "xml"], { from: "user" })).rejects.toMatchObject({ code: "commander.invalidArgument", exitCode: 1 });
    for (const args of [["--version"], ["--help"], ["migrate", "--help"]]) {
      const messages: string[] = [];
      const cli = createCli({ env: { DB_CONNECTION: "invalid" }, output: text => messages.push(text) })
        .configureOutput({ writeOut: text => messages.push(text), writeErr: text => messages.push(text) });
      await expect(cli.parseAsync(args, { from: "user" })).rejects.toMatchObject({ exitCode: 0 });
      expect(messages.length).toBeGreaterThan(0);
    }
  });
});
