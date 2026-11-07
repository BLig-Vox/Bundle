import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateProviderScaffold, publishScaffoldStubs } from "./scaffolding.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root,{recursive:true,force:true}); });
async function fixture() { const root=await mkdtemp(join(tmpdir(),"bundle-provider-generator-")); roots.push(root); return root; }

test("provider generation preserves namespace keys and refuses overwrite or unsafe destinations",async()=>{
 const root=await fixture();
 const first=await generateProviderScaffold(root,"Billing/ProviderContext");
 const second=await generateProviderScaffold(root,"Sales/ProviderContext");
 expect(await readFile(first,"utf8")).toContain('"provider:Billing.ProviderContext"');
 expect(await readFile(second,"utf8")).toContain('"provider:Sales.ProviderContext"');
 expect(await readFile(first,"utf8")).toContain('"../../console/providers.ts"');
 const original=await readFile(first,"utf8");
 await expect(generateProviderScaffold(root,"Billing/ProviderContext")).rejects.toThrow();
 expect(await readFile(first,"utf8")).toBe(original);
 for(const name of ["../Outside","Billing//Empty","Date","constructor","Invalid-Name"]){
  await expect(generateProviderScaffold(root,name)).rejects.toThrow();
 }
 const outside=await fixture();
 await symlink(outside,join(root,"src/providers/Linked"));
 await expect(generateProviderScaffold(root,"Linked/Escape")).rejects.toThrow();
 expect(await Bun.file(join(outside,"Escape.ts")).exists()).toBe(false);
});

test("provider generator consumes only valid explicit custom stub tokens",async()=>{
 const root=await fixture();
 expect(await publishScaffoldStubs(root)).toHaveLength(27);
 const stub=join(root,"stubs/provider.ts.stub");
 for(const source of [
  'export class {{name}} {}',
  'import "{{runtimeImport}}";export class {{name}} {key="{{serviceKey}}";unknown={{other}};}',
 ]){
  await writeFile(stub,source);
  await expect(generateProviderScaffold(root,"Invalid")).rejects.toThrow("Invalid tokens");
 }
 await rm(stub);
 const outside=await fixture();await writeFile(join(outside,"stub"),'export class Example {}');
 await symlink(join(outside,"stub"),stub);
 await expect(generateProviderScaffold(root,"Linked")).rejects.toThrow();
 expect(await Bun.file(join(root,"src/providers/Linked.ts")).exists()).toBe(false);
});

test("provider descriptor bounds reject before creating a destination tree",async()=>{
 const root=await fixture();
 const name=["A".repeat(100),"B".repeat(100),"C".repeat(100)].join("/");
 await expect(generateProviderScaffold(root,name)).rejects.toThrow("Invalid provider reference");
 await expect(lstat(join(root,"src"))).rejects.toMatchObject({code:"ENOENT"});
 await mkdir(join(root,"src/providers"),{recursive:true});
 await symlink(join(root,"missing"),join(root,"src/providers/Dangling.ts"));
 await expect(generateProviderScaffold(root,"Dangling")).rejects.toThrow();
 expect((await lstat(join(root,"src/providers/Dangling.ts"))).isSymbolicLink()).toBe(true);
});
