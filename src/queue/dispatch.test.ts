import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchCommand } from "./dispatch.ts";
import { openLocalQueue } from "./opening.ts";
import { workQueue } from "./worker.ts";
import { encodeJob } from "./store.ts";
import { runQueuedJob } from "./execution.ts";
import { runCli } from "../cli/runner.ts";
import { Database } from "bun:sqlite";

test("command envelopes enforce plain bounded dense values", () => {
  const envelope = {kind:"command" as const, version:1 as const, argv:["list"]};
  expect(JSON.parse(encodeJob(envelope))).toEqual(envelope);
  expect(() => encodeJob({...envelope, argv:["list", ...Array(127).fill("x")]})).not.toThrow();
  expect(() => encodeJob({...envelope, argv:["list", "x".repeat(4096)]})).not.toThrow();
  for (const argv of [[], ["--help"], ["list", "x\0"], ["list", "x".repeat(4097)], ["list", ...Array(128).fill("x")], ["list", ...Array(64).fill("x".repeat(1024))], ["list", , "x"]]) {
    expect(() => encodeJob({...envelope, argv:argv as string[]})).toThrow();
  }
  const accessor = ["list"];
  Object.defineProperty(accessor, "0", {get() { throw new Error("getter ran"); }, enumerable:true});
  expect(() => encodeJob({...envelope, argv:accessor})).toThrow("Invalid JSON array");
  expect(() => encodeJob({...envelope, version:2} as never)).toThrow();
  expect(() => encodeJob({...envelope, extra:true} as never)).toThrow();
});

test("invalid command is rejected before queue creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-dispatch-"));
  try {
    for (const options of [
      {root, argv:["--help"]}, {root, argv:["list"], queue:"../bad"},
      {root, argv:["list"], maxAttempts:0}, {root, argv:["list"], maxAttempts:101},
      {root, argv:["list"], availableAt:-1}, {root, argv:["list"], availableAt:NaN},
      {root:"relative-root", argv:["list"]},
    ]) await expect(dispatchCommand(options)).rejects.toThrow();
    await expect(stat(join(root, ".bundle-queue"))).rejects.toThrow();
  } finally { await rm(root, {recursive:true, force:true}); }
});

test("dispatch snapshots argv before asynchronous root resolution", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-dispatch-"));
  try {
    const argv = ["list", "original"];
    const pending = dispatchCommand({root, argv});
    argv[1] = "changed";
    await pending;
    const store = await openLocalQueue(root);
    try { expect(store.reserve(["default"])?.job).toEqual({kind:"command",version:1,argv:["list","original"]}); }
    finally { store.close(); }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("v2 storage preserves malformed envelope without execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-dispatch-"));
  try {
    await dispatchCommand({root, argv:["list"]});
    const path = join(root,".bundle-queue","queue.sqlite");
    const db = new Database(path);
    try {
      expect((db.query("PRAGMA user_version").get() as {user_version:number}).user_version).toBe(2);
      db.query("UPDATE jobs SET job=?").run(JSON.stringify({kind:"command",version:2,argv:["list"]}));
    } finally { db.close(); }
    const store = await openLocalQueue(root);
    try {
      const result: unknown[] = [];
      await workQueue({root,store,once:true,onResult:r=>{result.push(r);}});
      expect(result).toEqual([{id:1,queue:"default",attempt:1,outcome:"failed",settlement:"released"}]);
    } finally { store.close(); }
    expect(await runQueuedJob({root,job:{module:"missing.ts",export:"handle",payload:null}})).toEqual({status:"failed"});
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("corrupt JSON is quarantined without starving later jobs or changing raw text", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-dispatch-"));
  try {
    const first = await dispatchCommand({root,argv:["list"],maxAttempts:1});
    const second = await dispatchCommand({root,argv:["list"],maxAttempts:1});
    const path = join(root,".bundle-queue","queue.sqlite");
    const db = new Database(path);
    try { db.query("UPDATE jobs SET job=? WHERE id=?").run("{",first); }
    finally { db.close(); }
    const store = await openLocalQueue(root);
    try {
      const claim = store.reserve(["default"], {leaseMs:10_000});
      expect(claim?.job).toBeNull();
      expect(store.heartbeat(claim!.receipt, {leaseMs:10_000})).toBe(true);
      expect(store.ack("0".repeat(64))).toBe(false);
      expect(store.settle(claim!.receipt, {outcome:"cancelled"})).toBe("released");
      const results: unknown[] = [];
      await workQueue({root,store,once:true,onResult:r=>{results.push(r);}});
      await workQueue({root,store,once:true,onResult:r=>{results.push(r);}});
      expect(results).toEqual([
        {id:first,queue:"default",attempt:1,outcome:"failed",settlement:"failed"},
        {id:second,queue:"default",attempt:1,outcome:"completed",settlement:"acknowledged",commandExitCode:0},
      ]);
      expect(store.listFailed()[0]?.job).toBeNull();
      expect(store.failedPage().failed[0]?.job).toBeNull();
      const inspection = new Database(path,{readonly:true});
      try { expect(inspection.query("SELECT job FROM jobs WHERE id=?").get(first)).toEqual({job:"{"}); }
      finally { inspection.close(); }
    } finally { store.close(); }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("runner signal opt-out does not add process listeners", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-dispatch-"));
  try {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    await runCli(["list"],{root,handleSignals:false,output:()=>{},error:()=>{},onLifecycle:() => {
      expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    }});
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("queued custom command is discovered at explicit root and reports its exact code", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-dispatch-"));
  try {
    await mkdir(join(root,"src", "commands"), {recursive:true});
    await writeFile(join(root,"src", "commands", "custom.ts"), 'export default {name:"custom:run",description:"test",handle(){return 23}}');
    const id = await dispatchCommand({root, argv:["custom:run"], maxAttempts:1});
    const store = await openLocalQueue(root);
    try {
      const results: unknown[] = [];
      await workQueue({root,store,once:true,onResult:r=>{results.push(r);}});
      expect(results).toEqual([{id,queue:"default",attempt:1,outcome:"failed",settlement:"failed",commandExitCode:23}]);
    } finally { store.close(); }
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("queued built-in runs in worker and records exact nonzero status", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-dispatch-"));
  try {
    const id = await dispatchCommand({root, argv: ["not-a-command"], maxAttempts: 1});
    const store = await openLocalQueue(root);
    try {
      const results: unknown[] = [];
      await workQueue({root, store, once:true, onResult: result => { results.push(result); }});
      expect(results).toEqual([{id, queue:"default", attempt:1, outcome:"failed", settlement:"failed", commandExitCode:1}]);
    } finally { store.close(); }
  } finally { await rm(root, {recursive:true, force:true}); }
});
