import { afterEach, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerQueue } from "./queue.ts";

const roots:string[]=[];
afterEach(async()=>{while(roots.length)await rm(roots.pop()!,{recursive:true,force:true});});

test.each([
  ["--tries","0"],
  ["--tries","101"],
  ["--tries","1.5"],
  ["--timeout","0"],
  ["--timeout","86400000"],
  ["--max-jobs","0"],
  ["--sleep","0"],
  ["--backoff","-1"],
  ["--queue","../escape"],
])("invalid queue work option %s %s cannot initialize queue storage",async(option,value)=>{
  const root=await mkdtemp(join(tmpdir(),"bundle-queue-options-"));roots.push(root);
  const program=new Command().exitOverride().configureOutput({writeErr(){}});
  registerQueue(program,{root,output(){}});
  await expect(program.parseAsync(["queue:work","--once",option,value],{from:"user"})).rejects.toThrow();
  expect(await Bun.file(join(root,".bundle-queue","queue.sqlite")).exists()).toBe(false);
});
