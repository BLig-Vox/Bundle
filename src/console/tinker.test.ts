import { expect, test } from "bun:test";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTinker } from "./tinker.ts";

test("execute evaluates trusted JavaScript and returns a frozen receipt", async () => {
  let output = "";
  const stream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const receipt = await runTinker({ root: process.cwd(), execute: "1 + 2", output: stream });
  expect(output).toContain("3");
  expect(receipt.evaluations).toBe(1);
  expect(receipt.failures).toBe(0);
  expect(Object.isFrozen(receipt)).toBe(true);
});


test("execute awaits database access and closes the single owned database", async () => {
  let opened = 0, closed = 0, output = "";
  const stream = new Writable({ write(chunk, _encoding, cb) { output += chunk.toString(); cb(); } });
  const result = await runTinker({ root: process.cwd(), output: stream, execute: "await Promise.all([bundle.database(), bundle.database()]); 42", openDatabase: async () => { opened++; return { close: async () => { closed++; } }; } });
  expect(result.failures).toBe(0);
  expect(opened).toBe(1);
  expect(closed).toBe(1);
  expect(output).toContain("42");
});

test("rejects non-TTY input and execute with external input", async () => {
  const input = new PassThrough();
  await expect(runTinker({ root: process.cwd(), input })).rejects.toThrow();
  await expect(runTinker({ root: process.cwd(), input, execute: "1" })).rejects.toThrow();
});

test("rooted import and require resolve from the given root", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-tinker-"));
  try {
    await writeFile(join(root, "example.cjs"), "module.exports = 71;");
    let output = "";
    const stream = new Writable({ write(chunk, _encoding, cb) { output += chunk.toString(); cb(); } });
    const result = await runTinker({ root, output: stream, execute: "require(\"./example.cjs\") + (await bundle.import(\"./example.cjs\")).default" });
    expect(result.failures).toBe(0);
    expect(output).toContain("142");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("terminal evaluation errors are counted", async () => {
  const output = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
  const result = await runTinker({ root: process.cwd(), output, execute: "throw new Error(\"failure\")" });
  expect(result.failures).toBe(1);
});


test("abort waits for active awaited evaluation before closing its database", async () => {
  let finish!: () => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let closed = false;
  const controller = new AbortController();
  const output = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
  const run = runTinker({ root: process.cwd(), output, signal: controller.signal, execute: "await (await bundle.database()).wait()", openDatabase: async () => ({ wait: async () => { started(); await gate; }, close: () => { closed = true; } }) });
  await entered;
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(closed).toBe(false);
  finish();
  const result = await run;
  expect(result.aborted).toBe(true);
  expect(closed).toBe(true);
});

test("interactive context retains declarations across lines", async () => {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode: (mode: boolean) => void };
  input.isTTY = true; input.isRaw = false; input.setRawMode = mode => { input.isRaw = mode; };
  let text = "";
  const output = new Writable({ write(chunk, _encoding, cb) { text += chunk.toString(); cb(); } });
  const run = runTinker({ root: process.cwd(), input, output });
  setTimeout(() => input.end("const sample = 17\nsample * 2\n.exit\n"), 10);
  const result = await run;
  expect(result.failures).toBe(0);
  expect(text).toContain("34");
  expect(input.isRaw).toBe(false);
});

test("idle caller output closure rejects and releases input and owned database", async () => {
  const input = terminal(); const controller = new AbortController();
  let prompted!: () => void, opened!: () => void;
  const ready = new Promise<void>(resolve => { prompted = resolve; });
  const databaseReady = new Promise<void>(resolve => { opened = resolve; });
  let closed = 0, text = ""; let idle!: () => void;
  const idleReady = new Promise<void>(resolve => { idle = resolve; });
  const output = new Writable({ write(chunk, _encoding, cb) { text += chunk.toString(); prompted(); if ((text.match(/bundle> /g) ?? []).length >= 2) idle(); cb(); } });
  const run = runTinker({ root: process.cwd(), input, output, signal: controller.signal, openDatabase: async () => { opened(); return { close() { closed++; } }; } });
  const observed = run.then(() => "resolved", error => String(error.message));
  await ready; input.write("await bundle.database()\n"); await databaseReady; await idleReady;
  output.destroy();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([observed, new Promise<string>(resolve => { timer = setTimeout(() => resolve("hung"), 200); })]);
  clearTimeout(timer);
  controller.abort(); await observed;
  expect(result).toContain("output closed");
  expect(closed).toBe(1); expect(input.destroyed).toBe(false); expect(input.isRaw).toBe(false);
  expect(input.listenerCount("data")).toBe(0); expect(output.listenerCount("close")).toBe(0);
  input.destroy();
});

function terminal() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; isRaw: boolean; setRawMode: (mode: boolean) => void };
  input.isTTY = true; input.isRaw = false; input.setRawMode = mode => { input.isRaw = mode; };
  return input;
}

test("pasted interactive await, recoverable multiline and errors serialize before later cells", async () => {
  const input = terminal(); let text = "";
  const output = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
  const run = runTinker({ root: process.cwd(), input, output });
  setTimeout(() => input.end('const first = await new Promise(r => setTimeout(() => r(37), 20))\nconst second = first + 5\nfunction value() {\nreturn second\n}\nthrow new Error("cell failure")\nvalue()\n.exit\n'), 10);
  const result = await run;
  expect(result.failures).toBe(1);
  expect(text).toContain("cell failure");
  expect(text).toContain("42");
  expect(text).not.toContain("ReferenceError");
  expect(input.isRaw).toBe(false);
  expect(input.listenerCount("data")).toBe(0);
  expect(input.destroyed).toBe(true); // The fixture explicitly ended its own stream.
  expect(output.destroyed).toBe(false);
});

test("execute rejects incomplete programs and counts asynchronous terminal errors", async () => {
  for (const execute of ['function missing() {', 'await Promise.reject(new Error("await failure"))']) {
    const output = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
    const result = await runTinker({ root: process.cwd(), output, execute });
    expect(result.failures).toBe(1);
    expect(result.evaluations).toBe(1);
  }
});

test("caught database opening failure is not repeated as cleanup failure", async () => {
  const output = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
  const result = await runTinker({ root: process.cwd(), output, execute: 'try { await bundle.database() } catch {} ; 42', openDatabase: async () => { throw new Error("opening failed"); } });
  expect(result.failures).toBe(0);
});

test("drains delayed owned writes without ending caller output", async () => {
  let text = "";
  const output = new Writable({ write(chunk, _encoding, cb) { setTimeout(() => { text += chunk.toString(); cb(); }, 10); } });
  await runTinker({ root: process.cwd(), output, execute: "42" });
  expect(text).toContain("42");
  expect(output.writableEnded).toBe(false);
});

test("preabort and invalid option descriptors neither open databases nor retain input claims", async () => {
  const input = terminal(); const controller = new AbortController(); controller.abort();
  let opened = 0;
  const output = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
  const result = await runTinker({ root: process.cwd(), input, output, signal: controller.signal, openDatabase: async () => { opened++; return { close() {} }; } });
  expect(result.aborted).toBe(true); expect(opened).toBe(0); expect(input.destroyed).toBe(false);
  const invalid = Object.defineProperty({ root: process.cwd() }, "execute", { get() { throw new Error("getter executed"); } });
  await expect(runTinker(invalid)).rejects.toThrow("Invalid tinker options");
  const next = runTinker({ root: process.cwd(), input, output });
  setTimeout(() => input.write(".exit\n"), 10);
  expect((await next).failures).toBe(0);
  expect(input.destroyed).toBe(false);
  input.destroy();
});
