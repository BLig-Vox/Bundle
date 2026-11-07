import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeJob, type QueueJob } from "./store.ts";
import { runQueuedJob } from "./execution.ts";
import { dispatchCommand } from "./dispatch.ts";
import { openLocalQueue } from "./opening.ts";

const reference = {module:"middleware.ts", export:"handle"};
test("persisted module and command envelopes accept only bounded middleware references", () => {
  const bases: QueueJob[] = [{module:"job.ts",export:"handle",payload:null}, {kind:"command",version:1,argv:["list"]}];
  for (const base of bases) {
    const job = {...base,middleware:[reference]};
    expect(JSON.parse(encodeJob(job))).toEqual(job);
    for (const middleware of [[{...reference,extra:true}], Array(17).fill(reference), [{module:"../escape.ts",export:"handle"}], [{...reference,method:"constructor"}]]) {
      expect(()=>encodeJob({...base,middleware} as QueueJob)).toThrow();
    }
  }
});

test("command producers validate and snapshot middleware before asynchronous storage opening", async () => {
  const root=await mkdtemp(join(tmpdir(),"bundle-middleware-producer-"));
  try {
    await expect(dispatchCommand({root,argv:["list"],middleware:[{...reference,module:"../escape.ts"}]})).rejects.toThrow();
    expect(await Bun.file(join(root,".bundle-queue","queue.sqlite")).exists()).toBe(false);
    const references=[{...reference}];
    const pending=dispatchCommand({root,argv:["list"],middleware:references});
    references[0]!.module="changed.ts";
    await pending;
    const store=await openLocalQueue(root);
    try {
      const reserved=store.reserve(["default"]);
      expect(reserved?.job?.middleware).toEqual([reference]);
      if(reserved) expect(store.ack(reserved.receipt)).toBe(true);
    } finally {store.close();}
  } finally {await rm(root,{recursive:true,force:true});}
});

test("owned command execution runs middleware while retaining exact command failure status", async () => {
  const root=await mkdtemp(join(tmpdir(),"bundle-middleware-command-"));
  try {
    const marker=join(root,"middleware-finished");
    await writeFile(join(root,"middleware.ts"),`import {writeFileSync} from "node:fs";export async function handle(_c:any,next:any){await next.recover(()=>{});writeFileSync(${JSON.stringify(marker)},"finished");}`);
    const result=await runQueuedJob({root,job:{kind:"command",version:1,argv:["missing:command"],middleware:[reference]}});
    expect(result).toEqual({status:"failed",commandExitCode:1});
    expect(await readFile(marker,"utf8")).toBe("finished");
  } finally {await rm(root,{recursive:true,force:true});}
});
