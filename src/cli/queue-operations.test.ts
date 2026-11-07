import { expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerQueueOperations } from "./queue-operations.ts";
import { openLocalQueue } from "../queue/opening.ts";
import { pathToFileURL } from "node:url";

test("refuses destructive and invalid selections before creating storage", async () => {
  const root=mkdtempSync(join(tmpdir(),"bundle-ops-cli-"));
  try {
    for (const args of [["queue:clear","q"],["--force","queue:clear","../x"],["--force","queue:flush"],["--force","queue:flush","--all","--queue","q"],["--force","queue:prune-failed","--all","--before","-1"],["queue:monitor","--queue","../x"],["queue:monitor","--queue","q","--max","-1"]]) {
      const program=new Command().exitOverride().configureOutput({writeErr(){}}).option("--force");
      registerQueueOperations(program,{root,output(){}});
      await expect(program.parseAsync(args,{from:"user"})).rejects.toThrow();
      expect(existsSync(join(root,".bundle-queue"))).toBe(false);
    }
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("separate processes inspect and control shared local queue without exposing data", async () => {
  const root=mkdtempSync(join(tmpdir(),"bundle-ops-process-"));
  try {
    const store=await openLocalQueue(root);
    store.enqueue("q",{module:"jobs/A.ts",export:"A",payload:"SECRET_PAYLOAD"});
    store.enqueue("q",{module:"jobs/A.ts",export:"A",payload:null});
    store.fail(store.reserve(["q"])!.receipt,"SECRET_REASON");
    store.close();
    const module=pathToFileURL(join(import.meta.dir,"queue-operations.ts")).href;
    const script=`import {Command} from 'commander'; import {registerQueueOperations} from ${JSON.stringify(module)}; const p=new Command().exitOverride().option('--force'); registerQueueOperations(p,{root:process.env.ROOT,output:console.log}); try { await p.parseAsync(JSON.parse(process.env.ARGS),{from:'user'}); } catch(e) { process.exitCode=e.exitCode || 1; }`;
    async function run(args:string[]) {
      const child=Bun.spawn([process.execPath,"-e",script],{cwd:join(import.meta.dir,"../.."),env:{...process.env,BUN_OPTIONS:"",ROOT:root,ARGS:JSON.stringify(args)},stdout:"pipe",stderr:"pipe"});
      return {code:await child.exited,stdout:await new Response(child.stdout).text()};
    }
    const monitor=await run(["queue:monitor","--queue","q","--max","0"]);
    expect(monitor.code).toBe(1); expect(JSON.parse(monitor.stdout)).toMatchObject({ready:1,failed:1,exceeded:true});
    expect(monitor.stdout).not.toContain("SECRET");
    expect((await run(["queue:clear","q"])).code).toBe(1);
    expect(JSON.parse((await run(["--force","queue:clear","q"])).stdout).removed).toBe(1);
    expect(JSON.parse((await run(["--force","queue:flush","--queue","q"])).stdout).removed).toBe(1);
    expect(JSON.parse((await run(["queue:monitor","--queue","q"])).stdout)).toMatchObject({ready:0,failed:0});
  } finally { rmSync(root,{recursive:true,force:true}); }
});
