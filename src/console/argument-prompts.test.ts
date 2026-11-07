import { describe, expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { Command } from "commander";
import { defineCommand, registerCommands } from "./command.ts";
import { createPrompts } from "./prompts.ts";
import { registerDiscovery } from "../cli/discovery.ts";

function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(value: boolean) { this.isRaw = value; return this; } });
  const chunks: string[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } });
  return { input, chunks, prompts: createPrompts({ input, output }) };
}

describe("automatic missing argument prompts", () => {
  test("prompts for declared missing arguments and leaves supplied arguments untouched", async () => {
    const tty = terminal();
    const received: unknown[] = [];
    const definition = defineCommand({ name: "greet", description: "Greet", arguments: [{ name: "name", prompt: "Your name" }], handle(input) { received.push(input.args.name); } });
    try {
      const program = new Command().exitOverride();
      registerCommands(program, [definition], { prompts: tty.prompts });
      const running = program.parseAsync(["greet"], { from: "user" });
      tty.input.write("Ada\n");
      await running;
      expect(received).toEqual(["Ada"]);
      expect(tty.chunks.join("")).toContain("Your name");
      const second = new Command().exitOverride();
      registerCommands(second, [definition], { prompts: tty.prompts });
      await second.parseAsync(["greet", "Provided"], { from: "user" });
      expect(received).toEqual(["Ada", "Provided"]);
    } finally { tty.input.destroy(); }
  });

  test("validates other required arguments before asking and rejects unsupported prompt metadata", async () => {
    const tty = terminal();
    const definition = defineCommand({ name: "greet", description: "Greet", arguments: [{ name: "name", prompt: "Name" }, { name: "other" }], handle() { throw new Error("must not execute"); } });
    const program = new Command().exitOverride().configureOutput({ writeErr() {} });
    const errors: string[] = [];
    registerCommands(program, [definition], { prompts: tty.prompts, error: text => errors.push(text) });
    try {
      await expect(program.parseAsync(["greet"], { from: "user" })).rejects.toThrow("other");
      expect(errors.join("")).toContain("other");
      expect(program.commands[0]!.helpInformation()).toContain("<name> <other>");
      expect(tty.chunks).toEqual([]);
      for (const argument of [{ name: "name", prompt: "", required: true }, { name: "name", prompt: "Name", required: false }, { name: "name", prompt: "Names", variadic: true }]) {
        expect(() => defineCommand({ name: "invalid", description: "Invalid", arguments: [argument], handle() {} })).toThrow("prompt");
      }
    } finally { tty.input.destroy(); }
  });

  test("discovery retains logical required argument metadata for prompt-enabled commands", async () => {
    const output: string[] = [];
    const program = new Command().exitOverride();
    registerDiscovery(program, text => output.push(text));
    registerCommands(program, [{ name: "greet", description: "Greet", arguments: [{ name: "name", prompt: "Name" }, { name: "other" }], handle() {} }]);
    await program.parseAsync(["list", "--format", "json"], { from: "user" });
    const command = JSON.parse(output[0]!).commands.find((command: { name: string }) => command.name === "greet");
    expect(command.arguments.map((argument: { required: boolean }) => argument.required)).toEqual([true, true]);
  });

  test("refuses noninteractive missing input and propagates cancellation without executing", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const definition = defineCommand({ name: "greet", description: "Greet", arguments: [{ name: "name", prompt: "Name" }], handle() { throw new Error("must not execute"); } });
    const program = new Command().exitOverride();
    registerCommands(program, [definition], { prompts: createPrompts({ input, output }) });
    try { await expect(program.parseAsync(["greet"], { from: "user" })).rejects.toThrow("interactive terminal"); }
    finally { input.destroy(); output.destroy(); }
    const tty = terminal();
    const abort = new AbortController();
    const cancelled = new Command().exitOverride();
    registerCommands(cancelled, [definition], { prompts: tty.prompts, signal: abort.signal });
    try {
      const running = cancelled.parseAsync(["greet"], { from: "user" });
      abort.abort();
      await expect(running).rejects.toThrow("aborted");
      expect(tty.input.isRaw).toBe(false);
    } finally { tty.input.destroy(); }
  });
});
