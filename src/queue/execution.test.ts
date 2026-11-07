import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, {recursive:true,force:true}); });
const execution = new URL("./execution.ts", import.meta.url).href;
async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(),"bundle-job-execution-")); roots.push(root);
  await writeFile(join(root,"job.ts"),source);
  return root;
}
async function run(root: string, options: object = {}, before = "", after = "") {
  const script = `import {runQueuedJob} from ${JSON.stringify(execution)};
const controller=new AbortController(); ${before}
const running=runQueuedJob({root:${JSON.stringify(root)},job:{module:"job.ts",export:"handle",payload:{id:7}},signal:controller.signal,...${JSON.stringify(options)}});
${after}
console.log(JSON.stringify(await running));`;
  const child = Bun.spawn([process.execPath,"-e",script],{env:{...process.env,BUN_OPTIONS:""},stdout:"pipe",stderr:"pipe"});
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([child.exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Owned job execution did not finish.")),4000);})]);
    const error = await stderr;
    expect(error).toBe("");
    expect(code).toBe(0);
    return JSON.parse((await stdout).trim()) as {status:string};
  } finally {
    clearTimeout(timer);
    if(child.exitCode===null){child.kill("SIGKILL");await child.exited;}
  }
}

test("owned queued function executes with the actual payload and closes without killing its caller",async()=>{
  const root=await fixture('import {writeFileSync} from "node:fs"; export function handle(payload,signal) {if(signal.aborted)throw new Error("unexpected abort");writeFileSync(new URL("./delivered",import.meta.url),JSON.stringify(payload));}');
  expect(await run(root)).toEqual({status:"completed"});
  expect(JSON.parse(await readFile(join(root,"delivered"),"utf8"))).toEqual({id:7});
});

test("owned queued class method executes with a fresh instance",async()=>{
  const root=await fixture('import {writeFileSync} from "node:fs"; export class Handler {count=0;handle(payload) {writeFileSync(new URL("./delivered",import.meta.url),String(++this.count)+":"+payload.id);}}');
  expect(await run(root,{job:{module:"job.ts",export:"Handler",method:"handle",payload:{id:9}}})).toEqual({status:"completed"});
  expect(await readFile(join(root,"delivered"),"utf8")).toBe("1:9");
});

test.each([
  'throw new Error("job-secret-error");',
  'export function handle(){throw new Error("job-secret-error");}',
  'export const handle=1;',
  'export class handle {}',
  'process.exit(7);',
])("owned queued failures are observed and sanitized: %s",async source=>{
  const root=await fixture(source);
  expect(await run(root)).toEqual({status:"failed"});
});

test("owned queued module refuses symlinks and unsafe paths",async()=>{
  const root=await fixture('export function handle(){}');
  await symlink(join(root,"job.ts"),join(root,"linked.ts"));
  for(const module of ["linked.ts","../job.ts"]){
    expect(await run(root,{job:{module,export:"handle",payload:null}})).toEqual({status:"failed"});
  }
});

test.each([
  'await new Promise(()=>{}); export function handle(){}',
  'export function handle(){while(true){}}',
])("timeout interrupts only the owned queued worker: %s",async source=>{
  const root=await fixture(source);
  expect(await run(root,{timeoutMs:100})).toEqual({status:"timed-out"});
});

test("pre-cancelled jobs never import application code",async()=>{
  const root=await fixture('import {writeFileSync} from "node:fs"; writeFileSync(new URL("./imported",import.meta.url),"no");export function handle(){}');
  expect(await run(root,{},"controller.abort();")).toEqual({status:"cancelled"});
  expect(await Bun.file(join(root,"imported")).exists()).toBe(false);
});

test("active cancellation reaches the job signal before owned worker cleanup",async()=>{
  const root=await fixture('import {writeFileSync} from "node:fs"; export async function handle(_payload,signal){writeFileSync(new URL("./started",import.meta.url),"yes");await new Promise(resolve=>signal.addEventListener("abort",()=>{writeFileSync(new URL("./cancelled",import.meta.url),"yes");resolve();},{once:true}));}');
  const after=`const deadline=Date.now()+2000;while(!await Bun.file(${JSON.stringify(join(root,"started"))}).exists()&&Date.now()<deadline)await Bun.sleep(10);controller.abort();`;
  expect(await run(root,{},"",after)).toEqual({status:"cancelled"});
  expect(await readFile(join(root,"cancelled"),"utf8")).toBe("yes");
});
