import { test, expect } from "bun:test";
import { mkdtemp, rm, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { createHash } from "node:crypto";
import { defineCommand, executeCommand, registerCommands, resolveCommandContext } from "./command.ts";
import { acquireCommandLock } from "./isolation.ts";

const input = { args: {}, options: {} };

test("overlapping commands skip with custom key and status, then release", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-isolation-"));
  try {
    let entered!: () => void, finish!: () => void;
    const ready = new Promise<void>(r => entered = r);
    const gate = new Promise<void>(r => finish = r);
    let calls = 0;
    const first = defineCommand({ name: "first", description: "First", isolation: { key: "shared", contentionExitCode: 12 }, async handle() { calls++; entered(); await gate; } });
    const second = defineCommand({ name: "second", description: "Second", isolation: { key: "shared", contentionExitCode: 12 }, handle() { calls++; } });
    const messages: string[] = [];
    const context = resolveCommandContext({ root, output: text => messages.push(text) });
    const running = executeCommand(first, input, context);
    await ready;
    expect(await executeCommand(second, input, context)).toBe(12);
    expect(calls).toBe(1);
    expect(messages.join(" ")).toMatch(/isolat|lock/i);
    finish(); await running;
    expect(await executeCommand(second, input, context)).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rapid concurrent acquisition tolerates lock removal between existence checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-isolation-"));
  try {
    await Promise.all(Array.from({ length: 12 }, async () => {
      for (let i = 0; i < 200; i++) {
        const release = await acquireCommandLock(root, "race");
        if (release) await release();
      }
    }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rapid cross-process acquisition has no inspection race errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-isolation-"));
  const modulePath = join(import.meta.dir, "isolation.ts");
  const script = `import { acquireCommandLock } from ${JSON.stringify(modulePath)};
    for (let i = 0; i < 250; i++) {
      const release = await acquireCommandLock(${JSON.stringify(root)}, "process-race");
      if (release) await release();
    }`;
  const children = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "-e", script], {
    stdout: "ignore", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" },
  }));
  try {
    const results = await Promise.all(children.map(async child => ({ status: await child.exited, error: await new Response(child.stderr).text() })));
    expect(results.filter(result => result.status !== 0)).toEqual([]);
  } finally {
    for (const child of children) child.kill();
    await Promise.all(children.map(child => child.exited));
    await rm(root, { recursive: true, force: true });
  }
});

test("validates and freezes isolation metadata", () => {
  const base = { name: "test", description: "Test", handle() {} };
  expect(() => defineCommand({ ...base, isolation: { key: "" } })).toThrow();
  expect(() => defineCommand({ ...base, isolation: { contentionExitCode: 256 } })).toThrow();
  const metadata = { key: "x" };
  const command = defineCommand({ ...base, isolation: metadata });
  metadata.key = "changed";
  expect(command.isolation?.key).toBe("x");
  expect(Object.isFrozen(command.isolation)).toBe(true);
});

test("exceptions release and unsafe lock parent is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-isolation-"));
  try {
    const command = defineCommand({ name: "test", description: "Test", isolation: {}, handle() { throw new Error("handler"); } });
    const context = resolveCommandContext({ root });
    await expect(executeCommand(command, input, context)).rejects.toThrow("handler");
    await expect(executeCommand(command, input, context)).rejects.toThrow("handler");
    await rm(join(root, ".bundle-command-locks"), { recursive: true });
    await symlink(tmpdir(), join(root, ".bundle-command-locks"));
    await expect(executeCommand(command, input, context)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects a symlink at the lock artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-isolation-"));
  try {
    const command = defineCommand({ name: "test", description: "Test", isolation: {}, handle() {} });
    const context = resolveCommandContext({ root });
    await executeCommand(command, input, context);
    const name = createHash("sha256").update("test").digest("hex") + ".lock";
    await symlink(tmpdir(), join(root, ".bundle-command-locks", name));
    await expect(executeCommand(command, input, context)).rejects.toThrow(/unsafe/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refuses to release a replaced owner artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-isolation-"));
  try {
    const command = defineCommand({ name: "test", description: "Test", isolation: {}, async handle() {
      const parent = join(root, ".bundle-command-locks");
      const [name] = await readdir(parent);
      const path = join(parent, name!);
      await rename(path, path + ".original");
      await writeFile(path, "different");
    } });
    await expect(executeCommand(command, input, resolveCommandContext({ root }))).rejects.toThrow(/owner|lock/i);
    expect((await readdir(join(root, ".bundle-command-locks"))).length).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("registered command contends with another process and defaults to zero", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-isolation-"));
  const modulePath = join(import.meta.dir, "command.ts");
  const child = Bun.spawn([process.execPath, "-e", `import { defineCommand, executeCommand, resolveCommandContext } from ${JSON.stringify(modulePath)};
    const cmd = defineCommand({ name: "cross", description: "Cross", isolation: {}, async handle() { console.log("ready"); await new Promise(resolve => setTimeout(resolve, 30000)); } });
    await executeCommand(cmd, { args: {}, options: {} }, resolveCommandContext({ root: ${JSON.stringify(root)} }));`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, BUN_OPTIONS: "" } });
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    let calls = 0;
    const messages: string[] = [];
    const program = new Command();
    registerCommands(program, [{ name: "cross", description: "Cross", isolation: {}, handle() { calls++; } }], { root, output: text => messages.push(text) });
    await program.parseAsync(["cross"], { from: "user" });
    expect(calls).toBe(0);
    expect(messages.join(" ")).toMatch(/isolat|lock/i);
    child.kill(); await child.exited;
    const definition = defineCommand({ name: "cross", description: "Cross", isolation: {}, handle() { calls++; } });
    expect(await executeCommand(definition, input, resolveCommandContext({ root, output: () => {} }))).toBe(0);
    expect(calls).toBe(0); // Abrupt termination deliberately leaves a stale lock.
  } finally { child.kill(); await child.exited; await rm(root, { recursive: true, force: true }); }
});
