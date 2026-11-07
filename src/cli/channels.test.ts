import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { defineChannels } from "../broadcasting/definitions.ts";
import { createCli } from "./program.ts";
import { loadApplicationChannels } from "./channels.ts";

test("defineChannels copies, freezes, bounds and uniquely validates registered patterns", () => {
  const source = [{ name: "orders.{orderId}" }];
  const definitions = defineChannels(source);
  source[0]!.name = "changed";
  expect(definitions).toEqual([{ name: "orders.{orderId}" }]);
  expect(Object.isFrozen(definitions)).toBe(true);
  expect(Object.isFrozen(definitions[0])).toBe(true);
  expect(() => defineChannels([{ name: "orders" }, { name: "orders" }])).toThrow(/duplicate/i);
  expect(() => defineChannels([{ name: "orders..items" }])).toThrow(/channel/i);
  expect(() => defineChannels([{ name: "orders.{id}.{id}" }])).toThrow(/channel/i);
  expect(() => defineChannels(Array.from({ length: 129 }, (_, index) => ({ name: `channel${index}` })))).toThrow(/exceeds|limit/i);
  let accessed = false;
  const getter = Object.defineProperty({}, "name", { enumerable: true, get() { accessed = true; return "unsafe"; } });
  expect(() => defineChannels([getter as { name: string }])).toThrow(/channel/i);
  expect(accessed).toBe(false);
  const sparse = new Array(1) as { name: string }[];
  expect(() => defineChannels(sparse)).toThrow(/dense/i);
  accessed = false;
  const arrayAccessor = [] as { name: string }[];
  Object.defineProperty(arrayAccessor, "0", { enumerable: true, get() { accessed = true; return { name: "unsafe" }; } });
  arrayAccessor.length = 1;
  expect(() => defineChannels(arrayAccessor)).toThrow(/dense/i);
  expect(accessed).toBe(false);
});

test("channel:list consumes root channel metadata without opening a database", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-channel-list-"));
  try {
    const definitions = pathToFileURL(join(import.meta.dir, "../broadcasting/definitions.ts")).href;
    await writeFile(join(root, "channels.ts"), `import { defineChannels } from ${JSON.stringify(definitions)}; export default defineChannels([{name:"orders.{orderId}"},{name:"private.users.{userId}"}]);`);
    const output: string[] = [];
    const cli = createCli({ root, env: { DB_CONNECTION: "invalid", DB_DATABASE: join(root, "must-not-open.sqlite") }, output: text => output.push(text) });
    await cli.parseAsync(["channel:list", "--json"], { from: "user" });
    expect(JSON.parse(output[0]!)).toEqual({ channels: [{ name: "orders.{orderId}" }, { name: "private.users.{userId}" }] });
    expect(await Bun.file(join(root, "must-not-open.sqlite")).exists()).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("channel loading refuses a nonexistent project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-channel-missing-root-"));
  await rm(root, { recursive: true, force: true });
  await expect(loadApplicationChannels(root)).rejects.toMatchObject({ code: "ENOENT" });
});

test("channel:list reports an empty registry and refuses malformed source", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-channel-empty-"));
  try {
    const output: string[] = [];
    const cli = createCli({ root, env: { DB_CONNECTION: "invalid" }, output: text => output.push(text) });
    await cli.parseAsync(["channel:list"], { from: "user" });
    expect(output.pop()).toBe("No channels.");
    await writeFile(join(root, "channels.ts"), "export default [{name:'unvalidated'}];");
    await expect(cli.parseAsync(["channel:list", "--json"], { from: "user" })).rejects.toThrow(/defineChannels/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
