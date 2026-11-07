import { test, expect } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerOperations } from "./operations.ts";

test("config publish selects explicit package resources and never overwrites with force", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-config-selection-"));
  try {
    await mkdir(join(root, "vendor"));
    await writeFile(join(root, "vendor/demo.ts"), 'export default { name: "demo" };');
    await writeFile(join(root, "publish.ts"), `export default ${JSON.stringify({version:1,assets:[{package:'demo',tag:'config',source:'vendor/demo.ts',destination:'config/demo.ts'}]})};`);
    const output: string[] = [];
    const program = new Command().option("--force").exitOverride();
    registerOperations(program, {root,env:{},output: text => output.push(text)});
    await program.parseAsync(["--force", "config:publish", "--package", "demo"], {from:"user"});
    expect(JSON.parse(output[0]!)).toEqual({created:["config/demo.ts"]});
    await expect(program.parseAsync(["--force", "config:publish", "--package", "demo"], {from:"user"})).rejects.toThrow();
    expect(await readFile(join(root,"config/demo.ts"),"utf8")).toContain('demo');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("config publish pre-abort prevents legacy and selected publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-config-aborted-"));
  try {
    const controller = new AbortController(); controller.abort();
    for (const args of [["config:publish"], ["config:publish", "--all"]]) {
      const output: string[] = [];
      const program = new Command().option("--force").exitOverride();
      registerOperations(program, {root,env:{},output: text => output.push(text),signal:controller.signal});
      await expect(program.parseAsync(args, {from:"user"})).rejects.toThrow();
      expect(output).toEqual([]);
    }
    expect(await Bun.file(join(root,"config/app.ts")).exists()).toBe(false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("operations redact secrets and encrypt with an explicit environment key", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-operations-"));
  try {
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config", "app.ts"), 'export default { name: "demo", nested: { password: "secret-value" } };');
    await writeFile(join(root, ".env"), "HELLO=world\n");
    const output: string[] = [];
    const errors: string[] = [];
    const program = new Command().option("--force").exitOverride().configureOutput({ writeErr: text => errors.push(text) });
    registerOperations(program, { root, env: { BUNDLE_ENV_ENCRYPTION_KEY: `base64:${Buffer.alloc(32, 3).toString("base64")}` }, output: text => output.push(text) });
    await program.parseAsync(["config:show"], { from: "user" });
    expect(output.join(" ")).toContain("demo");
    expect(output.join(" ")).not.toContain("secret-value");
    await expect(program.parseAsync(["env:encrypt", "--cipher", "bad"], { from: "user" })).rejects.toThrow();
    expect(errors.join("")).toContain("unknown option '--cipher'");
    await program.parseAsync(["env:encrypt"], { from: "user" });
    expect(await readFile(join(root, ".env.encrypted"), "utf8")).not.toContain("HELLO=world");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("configuration exceptions do not disclose their message", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-operations-error-"));
  try {
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config", "app.ts"), 'throw new Error("private-value"); export default {};');
    const program = new Command().option("--force");
    registerOperations(program, { root, env: {}, output: () => {} });
    await expect(program.parseAsync(["config:show"], { from: "user" })).rejects.not.toThrow("private-value");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("config cache does not replace a file created while loading modules without force", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-operations-race-"));
  try {
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config", "app.ts"), `import { mkdir, writeFile } from "node:fs/promises";
await mkdir(${JSON.stringify(join(root, "bootstrap/cache"))}, { recursive: true });
await writeFile(${JSON.stringify(join(root, "bootstrap/cache/config.json"))}, "racing content");
export default { name: "generated" };`);
    const program = new Command().option("--force");
    registerOperations(program, { root, env: {}, output: () => {} });
    await expect(program.parseAsync(["config:cache"], { from: "user" })).rejects.toThrow();
    expect(await readFile(join(root, "bootstrap/cache/config.json"), "utf8")).toBe("racing content");
    expect(await readdir(join(root, "bootstrap/cache"))).toEqual(["config.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("config show redacts credential URLs and known environment secrets in nested strings", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-operations-display-"));
  try {
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config", "app.ts"), `export default { connections: ["postgres://user:secret@host/db", "ordinary string"], nested: { description: "prefix known-secret suffix", endpoint: "redis://u:pass@host" } };`);
    const output: string[] = [];
    const program = new Command().option("--force");
    registerOperations(program, { root, env: { API_TOKEN: "known-secret" }, output: text => output.push(text) });
    await program.parseAsync(["config:show"], { from: "user" });
    const displayed = output.join(" ");
    expect(displayed).not.toContain("secret@host");
    expect(displayed).not.toContain("pass@host");
    expect(displayed).not.toContain("known-secret");
    expect(displayed).toContain("ordinary string");
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("config cache with force replaces a file created while loading modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-operations-force-"));
  try {
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config", "app.ts"), `import { mkdir, writeFile } from "node:fs/promises";
await mkdir(${JSON.stringify(join(root, "bootstrap/cache"))}, { recursive: true });
await writeFile(${JSON.stringify(join(root, "bootstrap/cache/config.json"))}, "racing content");
export default { name: "generated" };`);
    const program = new Command().option("--force");
    registerOperations(program, { root, env: {}, output: () => {} });
    await program.parseAsync(["--force", "config:cache"], { from: "user" });
    expect(JSON.parse(await readFile(join(root, "bootstrap/cache/config.json"), "utf8"))).toEqual({ app: { name: "generated" } });
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("config cache publishes an absent cache without force", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-operations-new-cache-"));
  try {
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config", "app.ts"), 'export default { name: "new" };');
    const program = new Command().option("--force");
    registerOperations(program, { root, env: {}, output: () => {} });
    await program.parseAsync(["config:cache"], { from: "user" });
    expect(JSON.parse(await readFile(join(root, "bootstrap/cache/config.json"), "utf8"))).toEqual({ app: { name: "new" } });
    expect(await readdir(join(root, "bootstrap/cache"))).toEqual(["config.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
