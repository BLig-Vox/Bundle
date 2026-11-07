import { afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { projectRoot } from "../database/config.ts";
import { Logger } from "../logging/logger.ts";
import { LocalCache } from "../cache/cache.ts";
import { startApplicationServer } from "../http/application.ts";
import { QueueStore } from "../queue/store.ts";
import { Database as NativeSqlite } from "bun:sqlite";
import { pauseQueue, resumeQueue } from "../queue/control.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture() {
  await mkdir(join(projectRoot, ".data"), { recursive: true });
  const root = await mkdtemp(join(projectRoot, ".data", "cli-compatibility-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  for (const path of ["src", "index.ts", "package.json"]) {
    await cp(join(projectRoot, path), join(root, path), { recursive: true });
  }
  const env = {
    ...process.env, APP_ENV: "test", NODE_ENV: "test", DB_CONNECTION: "invalid",
    DATABASE_URL: "", DB_DATABASE: join(root, "must-not-exist.sqlite"),
  };
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "run", "index.ts", ...args], {
      cwd: root, env, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    return { stdout, stderr, code };
  };
  return { root, env, run };
}

// These tests catch missing shared registration/entry-point wiring that standalone hosts miss.
describe("Artisan foundation entry-point compatibility", () => {
  test("local cache commands operate on persisted namespaces across actual processes", async () => {
    const { root, env, run } = await fixture();
    await mkdir(join(root, ".bundle-cache"));
    const path = join(root, ".bundle-cache", "cache.sqlite");
    const first = new LocalCache(path, "default");
    const other = new LocalCache(path, "other");
    try {
      first.put("selected", { value: 1 }, { tags: ["batch"] });
      first.put("keep", "untagged");
      other.put("selected", "different namespace");
    } finally { first.close(); other.close(); }
    expect((await run("cache:clear", "--tag", "batch")).code).toBe(0);
    const reopened = new LocalCache(path, "default");
    const reopenedOther = new LocalCache(path, "other");
    try {
      expect(reopened.get("selected")).toBeUndefined();
      expect(reopened.get("keep")).toBe("untagged");
      expect(reopenedOther.get("selected")).toBe("different namespace");
    } finally { reopened.close(); reopenedOther.close(); }
    expect((await run("cache:forget", "keep")).stdout).toContain("removed");
    expect((await run("cache:prune-stale-tags")).code).toBe(0);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test("owned storage links survive process boundaries and dangling-target cleanup", async () => {
    const { root, run } = await fixture();
    await mkdir(join(root, "config"));
    await mkdir(join(root, "public"));
    await mkdir(join(root, "storage", "assets"), { recursive: true });
    await writeFile(join(root, "config", "storage.ts"), 'export default { links: { "public/assets": "storage/assets" } };\n');
    expect((await run("storage:link")).code).toBe(0);
    const link = join(root, "public", "assets");
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readlink(link)).toContain("assets");
    await rm(join(root, "storage", "assets"), { recursive: true });
    expect((await run("storage:unlink")).code).toBe(0);
    await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("published stubs, config modules, custom names and unit tests are consumed by actual processes", async () => {
    const { root, run } = await fixture();
    expect((await run("stub:publish")).code).toBe(0);
    const stub = join(root, "stubs", "config.ts.stub");
    const original = await readFile(stub, "utf8");
    await writeFile(stub, original + '\n// Customized template consumed\n');
    expect((await run("make:config", "Billing")).code).toBe(0);
    expect(await readFile(join(root, "config", "Billing.ts"), "utf8")).toContain("Customized template consumed");
    expect((await run("config:show", "Billing")).code).toBe(0);
    expect((await run("make:command", "DailyReport", "--command", "report:daily")).code).toBe(0);
    expect((await run("report:daily")).code).toBe(0);
    expect((await run("make:test", "Billing", "--unit")).code).toBe(0);
    const unitFiles = await readdir(join(root, "tests", "Unit"));
    expect(unitFiles).toContain("Billing.test.ts");
    expect((await run("test", "./tests/Unit/Billing.test.ts")).code).toBe(0);
  });

  test("actual nested command calls use fresh argument parsing and preserve child status", async () => {
    const { root, run } = await fixture();
    await mkdir(join(root, "src", "commands"));
    await writeFile(join(root, "src", "commands", "Nested.ts"), `
export const child = { name: "fixture:child", description: "Child", arguments: [{ name: "value" }],
  handle(input: any, context: any) { context.output("CHILD:" + input.args.value); return 9; } };
export const parent = { name: "fixture:parent", description: "Parent",
  async handle(_input: any, context: any) { return await context.call(["fixture:child", "nested-value"]); } };
`);
    const result = await run("fixture:parent");
    expect(result.code).toBe(9);
    expect(result.stdout.trim()).toBe("CHILD:nested-value");
  });

  test("actual route caching is consumed by inspection and serving before source code is evaluated", async () => {
    const { root, run } = await fixture();
    await mkdir(join(root,"src","http","handlers"));
    await writeFile(join(root,"src","http","handlers","Cached.ts"), 'export function hello() { return Response.json({cached:true}); }\n');
    await writeFile(join(root,"routes.ts"), `
import { defineRoutes } from "./src/http/route-definitions.ts";
export default defineRoutes([{method:"GET",path:"/cached",name:"cached",handler:{module:"src/http/handlers/Cached.ts",export:"hello"}}]);\n`);
    const built = await run("route:cache");
    expect(built.code).toBe(0);
    expect(await Bun.file(join(root,"bootstrap","cache","routes.json")).exists()).toBe(true);
    await writeFile(join(root,"routes.ts"), 'throw new Error("uncached source was evaluated");\n');
    const listed = await run("route:list","--json");
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout).routes[0]).toMatchObject({path:"/cached",name:"cached"});
    const server = await startApplicationServer({root,port:0});
    try { expect(await(await fetch(new URL("cached",server.url))).json()).toEqual({cached:true}); }
    finally { await server.stop(); }
    expect((await run("route:cache")).code).toBe(1);
    expect((await run("route:clear")).code).toBe(0);
    const uncached = await run("route:list","--json");
    expect(uncached.code).toBe(1);
    expect(uncached.stderr).toContain("uncached source was evaluated");
  });

  for (const named of [false, true]) test(`actual native model pruning previews and force-deletes only bounded eligible records across chunks (${named ? 'named' : 'default'} target)`,async()=>{
    const fixtureState=await fixture(); const {root,env}=fixtureState;
    const database=join(root,'pruning.sqlite');
    env.DB_CONNECTION='sqlite';env.DB_DATABASE=database;
    if(named) { Object.assign(env,{BUNDLE_CONNECTIONS:JSON.stringify({pruning:{DB_CONNECTION:'sqlite',DB_DATABASE:database}})});env.DB_CONNECTION='invalid';env.DB_DATABASE=join(root,'must-not-open.sqlite'); }
    const run=(...args:string[])=>fixtureState.run(...(named?['--database','pruning']:[]),...args);
    await writeFile(join(root,'native-pruning-fixture.ts'),`import {MikroORM} from '@mikro-orm/core';import {SqliteDriver} from '@mikro-orm/sqlite';import UserSchema,{User} from './src/models/User.ts';import PostSchema from './src/models/Post.ts';const orm=await MikroORM.init({driver:SqliteDriver,dbName:process.env.DB_DATABASE!,entities:[UserSchema,PostSchema],logger:()=>{}});try{if(process.argv[2]==='seed'){await orm.schema.create();const em=orm.em.fork();for(let i=1;i<=6;i++)em.create(User,{name:'Record '+i,email:'prune-'+i+'@example.invalid'});await em.flush();}else{console.log(JSON.stringify((await orm.em.fork().find(User,{}, {orderBy:{id:'asc'}})).map(u=>u.id)));}}finally{await orm.close(true);}`);
    const inspect=async(mode:string)=>{const child=Bun.spawn([process.execPath,'run','native-pruning-fixture.ts',mode],{cwd:root,env:{...env,DB_DATABASE:database},stdout:'pipe',stderr:'pipe'});const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(code,stderr).toBe(0);return stdout;};
    await inspect('seed');
    await writeFile(join(root,'pruning.ts'),`import {definePrunable,definePruning} from './src/database/pruning-definitions.ts';import {User} from './src/models/User.ts';export default definePruning([definePrunable({name:'User',model:User,where(signal:AbortSignal){signal.throwIfAborted();return {id:{$lte:5}};}})]);`);
    const preview=await run('model:prune','--pretend','--chunk','2','--limit','3');
    expect(preview.code,preview.stderr).toBe(0);
    expect(JSON.parse(preview.stdout)).toEqual({pretend:true,models:[{name:'User',matched:5,selected:3,deleted:0}]});
    expect(JSON.parse(await inspect('read'))).toEqual([1,2,3,4,5,6]);
    expect((await run('model:prune')).code).toBe(1);
    expect(JSON.parse(await inspect('read'))).toEqual([1,2,3,4,5,6]);
    const pruned=await run('--force','model:prune','--model','User','--chunk','2','--limit','3');
    expect(pruned.code,pruned.stderr).toBe(0);
    expect(JSON.parse(pruned.stdout)).toEqual({pretend:false,models:[{name:'User',matched:5,selected:3,deleted:3}]});
    expect(pruned.stdout).not.toContain('example.invalid');
    expect(JSON.parse(await inspect('read'))).toEqual([4,5,6]);
    expect(JSON.parse((await run('model:prune','--pretend')).stdout)).toEqual({pretend:true,models:[{name:'User',matched:2,selected:2,deleted:0}]});
    const rest=await run('--force','model:prune','--chunk','1');expect(rest.code,rest.stderr).toBe(0);
    expect(JSON.parse(rest.stdout)).toEqual({pretend:false,models:[{name:'User',matched:2,selected:2,deleted:2}]});
    expect(JSON.parse(await inspect('read'))).toEqual([6]);
    expect(await Bun.file(join(root,'must-not-open.sqlite')).exists()).toBe(false);
    expect(await Bun.file(join(root,'.data/bundle.sqlite')).exists()).toBe(false);
  },15000);

  test('actual selected config publication copies only package configuration and is consumed without importing assets early',async()=>{
    const {root,env,run}=await fixture();await mkdir(join(root,'vendor'));
    const marker=join(root,'configuration-consumed');const source=`await Bun.write(${JSON.stringify(marker)},'consumed');export default {enabled:true,label:'Package Unicode café'};`;
    await writeFile(join(root,'vendor','config.ts'),source);
    await writeFile(join(root,'publish.ts'),`export default {version:1,assets:[{package:'acme',tag:'defaults',source:'vendor/config.ts',destination:'config/acme.ts'},{package:'acme',tag:'defaults',source:'vendor/absent-language.ts',destination:'lang/en.ts'},{package:'acme',tag:'defaults',source:'vendor/absent-data.json',destination:'resources/data.json'}]};`);
    const published=await run('config:publish','--package','acme','--tag','defaults');expect(published.code,published.stderr).toBe(0);expect(JSON.parse(published.stdout)).toEqual({created:['config/acme.ts']});
    expect(await Bun.file(marker).exists()).toBe(false);expect(await Bun.file(join(root,'config/acme.ts')).text()).toBe(source);
    const shown=await run('config:show','acme');expect(shown.code,shown.stderr).toBe(0);expect(JSON.parse(shown.stdout)).toEqual({enabled:true,label:'Package Unicode café'});expect(await Bun.file(marker).text()).toBe('consumed');
    expect(await Bun.file(join(root,'lang/en.ts')).exists()).toBe(false);expect(await Bun.file(join(root,'resources/data.json')).exists()).toBe(false);
    await writeFile(join(root,'vendor','config.ts'),'export default {changed:true};');expect((await run('--force','config:publish','--all')).code).toBe(1);expect(await Bun.file(join(root,'config/acme.ts')).text()).toBe(source);
    const legacy=await run('config:publish');expect(legacy.code,legacy.stderr).toBe(0);expect(await Bun.file(join(root,'config/app.ts')).exists()).toBe(true);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test('actual all-config publication preserves cache precedence until explicit clear',async()=>{
    const {root,env,run}=await fixture();await mkdir(join(root,'config'));await mkdir(join(root,'vendor'));
    await writeFile(join(root,'config','base.ts'),`export default {cached:true};`);expect((await run('config:cache')).code).toBe(0);
    await writeFile(join(root,'vendor','new.ts'),`export default {value:'published'};`);await writeFile(join(root,'publish.ts'),`export default {version:1,assets:[{package:'acme',tag:'defaults',source:'vendor/new.ts',destination:'config/newsetting.ts'}]};`);
    const published=await run('config:publish','--all');expect(published.code,published.stderr).toBe(0);expect(JSON.parse(published.stdout)).toEqual({created:['config/newsetting.ts']});
    expect((await run('config:show','newsetting')).code).toBe(1);expect((await run('config:clear')).code).toBe(0);
    const shown=await run('config:show','newsetting');expect(shown.code,shown.stderr).toBe(0);expect(JSON.parse(shown.stdout)).toEqual({value:'published'});
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  for(const named of [false,true]) test(`actual migration history uninstall preserves application rows and supports fresh reinstall (${named?'named':'default'})`,async()=>{
    const state=await fixture();const {root,env}=state;const database=join(root,'history-fixture.sqlite');
    await cp(join(projectRoot,'database'),join(root,'database'),{recursive:true});
    env.DB_CONNECTION='sqlite';env.DB_DATABASE=database;
    if(named){Object.assign(env,{BUNDLE_CONNECTIONS:JSON.stringify({history:{DB_CONNECTION:'sqlite',DB_DATABASE:database}})});env.DB_CONNECTION='invalid';env.DB_DATABASE=join(root,'must-not-open.sqlite');}
    const run=(...args:string[])=>state.run(...(named?['--database','history']:[]),...args);
    const migrated=await run('migrate','--isolated');expect(migrated.code,migrated.stderr).toBe(0);
    expect((await run('db:seed')).code).toBe(0);
    const raw=new NativeSqlite(database);
    let before!: {users:unknown[];posts:unknown[];other:unknown[]};try{raw.exec("create table unrelated (id integer primary key, value text); insert into unrelated values (1,'keep'); create view unrelated_view as select * from unrelated");before={users:raw.query('select * from users order by id').all(),posts:raw.query('select * from posts order by id').all(),other:raw.query('select * from unrelated').all()};}finally{raw.close();}
    const sourcePaths=['.snapshot.json','Migration20261106000000.ts'];const sourcesBefore=await Promise.all(sourcePaths.map(path=>Bun.file(join(root,'database','migrations','sqlite',path)).text()));
    const preview=await run('migrate:uninstall','--pretend');expect(preview.code,preview.stderr).toBe(0);expect(JSON.parse(preview.stdout)).toEqual({pretend:true,installed:true,removed:false});
    expect((await run('migrate:uninstall')).code).toBe(1);
    const deleted=await run('--force','migrate:uninstall');expect(deleted.code,deleted.stderr).toBe(0);expect(JSON.parse(deleted.stdout)).toEqual({pretend:false,installed:true,removed:true});
    const after=new NativeSqlite(database,{readonly:true});try{
      expect(after.query("select name from sqlite_master where name='mikro_orm_migrations'").get()).toBeNull();
      expect({users:after.query('select * from users order by id').all(),posts:after.query('select * from posts order by id').all(),other:after.query('select * from unrelated').all()}).toEqual(before);
      expect(after.query('select * from unrelated_view').all()).toEqual([{id:1,value:'keep'}]);
      expect(after.query('select * from bundle_migration_lock').all()).toEqual([]);
    }finally{after.close();}
    const absent=await run('--force','migrate:uninstall');expect(absent.code,absent.stderr).toBe(0);expect(JSON.parse(absent.stdout)).toEqual({pretend:false,installed:false,removed:false});
    const installed=await run('migrate:install');expect(installed.code,installed.stderr).toBe(0);
    const reopened=new NativeSqlite(database,{readonly:true});try{expect(reopened.query('select * from mikro_orm_migrations').all()).toEqual([]);expect(reopened.query('select * from users order by id').all()).toEqual(before.users);}finally{reopened.close();}
    expect(await Promise.all(sourcePaths.map(path=>Bun.file(join(root,'database','migrations','sqlite',path)).text()))).toEqual(sourcesBefore);
    expect(await Bun.file(join(root,'must-not-open.sqlite')).exists()).toBe(false);expect(await Bun.file(join(root,'.data/bundle.sqlite')).exists()).toBe(false);
  },15000);

  test('actual development registry is listed without executing its configured commands',async()=>{
    const {root,env,run}=await fixture();await mkdir(join(root,'src','commands'));
    await writeFile(join(root,'src','commands','DevFixture.ts'),`export default {name:'fixture:dev',description:'fixture',async handle(){await Bun.write(import.meta.dir+'/executed','yes');}};`);
    await writeFile(join(root,'dev.ts'),`import {defineDevelopment} from './src/development/processes.ts';export default defineDevelopment([{name:'fixture',argv:['fixture:dev']}]);`);
    const listed=await run('dev:list');expect(listed.code,listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual({processes:[{name:'fixture',argv:['fixture:dev']}]});
    expect(await Bun.file(join(root,'src','commands','executed')).exists()).toBe(false);
    const started=await run('dev');expect(started.code,started.stderr).toBe(0);
    expect(await Bun.file(join(root,'src','commands','executed')).text()).toBe('yes');
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  for (const code of [0,7]) test(`actual development group preserves first exit ${code} and stops owned peer`,async()=>{
    const {root,env,run}=await fixture();await mkdir(join(root,'src','commands'));
    const started=join(root,'peer-started'),stopped=join(root,'peer-stopped');
    await writeFile(join(root,'src','commands','Group.ts'),`
export const peer={name:'fixture:peer',description:'Owned peer',async handle(_input:any,context:any){await Bun.write(${JSON.stringify(started)},String(process.pid));await new Promise<void>(resolve=>{context.signal.addEventListener('abort',()=>resolve(),{once:true});if(context.signal.aborted)resolve();});await Bun.write(${JSON.stringify(stopped)},'stopped');}};
export const finish={name:'fixture:finish',description:'Handshake finisher',async handle(){const end=Date.now()+5000;while(!await Bun.file(${JSON.stringify(started)}).exists()){if(Date.now()>end)throw Error('Fixture handshake timeout');await Bun.sleep(5);}return ${code};}};`);
    await writeFile(join(root,'dev.ts'),`import {defineDevelopment} from './src/development/processes.ts';export default defineDevelopment([{name:'peer',argv:['fixture:peer']},{name:'finish',argv:['fixture:finish']}]);`);
    const result=await run('dev');expect(result.code,result.stderr).toBe(code);
    expect(await Bun.file(stopped).text()).toBe('stopped');
    const pid=Number(await Bun.file(started).text());expect(()=>process.kill(pid,0)).toThrow();
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  },10000);

  for(const signal of ['SIGINT','SIGTERM'] as const) test(`actual development ${signal} forwards cancellation and reaps owned child`,async()=>{
    const {root,env}=await fixture();await mkdir(join(root,'src','commands'));
    const started=join(root,'child-started'),stopped=join(root,'child-stopped');
    await writeFile(join(root,'src','commands','Live.ts'),`export default {name:'fixture:live',description:'Live fixture',async handle(_input:any,context:any){await Bun.write(${JSON.stringify(started)},String(process.pid));context.output('DEV_FIXTURE_READY');await new Promise<void>(resolve=>{context.signal.addEventListener('abort',()=>resolve(),{once:true});if(context.signal.aborted)resolve();});await Bun.write(${JSON.stringify(stopped)},'settled');}};`);
    await writeFile(join(root,'dev.ts'),`import {defineDevelopment} from './src/development/processes.ts';export default defineDevelopment([{name:'live',argv:['fixture:live']}]);`);
    const child=Bun.spawn([process.execPath,'run','index.ts','dev'],{cwd:root,env,stdout:'pipe',stderr:'pipe'});
    const reader=child.stdout.getReader();let ready='';let timeout:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([(async()=>{while(!ready.includes('DEV_FIXTURE_READY')){const chunk=await reader.read();if(chunk.done)throw Error('Child closed before ready');ready+=new TextDecoder().decode(chunk.value);}})(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Ready timeout')),5000);})]);
      clearTimeout(timeout);child.kill(signal);
      const stderr=new Response(child.stderr).text();const exit=await child.exited;
      expect(exit,await stderr).toBe(signal==='SIGINT'?130:143);
      expect(await Bun.file(stopped).text()).toBe('settled');
      const pid=Number(await Bun.file(started).text());expect(()=>process.kill(pid,0)).toThrow();
      expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
    }finally{clearTimeout(timeout);await reader.cancel().catch(()=>{});reader.releaseLock();if(child.exitCode===null){child.kill('SIGTERM');await child.exited;}}
  },10000);

  test('actual pruning refusal paths do not import early or create a missing database',async()=>{
    const {root,env,run}=await fixture();env.DB_CONNECTION='sqlite';env.DB_DATABASE=join(root,'absent-parent','missing.sqlite');
    const marker=join(root,'pruning-imported');
    await writeFile(join(root,'pruning.ts'),`await Bun.write(${JSON.stringify(marker)},'imported');throw Error('PRIVATE_PRUNING_DETAIL');`);
    const force=await run('model:prune');expect(force.code).toBe(1);expect(force.stderr).toContain('requires --force');expect(await Bun.file(marker).exists()).toBe(false);
    const invalid=await run('model:prune','--pretend','--chunk','0');expect(invalid.code).toBe(1);expect(await Bun.file(marker).exists()).toBe(false);
    const failed=await run('model:prune','--pretend');expect(failed.code).toBe(1);expect(failed.stderr).toContain('Model pruning failed.');expect(failed.stderr).not.toContain('PRIVATE_PRUNING_DETAIL');expect(await Bun.file(marker).exists()).toBe(true);
    await writeFile(join(root,'pruning.ts'),`import {definePruning} from './src/database/pruning-definitions.ts';export default definePruning([]);`);
    const missing=await run('model:prune','--pretend');expect(missing.code).toBe(1);expect(missing.stderr).toContain('Model pruning failed.');
    await expect(lstat(join(root,'absent-parent'))).rejects.toMatchObject({code:'ENOENT'});
    expect(await Bun.file(join(root,'.data/bundle.sqlite')).exists()).toBe(false);
  });

  test('actual explicit queue schema upgrade is force-guarded and registers batch operations without an application database',async()=>{
    const {root,env,run}=await fixture();
    const refused=await run('queue:upgrade');
    expect(refused.code).toBe(1);
    await expect(lstat(join(root,'.bundle-queue'))).rejects.toMatchObject({code:'ENOENT'});
    const upgraded=await run('--force','queue:upgrade');
    expect(upgraded.code,upgraded.stderr).toBe(0);
    expect(JSON.parse(upgraded.stdout)).toEqual({version:2});
    const raw=new NativeSqlite(join(root,'.bundle-queue/queue.sqlite'),{readonly:true});
    try{expect(raw.query('PRAGMA user_version').get()).toEqual({user_version:2});}finally{raw.close();}
    const listed=await run('list');
    for(const command of ['queue:batch','queue:cancel-batch','queue:retry-batch','queue:prune-batches','queue:upgrade'])expect(listed.stdout).toContain(command);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test('actual version1 queue upgrade preserves raw ready and failed work and requires explicit force',async()=>{
    const {root,env,run}=await fixture();await mkdir(join(root,'.bundle-queue'),{mode:0o700});
    const path=join(root,'.bundle-queue/queue.sqlite');
    const legacy=new NativeSqlite(path);
    const ready=JSON.stringify({module:'job.ts',export:'handle',payload:'legacy'});
    try{
      legacy.exec('CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, queue TEXT NOT NULL, job TEXT NOT NULL, available INTEGER NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL, receipt TEXT, lease INTEGER, reason TEXT, failed_at INTEGER)');
      legacy.exec('PRAGMA application_id=1112626501; PRAGMA user_version=1');
      legacy.query('INSERT INTO jobs(queue,job,available,attempts,max_attempts) VALUES(?,?,0,0,1)').run('default',ready);
      legacy.query('INSERT INTO jobs(queue,job,available,attempts,max_attempts,reason,failed_at) VALUES(?,?,0,1,1,?,1000)').run('default','{PRIVATE_CORRUPT_RAW','PRIVATE_FAILURE');
    }finally{legacy.close();}await chmod(path,0o600);
    await writeFile(join(root,'job.ts'),`export async function handle(payload:unknown){await Bun.write(import.meta.dir+'/legacy-delivered',String(payload));}`);
    expect((await run('queue:work','--once')).code).toBe(1);
    expect((await run('queue:upgrade')).code).toBe(1);
    const before=new NativeSqlite(path,{readonly:true});try{expect(before.query('PRAGMA user_version').get()).toEqual({user_version:1});}finally{before.close();}
    const upgraded=await run('--force','queue:upgrade');expect(upgraded.code,upgraded.stderr).toBe(0);expect(JSON.parse(upgraded.stdout)).toEqual({version:2});
    const after=new NativeSqlite(path,{readonly:true});try{
      expect(after.query('PRAGMA user_version').get()).toEqual({user_version:2});
      expect(after.query('SELECT job,reason FROM jobs ORDER BY id').all()).toEqual([{job:ready,reason:null},{job:'{PRIVATE_CORRUPT_RAW',reason:'PRIVATE_FAILURE'}]);
    }finally{after.close();}
    const worked=await run('queue:work','--once');expect(worked.code,worked.stderr).toBe(0);
    expect(await Bun.file(join(root,'legacy-delivered')).text()).toBe('legacy');
    const failures=await run('queue:failed');expect(JSON.parse(failures.stdout).failed).toHaveLength(1);expect(failures.stdout).not.toContain('PRIVATE');
    expect((await run('--force','queue:upgrade')).code).toBe(0);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test.each([false,true])('actual mixed batch executes generated jobs and commands, persists failures and retries only retained work (custom=%s)',async custom=>{
    const {root,env,run}=await fixture();
    const delivered=join(root,'batch-module-result');
    if(custom){
      await mkdir(join(root,'stubs'));
      await writeFile(join(root,'stubs/job.ts.stub'),`import {writeFileSync} from 'node:fs';export class {{name}}{handle(payload:unknown,signal:AbortSignal){signal.throwIfAborted();writeFileSync(${JSON.stringify(delivered)},JSON.stringify(payload));}}`);
    }
    const generated=await run('make:job','Billing/BatchRecord');expect(generated.code,generated.stderr).toBe(0);
    if(!custom){
      const path=join(root,'src/jobs/Billing/BatchRecord.ts');const source=await readFile(path,'utf8');
      // Application logic explicitly fills the default pass-through example; generation alone is not a batch backend.
      expect(source).toContain('void payload;');
      await writeFile(path,`import {writeFileSync} from 'node:fs';\n`+source.replace('void payload;',`writeFileSync(${JSON.stringify(delivered)},JSON.stringify(payload));`).replace('void signal;','signal.throwIfAborted();'));
    }
    await mkdir(join(root,'src/commands'));
    await writeFile(join(root,'src/commands/Batch.ts'),`import {dispatchBatch} from '../queue/dispatch.ts';export const produce={name:'fixture:batch-produce',description:'Persist a mixed batch',async handle(_i:any,c:any){c.output(JSON.stringify(await dispatchBatch({root:c.root,jobs:[{job:{module:'src/jobs/Billing/BatchRecord.ts',export:'BatchRecord',method:'handle',payload:{value:'PRIVATE_PAYLOAD'}}},{job:{kind:'command',version:1,argv:['make:class','Queued/BatchCreated']}},{job:{kind:'command',version:1,argv:['fixture:batch-recover','PRIVATE_ARGV']},maxAttempts:1}]})));}};export const recover={name:'fixture:batch-recover',description:'Explicit controlled failure',arguments:[{name:'value'}],async handle(_i:any,c:any){if(!await Bun.file(c.root+'/allow-batch-recovery').exists())return 7;await Bun.write(c.root+'/batch-recovered','yes');}};`);
    const produced=await run('fixture:batch-produce');expect(produced.code,produced.stderr).toBe(0);
    const batch=JSON.parse(produced.stdout);expect(batch.id).toMatch(/^[a-f0-9]{32}$/);expect(batch.jobIds).toHaveLength(3);
    const worked=await run('queue:work','--stop-when-empty','--backoff','0');expect(worked.code,worked.stderr).toBe(0);
    expect(worked.stdout.trim().split('\n').map(line=>JSON.parse(line).settlement)).toEqual(['acknowledged','acknowledged','failed']);
    expect(JSON.parse(await readFile(delivered,'utf8'))).toEqual({value:'PRIVATE_PAYLOAD'});
    expect(await Bun.file(join(root,'src/classes/Queued/BatchCreated.ts')).exists()).toBe(true);
    const status=await run('queue:batch',batch.id);expect(status.code,status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({id:batch.id,total:3,pending:0,succeeded:2,failed:1,cancelled:0,finishedAt:expect.any(Number)});
    expect(status.stdout).not.toContain('PRIVATE');
    const retried=await run('queue:retry-batch',batch.id);expect(retried.code,retried.stderr).toBe(0);expect(JSON.parse(retried.stdout)).toEqual({id:batch.id,retried:1});
    expect(JSON.parse((await run('queue:batch',batch.id)).stdout)).toMatchObject({pending:1,succeeded:2,failed:0,finishedAt:null});
    await writeFile(join(root,'allow-batch-recovery'),'yes');
    const recovered=await run('queue:work','--once');expect(recovered.code,recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({id:batch.jobIds[2],attempt:1,outcome:'completed',settlement:'acknowledged',commandExitCode:0});
    expect(await Bun.file(join(root,'batch-recovered')).text()).toBe('yes');
    expect(JSON.parse((await run('queue:batch',batch.id)).stdout)).toMatchObject({pending:0,succeeded:3,failed:0});
    expect(JSON.parse((await run('queue:retry-batch',batch.id)).stdout).retried).toBe(0);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  },15000);

  test.each([false,true])('actual batch cancellation preserves a live owner and prevents queued and delayed work (activeFails=%s)',async activeFails=>{
    const {root,env,run}=await fixture();
    const started=join(root,'batch-started'),release=join(root,'batch-release'),delivered=join(root,'batch-delivered');
    await writeFile(join(root,'job.ts'),`import {existsSync,writeFileSync,appendFileSync} from 'node:fs';export async function handle(payload:unknown){if(payload==='active'){writeFileSync(${JSON.stringify(started)},'yes');while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(5);${activeFails?"throw Error('PRIVATE_ACTIVE_FAILURE');":''}}appendFileSync(${JSON.stringify(delivered)},String(payload)+'\\n');}`);
    await mkdir(join(root,'src/commands'));
    await writeFile(join(root,'src/commands/Batch.ts'),`import {dispatchBatch} from '../queue/dispatch.ts';export default{name:'fixture:batch-produce',description:'Persist cancellable work',async handle(_i:any,c:any){c.output(JSON.stringify(await dispatchBatch({root:c.root,jobs:[{job:{module:'job.ts',export:'handle',payload:'active'}},{job:{module:'job.ts',export:'handle',payload:'waiting'}},{job:{module:'job.ts',export:'handle',payload:'delayed'},availableAt:Date.now()+3600000}]})));}};`);
    const produced=await run('fixture:batch-produce');expect(produced.code,produced.stderr).toBe(0);const batch=JSON.parse(produced.stdout);
    const child=Bun.spawn([process.execPath,'run','index.ts','queue:work','--stop-when-empty','--backoff','0'],{cwd:root,env,stdout:'pipe',stderr:'pipe'});
    const out=new Response(child.stdout).text(),err=new Response(child.stderr).text();
    try{
      const deadline=Date.now()+5000;while(!await Bun.file(started).exists()&&child.exitCode===null&&Date.now()<deadline)await Bun.sleep(10);
      expect(await Bun.file(started).exists()).toBe(true);
      const cancelled=await run('queue:cancel-batch',batch.id);expect(cancelled.code,cancelled.stderr).toBe(0);
      expect(JSON.parse(cancelled.stdout)).toMatchObject({pending:1,cancelled:2,succeeded:0,failed:0,finishedAt:null,cancelledAt:expect.any(Number)});
      expect(child.exitCode).toBeNull();
      await writeFile(release,'yes');
      expect(await Promise.race([child.exited,Bun.sleep(3000).then(()=>-999)])).toBe(0);
      expect(await err).toBe('');expect(JSON.parse(await out)).toMatchObject({id:batch.jobIds[0],outcome:activeFails?'failed':'completed',settlement:activeFails?'cancelled':'acknowledged'});
      expect(JSON.parse((await run('queue:batch',batch.id)).stdout)).toMatchObject({pending:0,succeeded:activeFails?0:1,cancelled:activeFails?3:2,failed:0,finishedAt:expect.any(Number)});
      expect((await run('queue:retry-batch',batch.id)).code).toBe(1);
      expect((await run('queue:work','--once')).stdout).toBe('');
      if(activeFails)expect(await Bun.file(delivered).exists()).toBe(false);else expect(await readFile(delivered,'utf8')).toBe('active\n');
      expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
    }finally{if(child.exitCode===null){child.kill('SIGKILL');await child.exited;}await Promise.all([out,err]);}
  },15000);

  test('actual batch worker SIGTERM refunds a command attempt without cancelling the batch',async()=>{
    const {root,env,run}=await fixture();await mkdir(join(root,'src/commands'));
    const started=join(root,'batch-signal-started'),stopped=join(root,'batch-signal-stopped');
    await writeFile(join(root,'src/commands/SignalBatch.ts'),`import {writeFileSync} from 'node:fs';import {dispatchBatch} from '../queue/dispatch.ts';export const produce={name:'fixture:batch-produce',description:'Persist signal-controlled batch',async handle(_i:any,c:any){c.output(JSON.stringify(await dispatchBatch({root:c.root,jobs:[{job:{kind:'command',version:1,argv:['fixture:batch-wait']},maxAttempts:1},{job:{kind:'command',version:1,argv:['make:class','Queued/AfterSignal']}}]})));}};export const wait={name:'fixture:batch-wait',description:'Cooperative signal consumer',async handle(_i:any,c:any){if(await Bun.file(c.root+'/allow-batch-completion').exists())return;await new Promise<void>(resolve=>{c.signal.addEventListener('abort',()=>{writeFileSync(${JSON.stringify(stopped)},'yes');resolve();},{once:true});writeFileSync(${JSON.stringify(started)},'yes');});}};`);
    const produced=await run('fixture:batch-produce');expect(produced.code,produced.stderr).toBe(0);const batch=JSON.parse(produced.stdout);
    const child=Bun.spawn([process.execPath,'run','index.ts','queue:work','--once'],{cwd:root,env,stdout:'pipe',stderr:'pipe'});
    const out=new Response(child.stdout).text(),err=new Response(child.stderr).text();
    try{
      const deadline=Date.now()+5000;while(!await Bun.file(started).exists()&&child.exitCode===null&&Date.now()<deadline)await Bun.sleep(10);
      expect(await Bun.file(started).exists()).toBe(true);child.kill('SIGTERM');
      expect(await Promise.race([child.exited,Bun.sleep(3000).then(()=>-999)])).toBe(143);
      expect(await err).toBe('');expect(JSON.parse(await out)).toMatchObject({id:batch.jobIds[0],attempt:1,outcome:'cancelled',settlement:'released'});
      expect(await Bun.file(stopped).exists()).toBe(true);
      expect(JSON.parse((await run('queue:batch',batch.id)).stdout)).toMatchObject({pending:2,failed:0,cancelled:0,cancelledAt:null,finishedAt:null});
      expect(await Bun.file(join(root,'src/classes/Queued/AfterSignal.ts')).exists()).toBe(false);
      await writeFile(join(root,'allow-batch-completion'),'yes');
      const completed=await run('queue:work','--stop-when-empty');expect(completed.code,completed.stderr).toBe(0);
      const results=completed.stdout.trim().split('\n').map(line=>JSON.parse(line));
      expect(results[0]).toMatchObject({id:batch.jobIds[0],attempt:1,outcome:'completed',settlement:'acknowledged'});
      expect(JSON.parse((await run('queue:batch',batch.id)).stdout)).toMatchObject({pending:0,succeeded:2,failed:0,cancelled:0});
      expect(await Bun.file(join(root,'src/classes/Queued/AfterSignal.ts')).exists()).toBe(true);
      expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
    }finally{if(child.exitCode===null){child.kill('SIGKILL');await child.exited;}await Promise.all([out,err]);}
  },15000);

  test('actual batch history pruning obeys strict cutoff and detaches retained failures without deleting work',async()=>{
    const {root,env,run}=await fixture();await mkdir(join(root,'.bundle-queue'),{mode:0o700});
    const store=new QueueStore(join(root,'.bundle-queue/queue.sqlite'),()=>1000);
    let terminal:string,pending:string,failedId:number;
    try{
      const first=store.enqueueBatch([{job:{module:'job.ts',export:'handle',payload:'PRIVATE_FAILED'},maxAttempts:1}]);terminal=first.id;failedId=first.jobIds[0]!;
      expect(store.fail(store.reserve(['default'])!.receipt,'PRIVATE_REASON')).toBe(true);
      pending=store.enqueueBatch([{job:{module:'job.ts',export:'handle',payload:'live'}},{job:{module:'job.ts',export:'handle',payload:'waiting'}}]).id;
      expect(store.reserve(['default'],{leaseMs:60000})).not.toBeNull();
      store.enqueue('other',{module:'job.ts',export:'handle',payload:'unrelated'});
    }finally{store.close();}
    const refused=await run('queue:prune-batches','--before','1001');expect(refused.code).toBe(1);
    const equal=await run('--force','queue:prune-batches','--before','1000');expect(equal.code,equal.stderr).toBe(0);expect(JSON.parse(equal.stdout).removed).toBe(0);
    const removed=await run('--force','queue:prune-batches','--before','1001');expect(removed.code,removed.stderr).toBe(0);expect(JSON.parse(removed.stdout).removed).toBe(1);
    expect((await run('queue:batch',terminal!)).code).toBe(1);
    expect(JSON.parse((await run('queue:batch',pending!)).stdout)).toMatchObject({pending:2,total:2,finishedAt:null});
    const failed=await run('queue:failed');expect(failed.stdout).not.toContain('PRIVATE');expect(JSON.parse(failed.stdout).failed.map((r:any)=>r.id)).toContain(failedId!);
    expect(JSON.parse((await run('queue:retry',String(failedId!))).stdout).retried).toBe(true);
    expect(JSON.parse((await run('queue:monitor','--queue','other')).stdout).ready).toBe(1);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test.each([false,true])('actual model-associated resource controller persists through live HTTP and cached own methods (custom=%s)',async custom=>{
    const {root,run,env}=await fixture();
    const modelPath=join(root,'src/models/User.ts');const modelSource=await readFile(modelPath,'utf8');
    await writeFile(modelPath,`await Bun.write(import.meta.dir+'/model-imported','yes');\n${modelSource}`);
    if(custom){
      await mkdir(join(root,'stubs'));
      const methods=['index','show','store','update','destroy'].map(method=>`async ${method}(context:_Context):Promise<Response>{return _resource(context,_Model).${method}(context);}`).join('\n');
      await writeFile(join(root,'stubs/controller-resource.ts.stub'),`import type {HttpContext as _Context} from '{{contextImport}}';import {modelResourceFor as _resource} from '{{runtimeImport}}';import { {{modelName}} as _Model } from '{{modelImport}}';export const customization=true;export class {{name}}{${methods}}`);
    }
    const generated=await run('make:controller','Api/UserResourceController','--resource','--model','User');
    expect(generated.code,generated.stderr).toBe(0);
    const target=join(root,'src/http/controllers/Api/UserResourceController.ts');const generatedSource=await readFile(target,'utf8');
    expect(await Bun.file(join(root,'src/models/model-imported')).exists()).toBe(false);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
    expect(await readFile(modelPath,'utf8')).toBe(`await Bun.write(import.meta.dir+'/model-imported','yes');\n${modelSource}`);
    expect((await run('--force','make:controller','Api/UserResourceController','--resource','--model','User')).code).toBe(1);
    expect(await readFile(target,'utf8')).toBe(generatedSource);
    await writeFile(join(root,'tsconfig.json'),JSON.stringify({extends:join(projectRoot,'tsconfig.json'),include:['src/http/controllers/**/*.ts']}));
    const checker=Bun.spawn([process.execPath,'check','--project',join(root,'tsconfig.json')],{cwd:root,env,stdout:'pipe',stderr:'pipe'});
    const [checkOut,checkErr,checkCode]=await Promise.all([new Response(checker.stdout).text(),new Response(checker.stderr).text(),checker.exited]);
    expect(checkCode,checkOut+checkErr).toBe(0);
    await writeFile(join(root,'consume-resource.ts'),`
import {MikroORM} from '@mikro-orm/core';import {SqliteDriver} from '@mikro-orm/sqlite';
import UserSchema,{User} from './src/models/User.ts';import PostSchema from './src/models/Post.ts';
import {createRouter} from './src/http/router.ts';import {modelResourceMiddleware} from './src/http/model-resource.ts';
import {rules,validateRequest} from './src/http/validation.ts';import * as Generated from './src/http/controllers/Api/UserResourceController.ts';
export async function consume(root:string){
 const orm=await MikroORM.init({driver:SqliteDriver,dbName:root+'/resource-consumer.sqlite',entities:[UserSchema,PostSchema],logger:()=>{}});let server:any;
 try{
  await orm.schema.create();const parent=orm.em.fork();const pending=parent.create(User,{name:'Caller pending',email:'pending@example.invalid'});
  const createSchema=rules.object({name:rules.string({min:1,max:120}),email:rules.string({email:true,max:254})});
  const updateSchema=rules.object({name:rules.string({min:1,max:120})});
  const parse=async(context:any,schema:any)=>{const result=await validateRequest(context.request,schema,{maxBytes:4096});return result.ok?result.value:Response.json({error:'Invalid input'},{status:422});};
  const middleware=modelResourceMiddleware({model:User,manager:()=>parent,parseId:Number,create:(c:any)=>parse(c,createSchema),update:(c:any)=>parse(c,updateSchema),serialize:(u:User)=>({id:u.id,name:u.name})});
  const controller=new Generated.UserResourceController();const router=createRouter();
  router.add('GET','/users',c=>controller.index(c),{middleware:[middleware]});router.add('GET','/users/:id',c=>controller.show(c),{middleware:[middleware]});
  router.add('POST','/users',c=>controller.store(c),{middleware:[middleware]});router.add('PATCH','/users/:id',c=>controller.update(c),{middleware:[middleware]});router.add('DELETE','/users/:id',c=>controller.destroy(c),{middleware:[middleware]});
  server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:(request:Request)=>router.fetch(request)});
  const call=async(method:string,path:string,body?:unknown)=>{const response=await fetch(new URL(path,server.url),{method,...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const text=await response.text();let data:unknown=null;if(text){try{data=JSON.parse(text);}catch{data=text;}}return {status:response.status,cache:response.headers.get('cache-control'),data};};
  const created=await call('POST','/users',{name:'Resource created',email:'resource@example.invalid'});const id=created.data.id;
  const list=await call('GET','/users');const show=await call('GET','/users/'+id);const updated=await call('PATCH','/users/'+id,{name:'Resource updated'});
  const invalid=await call('POST','/users',{name:'Missing email'});const invalidId=await call('GET','/users/0');
  const deleted=await call('DELETE','/users/'+id);const absent=await call('GET','/users/'+id);
  const callerBefore=await orm.em.fork().count(User,{email:'pending@example.invalid'});await parent.flush();const callerAfter=await orm.em.fork().count(User,{email:'pending@example.invalid'});
  return {statuses:[created,list,show,updated,invalid,invalidId,deleted,absent].map(r=>r.status),noStore:[created,list,show,updated,invalid,invalidId,deleted,absent].every(r=>r.cache==='no-store'),createdFields:Object.keys(created.data).sort(),listed:list.data.length,shown:show.data.name,updated:updated.data.name,callerBefore,callerAfter,pendingId:pending.id,customized:Object.hasOwn(Generated,'customization')};
 }finally{if(server)await server.stop(true);await orm.close(true);}
}
`);
    await mkdir(join(root,'src/commands'));
    await writeFile(join(root,'src/commands/Resource.ts'),`import {consume} from '../../consume-resource.ts';export default {name:'fixture:resource',description:'Consume generated model resource',async handle(_i:any,c:any){c.output(JSON.stringify(await consume(c.root)));}};`);
    const consumed=await run('fixture:resource');expect(consumed.code,consumed.stderr).toBe(0);
    const result=JSON.parse(consumed.stdout);
    expect(result).toMatchObject({statuses:[201,200,200,200,422,400,204,404],noStore:true,createdFields:['id','name'],listed:1,shown:'Resource created',updated:'Resource updated',callerBefore:0,callerAfter:1,customized:custom});
    expect(await Bun.file(join(root,'src/models/model-imported')).text()).toBe('yes');
    await writeFile(join(root,'resource-cache.ts'),`import {MikroORM} from '@mikro-orm/core';import {SqliteDriver} from '@mikro-orm/sqlite';import UserSchema,{User} from './src/models/User.ts';import PostSchema from './src/models/Post.ts';import {modelResourceMiddleware} from './src/http/model-resource.ts';let owned:Promise<any>|undefined;export const middleware=modelResourceMiddleware({model:User,manager:async()=>{owned??=MikroORM.init({driver:SqliteDriver,dbName:import.meta.dir+'/resource-consumer.sqlite',entities:[UserSchema,PostSchema],logger:()=>{}});return(await owned).em;},parseId:Number,create:()=>Response.json({}, {status:400}),update:()=>Response.json({}, {status:400}),serialize:(u:User)=>({id:u.id,name:u.name})});`);
    const definitions=[{method:'GET',path:'/users',handler:{module:'src/http/controllers/Api/UserResourceController.ts',export:'UserResourceController',method:'index'},middleware:[{module:'resource-cache.ts',export:'middleware'}]},{method:'GET',path:'/users/:id',handler:{module:'src/http/controllers/Api/UserResourceController.ts',export:'UserResourceController',method:'show'},middleware:[{module:'resource-cache.ts',export:'middleware'}]}];
    await writeFile(join(root,'routes.ts'),`import {defineRoutes} from './src/http/route-definitions.ts';export default defineRoutes(${JSON.stringify(definitions)});`);
    const cached=await run('route:cache');expect(cached.code,cached.stderr).toBe(0);
    await writeFile(join(root,'routes.ts'),`throw Error('resource source fallback forbidden');`);
    const server=await startApplicationServer({root,port:0});cleanups.push(async()=>{await server.stop();await server.closed;});
    expect(await (await fetch(new URL('/users',server.url))).json()).toEqual([{id:result.pendingId,name:'Caller pending'}]);
    expect(await (await fetch(new URL('/users/'+result.pendingId,server.url))).json()).toEqual({id:result.pendingId,name:'Caller pending'});
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  },15000);

  test('actual vendor publication is consumed as configuration, locale and JSON without importing source assets',async()=>{
    const {root,run,env}=await fixture();
    await mkdir(join(root,'vendor-resources'));
    const configuration=`await Bun.write(import.meta.dir+'/imported','yes');export default {label:'Published config'};\n`;
    await writeFile(join(root,'vendor-resources/config.ts'),configuration);
    await writeFile(join(root,'vendor-resources/fr.ts'),'export default {"bundle.greeting":"Bonjour, {name}."};\n');
    await writeFile(join(root,'vendor-resources/data.json'),'{"enabled":true}\n');
    await writeFile(join(root,'vendor-resources/extra.txt'),'other package\n');
    const assets=[
      {package:'acme',tag:'defaults',source:'vendor-resources/config.ts',destination:'config/acme.ts'},
      {package:'acme',tag:'defaults',source:'vendor-resources/fr.ts',destination:'lang/fr.ts'},
      {package:'acme',tag:'defaults',source:'vendor-resources/data.json',destination:'resources/acme/data.json'},
      {package:'other',tag:'defaults',source:'vendor-resources/extra.txt',destination:'resources/other.txt'},
    ];
    await writeFile(join(root,'publish.ts'),`export default ${JSON.stringify({version:1,assets})};`);
    const published=await run('vendor:publish','--package','acme','--tag','defaults');
    expect(published.code,published.stderr).toBe(0);
    expect(JSON.parse(published.stdout)).toEqual({created:assets.slice(0,3).map(a=>a.destination)});
    expect(await Bun.file(join(root,'vendor-resources/imported')).exists()).toBe(false);
    expect(await Bun.file(join(root,'resources/other.txt')).exists()).toBe(false);
    expect((await lstat(join(root,'config/acme.ts'))).mode&0o777).toBe(0o600);
    const config=await run('config:show','acme.label');expect(config.code).toBe(0);
    expect(JSON.parse(config.stdout)).toBe('Published config');
    expect(await Bun.file(join(root,'config/imported')).text()).toBe('yes');
    expect(await Bun.file(join(root,'vendor-resources/imported')).exists()).toBe(false);
    await mkdir(join(root,'src/commands'));
    await writeFile(join(root,'src/commands/Published.ts'),`import {translate} from '../localization/messages.ts';export default {name:'fixture:published',description:'Consume published resources',async handle(_i:any,c:any){c.output(JSON.stringify({message:await translate(c.root,'bundle.greeting',{locale:'fr',values:{name:'Vox'}}),data:await Bun.file(c.root+'/resources/acme/data.json').json()}));}};`);
    const consumed=await run('fixture:published');expect(consumed.code).toBe(0);
    expect(JSON.parse(consumed.stdout)).toEqual({message:'Bonjour, Vox.',data:{enabled:true}});
    await writeFile(join(root,'tsconfig.json'),JSON.stringify({extends:join(projectRoot,'tsconfig.json'),include:['config/**/*.ts','lang/**/*.ts']}));
    const checker=Bun.spawn([process.execPath,'check','--project',join(root,'tsconfig.json')],{cwd:root,env,stdout:'pipe',stderr:'pipe'});
    const [checkOut,checkErr,checkCode]=await Promise.all([new Response(checker.stdout).text(),new Response(checker.stderr).text(),checker.exited]);
    expect(checkCode,checkOut+checkErr).toBe(0);
    expect((await run('--force','vendor:publish','--package','acme')).code).toBe(1);
    expect(await readFile(join(root,'config/acme.ts'),'utf8')).toBe(configuration);
    expect((await run('vendor:publish','--package','other')).code).toBe(0);
    expect(await Bun.file(join(root,'resources/other.txt')).text()).toBe('other package\n');
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test('actual vendor publication rejects conflicts before publishing any earlier selected asset',async()=>{
    const {root,run,env}=await fixture();
    await mkdir(join(root,'vendor-resources'));await mkdir(join(root,'config'));
    await writeFile(join(root,'vendor-resources/data.json'),'{"ok":true}');
    await writeFile(join(root,'vendor-resources/config.ts'),'export default {label:"new"};');
    await writeFile(join(root,'config/acme.ts'),'export default {label:"keep"};');
    const assets=[
      {package:'acme',tag:'defaults',source:'vendor-resources/data.json',destination:'resources/new.json'},
      {package:'acme',tag:'defaults',source:'vendor-resources/config.ts',destination:'config/acme.ts'},
    ];
    await writeFile(join(root,'publish.ts'),`export default ${JSON.stringify({version:1,assets})};`);
    const refused=await run('--force','vendor:publish','--all');expect(refused.code).toBe(1);
    expect(await Bun.file(join(root,'resources/new.json')).exists()).toBe(false);
    expect(await readdir(root)).not.toContain('resources');
    expect(await readFile(join(root,'config/acme.ts'),'utf8')).toContain('keep');
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test('actual vendor publication rejects selected destination ancestor conflicts before creating output',async()=>{
    const {root,run}=await fixture();await mkdir(join(root,'vendor-resources'));
    await writeFile(join(root,'vendor-resources/data.json'),'{}');
    const assets=[
      {package:'acme',tag:'defaults',source:'vendor-resources/data.json',destination:'resources/parent.json'},
      {package:'acme',tag:'defaults',source:'vendor-resources/data.json',destination:'resources/parent.json/child.json'},
    ];
    await writeFile(join(root,'publish.ts'),`export default ${JSON.stringify({version:1,assets})};`);
    expect((await run('vendor:publish','--all')).code).toBe(1);
    expect(await readdir(root)).not.toContain('resources');
  });

  test.each(['json','txt'] as const)('actual vendor publication accepts .d.%s data filenames without treating them as declarations',async extension=>{
    const {root,run}=await fixture();await mkdir(join(root,'vendor-resources'));
    const content=extension==='json'?'{"data":true}':'ordinary text';
    await writeFile(join(root,`vendor-resources/records.d.${extension}`),content);
    await writeFile(join(root,`vendor-resources/records.${extension}`),content);
    const assets=[
      {package:'acme',tag:'defaults',source:`vendor-resources/records.d.${extension}`,destination:`resources/records.${extension}`},
      {package:'acme',tag:'defaults',source:`vendor-resources/records.${extension}`,destination:`resources/copy.d.${extension}`},
    ];
    await writeFile(join(root,'publish.ts'),`export default ${JSON.stringify({version:1,assets})};`);
    const result=await run('vendor:publish','--all');expect(result.code,result.stderr).toBe(0);
    for(const item of assets)expect(await readFile(join(root,item.destination),'utf8')).toBe(content);
  });

  test('actual vendor selection validates before trusted import and sanitizes explicit source failures',async()=>{
    const {root,run,env}=await fixture();
    await writeFile(join(root,'publish.ts'),`await Bun.write(import.meta.dir+'/manifest-imported','yes');throw Error('private-publication-exception');export default {version:1,assets:[]};`);
    expect((await run('list')).code).toBe(0);
    expect(await Bun.file(join(root,'manifest-imported')).exists()).toBe(false);
    expect((await run('vendor:publish','--all','--package','acme')).code).toBe(1);
    expect(await Bun.file(join(root,'manifest-imported')).exists()).toBe(false);
    const invalidSource=await run('vendor:publish','--all');expect(invalidSource.code).toBe(1);
    expect(invalidSource.stdout+invalidSource.stderr).not.toContain('private-publication-exception');
    expect(await Bun.file(join(root,'manifest-imported')).exists()).toBe(true);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test.each(['SIGINT','SIGTERM'] as const)('actual vendor publication respects %s during trusted manifest import',async signal=>{
    const {root,env}=await fixture();await mkdir(join(root,'vendor-resources'));
    await writeFile(join(root,'vendor-resources/data.json'),'{"ok":true}');
    const manifest={version:1,assets:[{package:'acme',tag:'defaults',source:'vendor-resources/data.json',destination:'resources/data.json'}]};
    await writeFile(join(root,'publish.ts'),`const keepAlive=setInterval(()=>{},1000);const interrupted=new Promise<void>(resolve=>{process.once('SIGINT',()=>resolve());process.once('SIGTERM',()=>resolve());});process.stdout.write('publication-import-ready\\n');try{await interrupted;}finally{clearInterval(keepAlive);}export default ${JSON.stringify(manifest)};`);
    const child=Bun.spawn([process.execPath,'run','index.ts','vendor:publish','--all'],{cwd:root,env,stdout:'pipe',stderr:'pipe'});
    const stderr=new Response(child.stderr).text();
    try {
      const reader=child.stdout.getReader();const first=await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('publication-import-ready');
      child.kill(signal);for(;;){const part=await reader.read();if(part.done)break;}
      expect(await child.exited).toBe(signal==='SIGINT'?130:143);await stderr;
      expect(await Bun.file(join(root,'resources/data.json')).exists()).toBe(false);
      expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
    } finally {if(child.exitCode===null){child.kill('SIGKILL');await child.exited;}}
  });

  test('actual lang:publish produces strictly compiled resources consumed by fresh text translation processes',async()=>{
    const {root,run,env}=await fixture();
    const published=await run('lang:publish');expect(published.code).toBe(0);
    expect(JSON.parse(published.stdout)).toEqual({created:['lang/en.ts']});
    const path=join(root,'lang/en.ts');expect((await lstat(path)).mode&0o777).toBe(0o600);
    await writeFile(join(root,'tsconfig.json'),JSON.stringify({extends:join(projectRoot,'tsconfig.json'),include:['lang/**/*.ts']}));
    const checker=Bun.spawn([process.execPath,'check','--project',join(root,'tsconfig.json')],{cwd:root,env,stdout:'pipe',stderr:'pipe'});
    const [checkOut,checkErr,checkCode]=await Promise.all([new Response(checker.stdout).text(),new Response(checker.stderr).text(),checker.exited]);
    expect(checkCode,checkOut+checkErr).toBe(0);
    await mkdir(join(root,'src/commands'));
    await writeFile(join(root,'src/commands/Message.ts'),`import {translate} from '../localization/messages.ts';export default {name:'fixture:message',description:'Consume language resources',async handle(_i:any,c:any){c.output(JSON.stringify({ready:await translate(c.root,'bundle.ready'),greeting:await translate(c.root,'bundle.greeting',{values:{name:'Vox'}})}));}};`);
    const initial=await run('fixture:message');expect(initial.code).toBe(0);
    expect(JSON.parse(initial.stdout)).toEqual({ready:'Bundle is ready.',greeting:'Hello, Vox.'});
    const customized='export default {"bundle.ready":"Prêt ✓"};\n';await writeFile(path,customized);
    const changed=await run('fixture:message');expect(changed.code).toBe(0);
    expect(JSON.parse(changed.stdout)).toEqual({ready:'Prêt ✓',greeting:'Hello, Vox.'});
    expect((await run('--force','lang:publish')).code).toBe(1);
    expect(await readFile(path,'utf8')).toBe(customized);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test('actual text translation validates locale before importing a private application catalogue',async()=>{
    const {root,run}=await fixture();expect((await run('lang:publish')).code).toBe(0);
    await writeFile(join(root,'lang/en.ts'),`await Bun.write(import.meta.dir+'/imported','bad');throw Error('private-catalogue-exception');export default {};`);
    await mkdir(join(root,'src/commands'));
    await writeFile(join(root,'src/commands/Message.ts'),`import {translate} from '../localization/messages.ts';export default {name:'fixture:message',description:'Reject unsafe locale',async handle(_i:any,c:any){c.output(await translate(c.root,'bundle.ready',{locale:'../outside'}));}};`);
    const invalid=await run('fixture:message');expect(invalid.code).toBe(1);
    expect(invalid.stdout+invalid.stderr).not.toContain('private-catalogue-exception');
    expect(await Bun.file(join(root,'lang/imported')).exists()).toBe(false);
  });

  test.each([{signal:'SIGINT',previous:false},{signal:'SIGTERM',previous:true}] as const)('actual package discovery stops on $signal without publishing cancelled metadata',async({signal,previous})=>{
    const {root,env}=await fixture();const cache=join(root,'bootstrap/cache/packages.json');const old=JSON.stringify({version:1,packages:[]})+'\n';
    if(previous){await mkdir(join(root,'bootstrap/cache'),{recursive:true});await writeFile(cache,old,{mode:0o600});}
    await writeFile(join(root,'packages.ts'),`process.stdout.write('package-import-ready\\n');await new Promise(resolve=>setTimeout(resolve,150));export default [{name:'cancelled',providers:[]}];`);
    const child=Bun.spawn([process.execPath,'run','index.ts',...(previous?['--force']:[]),'package:discover'],{cwd:root,env,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
    try{
      const reader=child.stdout.getReader();const first=await reader.read();expect(new TextDecoder().decode(first.value)).toContain('package-import-ready');
      child.kill(signal);for(;;){const part=await reader.read();if(part.done)break;}
      expect(await child.exited).toBe(signal==='SIGINT'?130:143);
      if(previous)expect(await readFile(cache,'utf8')).toBe(old);else expect(await Bun.file(cache).exists()).toBe(false);
      expect(await new Response(child.stderr).text()).not.toContain('cancelled');
    }finally{child.kill();await child.exited;}
  },10000);

  test('actual package:discover metadata boots cached providers without source fallback or discovery-time hooks',async()=>{
    const {root,run,env}=await fixture();
    await mkdir(join(root,'src/providers'),{recursive:true});
    await writeFile(join(root,'src/providers/FromPackage.ts'),`await Bun.write(import.meta.dir+'/imported','yes');export class FromPackage {private value='registered';register(c:any){c.container.register('packaged','singleton',()=>this.value);}boot(){this.value='package-booted';}}`);
    const source=`export default [{name:'billing',providers:[{module:'src/providers/FromPackage.ts',export:'FromPackage'}]}];`;
    await writeFile(join(root,'packages.ts'),source);
    const discovered=await run('package:discover');expect(discovered.code).toBe(0);
    expect(JSON.parse(discovered.stdout)).toMatchObject({packages:1,providers:1});
    expect(await Bun.file(join(root,'src/providers/imported')).exists()).toBe(false);
    const cache=join(root,'bootstrap/cache/packages.json');const original=await readFile(cache,'utf8');
    expect((await lstat(cache)).mode&0o777).toBe(0o600);
    await writeFile(join(root,'packages.ts'),`throw Error('private-package-source');export default [];`);
    await mkdir(join(root,'src/commands'));
    await writeFile(join(root,'src/commands/Packaged.ts'),`export default {name:'fixture:packaged',description:'Cached provider service',handle(_i:any,c:any){c.output(c.services.resolve('packaged'));}};`);
    expect(await run('fixture:packaged')).toEqual({code:0,stdout:'package-booted\n',stderr:''});
    expect(await Bun.file(join(root,'src/providers/imported')).exists()).toBe(true);
    const invalid=await run('--force','package:discover');expect(invalid.code).toBe(1);
    expect(invalid.stdout+invalid.stderr).not.toContain('private-package-source');
    expect(await readFile(cache,'utf8')).toBe(original);
    expect((await run('package:clear')).code).toBe(0);
    expect(await Bun.file(cache).exists()).toBe(false);
    const absent=await run('fixture:packaged');expect(absent.code).toBe(1);
    expect(absent.stderr).not.toContain('private-package-source');
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test('actual cached package references combine with root providers and unsafe metadata fails before command imports',async()=>{
    const {root,run}=await fixture();
    await writeFile(join(root,'Provider.ts'),`await Bun.write(import.meta.dir+'/provider-imported','yes');export class Provider {register(){}}`);
    await writeFile(join(root,'packages.ts'),`export default [{name:'checked',providers:[{module:'Provider.ts',export:'Provider'}]}];`);
    expect((await run('package:discover')).code).toBe(0);
    await writeFile(join(root,'providers.ts'),`export default [{module:'Provider.ts',export:'Provider'}];`);
    expect((await run('--version')).code).toBe(1);
    expect(await Bun.file(join(root,'provider-imported')).exists()).toBe(false);
    await rm(join(root,'providers.ts'));
    const cache=join(root,'bootstrap/cache/packages.json');await writeFile(cache,'{"version":1,"packages":[],"packages":[]}');
    await mkdir(join(root,'src/commands'));
    await writeFile(join(root,'src/commands/Unexpected.ts'),`await Bun.write(import.meta.dir+'/imported','bad');export default {name:'fixture:unexpected',description:'Never imported',handle(){}};`);
    expect((await run('--version')).code).toBe(1);
    expect(await Bun.file(join(root,'src/commands/imported')).exists()).toBe(false);
    expect(await readFile(cache,'utf8')).toBe('{"version":1,"packages":[],"packages":[]}');
  });

  test.each([false,true])('actual event:generate consumes %s customized registered listeners through cached dispatch',async custom=>{
    const {root,run,env}=await fixture();
    const source=`import {defineEvents} from './src/events/definitions.ts';export default defineEvents([{event:'billing.invoice-created',listeners:[{module:'src/listeners/Billing/RecordInvoice.ts',export:'RecordInvoice',method:'handle'}]}]);`;
    await writeFile(join(root,'events.ts'),source);
    if(custom){
      expect((await run('stub:publish')).code).toBe(0);
      await writeFile(join(root,'stubs/listener.ts.stub'),`export class {{name}} {async handle(payload:unknown,signal:AbortSignal){signal.throwIfAborted();const data=payload as {destination:string;value:string};await Bun.write(data.destination,data.value);}}`);
    }
    const generated=await run('event:generate');
    expect(generated.code).toBe(0);
    expect(JSON.parse(generated.stdout)).toEqual({created:['src/listeners/Billing/RecordInvoice.ts'],existing:[]});
    const target=join(root,'src/listeners/Billing/RecordInvoice.ts');const content=await readFile(target,'utf8');
    expect(await readFile(join(root,'events.ts'),'utf8')).toBe(source);
    expect(await Bun.file(join(root,'listener-result')).exists()).toBe(false);
    await writeFile(join(root,'tsconfig.json'),JSON.stringify({extends:join(projectRoot,'tsconfig.json'),include:['src/listeners/**/*.ts']}));
    const checker=Bun.spawn([process.execPath,'check','--project',join(root,'tsconfig.json')],{cwd:root,env,stdout:'pipe',stderr:'pipe'});
    const [checkOut,checkErr,checkCode]=await Promise.all([new Response(checker.stdout).text(),new Response(checker.stderr).text(),checker.exited]);
    expect(checkCode,checkOut+checkErr).toBe(0);
    expect((await run('event:cache')).code).toBe(0);
    const cached=await readFile(join(root,'bootstrap/cache/events.json'),'utf8');
    const repeated=await run('--force','event:generate');expect(repeated.code).toBe(0);
    expect(JSON.parse(repeated.stdout)).toEqual({created:[],existing:['src/listeners/Billing/RecordInvoice.ts']});
    expect(await readFile(target,'utf8')).toBe(content);
    expect(await readFile(join(root,'bootstrap/cache/events.json'),'utf8')).toBe(cached);
    await writeFile(join(root,'events.ts'),`throw Error('cached dispatch must not import changed source');export default [];`);
    await mkdir(join(root,'src/commands'));
    await writeFile(join(root,'src/commands/Dispatch.ts'),`import {loadApplicationEvents} from '../events/cache.ts';export default {name:'fixture:dispatch-generated',description:'Consume generated registrations',async handle(_i:any,c:any){const bus=await loadApplicationEvents(c.root);await bus.dispatch('billing.invoice-created',{destination:c.root+'/listener-result',value:'generated-handler'});c.output(JSON.stringify({listeners:bus.describe()[0]?.listeners,dispatched:true}));}};`);
    const dispatched=await run('fixture:dispatch-generated');
    expect(dispatched).toEqual({code:0,stdout:'{"listeners":1,"dispatched":true}\n',stderr:''});
    if(custom)expect(await readFile(join(root,'listener-result'),'utf8')).toBe('generated-handler');
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test('actual event:generate preflights unsupported missing references before creating any listener',async()=>{
    const {root,run}=await fixture();
    await writeFile(join(root,'events.ts'),`import {defineEvents} from './src/events/definitions.ts';export default defineEvents([{event:'checked',listeners:[{module:'src/listeners/Good.ts',export:'Good',method:'handle'},{module:'src/helpers/Missing.ts',export:'Missing'}]}]);`);
    expect((await run('event:generate')).code).toBe(1);
    expect(await Bun.file(join(root,'src/listeners/Good.ts')).exists()).toBe(false);
  });

  test.each([false,true])('actual make:provider consumes %s customized lifecycle registration and strict imports',async custom=>{
    const {root,run,env}=await fixture();
    if(custom){
      expect((await run('stub:publish')).code).toBe(0);
      await writeFile(join(root,'stubs/provider.ts.stub'),`import type {ApplicationProvider as _Provider,ProviderContext as _Context} from "{{runtimeImport}}";export class {{name}} implements _Provider {register(c:_Context){c.container.register("{{serviceKey}}","singleton",()=>"custom-provider");}}`);
    }
    const generated=await run('make:provider','Billing/ApplicationProvider');
    expect(generated.code).toBe(0);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
    await writeFile(join(root,'tsconfig.json'),JSON.stringify({extends:join(projectRoot,'tsconfig.json'),include:['src/providers/**/*.ts']}));
    const checker=Bun.spawn([process.execPath,'check','--project',join(root,'tsconfig.json')],{cwd:root,env,stdout:'pipe',stderr:'pipe'});
    const [checkOut,checkErr,checkCode]=await Promise.all([new Response(checker.stdout).text(),new Response(checker.stderr).text(),checker.exited]);
    expect(checkCode,checkOut+checkErr).toBe(0);
    await writeFile(join(root,'providers.ts'),`export default [{module:'src/providers/Billing/ApplicationProvider.ts',export:'ApplicationProvider'}];`);
    await mkdir(join(root,'src/commands'));
    await writeFile(join(root,'src/commands/Provided.ts'),`export default {name:'fixture:provided',description:'Generated provider',handle(_i:any,c:any){c.output(c.services.resolve('provider:Billing.ApplicationProvider'));}};`);
    const consumed=await run('fixture:provided');
    expect(consumed).toEqual({code:0,stdout:custom?'custom-provider\n':'booted\n',stderr:''});
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
    expect((await run('--force','make:provider','Billing/ApplicationProvider')).code).toBe(1);
  });

  test.each(['SIGINT','SIGTERM'] as const)('actual provider cleanup handles %s until all owned disposal settles',async signal=>{
    const {root,env}=await fixture();
    await writeFile(join(root,'providers.ts'),`export default [{module:'Provider.ts',export:'Provider'}];`);
    await writeFile(join(root,'Provider.ts'),`let signal:AbortSignal;export class Provider {register(c:any){signal=c.signal;c.container.register('resource','singleton',()=>({dispose(){return Bun.write(import.meta.dir+'/service-disposed','yes');}}));}async dispose(){process.stdout.write('cleanup-ready\\n');if(!signal.aborted)await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));await Bun.write(import.meta.dir+'/provider-disposed','yes');}}`);
    await mkdir(join(root,'src/commands'));
    await writeFile(join(root,'src/commands/Provided.ts'),`export default {name:'fixture:provided',description:'Owned resource',handle(_i:any,c:any){c.services.resolve('resource');}};`);
    const child=Bun.spawn([process.execPath,'run','index.ts','fixture:provided'],{cwd:root,env,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
    try{
      const reader=child.stdout.getReader();const first=await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain('cleanup-ready');
      child.kill(signal);
      for(;;){const part=await reader.read();if(part.done)break;}
      expect(await child.exited).toBe(signal==='SIGINT'?130:143);
      expect(await new Response(child.stderr).text()).toBe('');
      expect(await Bun.file(join(root,'provider-disposed')).exists()).toBe(true);
      expect(await Bun.file(join(root,'service-disposed')).exists()).toBe(true);
    }finally{child.kill();await child.exited;}
  },10000);

  test('actual application providers register and boot before nested command resolution without a database',async()=>{
    const {root,run,env}=await fixture();
    await writeFile(join(root,'Provider.ts'),`import {appendFile} from 'node:fs/promises';const log=(s:string)=>appendFile(import.meta.dir+'/provider-events',s+'\\n');export class Provider {async register(c:any){await log('register');c.container.register('provided','singleton',()=>({text:'from-provider',dispose(){return log('service-dispose');}}));}async boot(){await log('boot');await Bun.write(import.meta.dir+'/booted','yes');}dispose(){return log('provider-dispose');}}`);
    await writeFile(join(root,'providers.ts'),`export default [{module:'Provider.ts',export:'Provider'}];`);
    await mkdir(join(root,'src/commands'));
    await writeFile(join(root,'src/commands/Provided.ts'),`if(!await Bun.file(import.meta.dir+'/../../booted').exists())throw Error('not booted');export const outer={name:'fixture:provided',description:'Provided',async handle(_i:any,c:any){c.output(c.services.resolve('provided').text);return c.call(['fixture:inner']);}};export const inner={name:'fixture:inner',description:'Nested',handle(_i:any,c:any){c.output(c.services.resolve('provided').text);}};`);
    expect(await run('fixture:provided')).toEqual({code:0,stdout:'from-provider\nfrom-provider\n',stderr:''});
    expect((await readFile(join(root,'provider-events'),'utf8')).trim().split('\n')).toEqual(['register','boot','provider-dispose','service-dispose']);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test('actual schedule:test explicitly selects a never-due task and refuses missing pipe selection',async()=>{
    const {root,run}=await fixture();
    await writeFile(join(root,'schedule.ts'),`export default [{id:'first',argv:['report:select','private-first'],expression:'0 0 31 2 *'},{id:'second',argv:['report:select','private-second'],expression:'0 0 31 2 *'}];`);
    await mkdir(join(root,'src','commands'));
    await writeFile(join(root,'src','commands','Select.ts'),`export default {name:'report:select',description:'Selected task',arguments:[{name:'value'}],async handle(i:any,c:any){await Bun.write(c.root+'/selected-task',i.args.value);}};`);
    expect((await run('schedule:test','--task','second')).code).toBe(0);
    expect(await readFile(join(root,'selected-task'),'utf8')).toBe('private-second');
    await rm(join(root,'selected-task'));
    const refused=await run('schedule:test');
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('interactive terminal');
    expect(refused.stdout+refused.stderr).not.toMatch(/private-first|private-second/);
    expect(await Bun.file(join(root,'selected-task')).exists()).toBe(false);
    expect((await run('schedule:test','--task','missing')).code).toBe(1);
  });

  test('actual schedule:test uses a real terminal to select only a task id',async()=>{
    const {root,env}=await fixture();
    await writeFile(join(root,'schedule.ts'),`export default [{id:'first',argv:['report:select','private-first'],expression:'0 0 31 2 *'},{id:'second',argv:['report:select','private-second'],expression:'0 0 31 2 *'}];`);
    await mkdir(join(root,'src','commands'));
    await writeFile(join(root,'src','commands','Select.ts'),`export default {name:'report:select',description:'Selected task',arguments:[{name:'value'}],async handle(i:any,c:any){await Bun.write(c.root+'/selected-task',i.args.value);}};`);
    const script=`
import os,pty,select,subprocess,sys,time
master,slave=pty.openpty()
p=subprocess.Popen([sys.argv[2],'run','index.ts','schedule:test'],cwd=sys.argv[1],stdin=slave,stdout=slave,stderr=slave)
out=b''
try:
    deadline=time.monotonic()+5
    while b'Select a scheduled task' not in out and p.poll() is None and time.monotonic()<deadline:
        if select.select([master],[],[],.1)[0]: out+=os.read(master,4096)
    assert b'Select a scheduled task' in out,out
    assert b'private-first' not in out and b'private-second' not in out,out
    os.write(master,b'2\\n')
    while p.poll() is None and time.monotonic()<deadline:
        if select.select([master],[],[],.1)[0]: out+=os.read(master,4096)
    assert p.poll()==0,out
finally:
    if p.poll() is None:p.kill();p.wait()
    os.close(master);os.close(slave)
`;
    const child=Bun.spawn(['python3','-I','-c',script,root,process.execPath],{env,stdout:'pipe',stderr:'pipe'});
    const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect({stdout,stderr,code}).toEqual({stdout:'',stderr:'',code:0});
    expect(await readFile(join(root,'selected-task'),'utf8')).toBe('private-second');
  },10000);

  test.each([
    {command:'make:factory',name:'Native/FixtureFactory',extra:['--model','User'],path:'database/factories/Native/FixtureFactory.ts'},
    {command:'make:cast',name:'Native/TrimText',extra:[],path:'src/database/types/Native/TrimText.ts'},
    {command:'make:scope',name:'Native/NamedRows',extra:[],path:'src/database/scopes/Native/NamedRows.ts'},
    {command:'make:observer',name:'Native/CountCreates',extra:[],path:'src/database/observers/Native/CountCreates.ts'},
  ])('actual native database generator $command creates consumed code without connecting',async entry=>{
    const {root,run,env}=await fixture();
    expect((await run(entry.command,entry.name,...entry.extra)).code).toBe(0);
    expect(await Bun.file(join(root,entry.path)).exists()).toBe(true);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
    expect((await run('--force',entry.command,entry.name,...entry.extra)).code).toBe(1);
  });

  test('actual generated native ORM components execute real disposable SQLite persistence',async()=>{
    const {root,run}=await fixture();
    for(const args of [
      ['make:factory','Native/FixtureFactory','--model','User'],['make:cast','Native/TrimText'],
      ['make:scope','Native/NamedRows'],['make:observer','Native/CountCreates'],
    ])expect((await run(...args)).code).toBe(0);
    await writeFile(join(root,'consume-native.ts'),`
import {MikroORM,EntitySchema} from '@mikro-orm/core';
import {SqliteDriver} from '@mikro-orm/sqlite';
import UserSchema,{User} from './src/models/User.ts';
import PostSchema from './src/models/Post.ts';
import {FixtureFactory} from './database/factories/Native/FixtureFactory.ts';
import {TrimText} from './src/database/types/Native/TrimText.ts';
import {NamedRows} from './src/database/scopes/Native/NamedRows.ts';
import {CountCreates} from './src/database/observers/Native/CountCreates.ts';
class ValueRecord{id!:number;value!:string;}
const ValueSchema=new EntitySchema<ValueRecord>({class:ValueRecord,properties:{id:{type:'number',primary:true},value:{type:new TrimText()}}});
export async function consume(root:string){
 const orm=await MikroORM.init({driver:SqliteDriver,dbName:root+'/native-consumer.sqlite',entities:[UserSchema,PostSchema,ValueSchema],logger:()=>{}});
 try{
  await orm.schema.create();
  const em=orm.em.fork();const row=await new FixtureFactory(em).createOne({name:'Factory fixture',email:'factory@example.invalid'});
  const observer=new CountCreates();em.getEventManager().registerSubscriber(observer);
  const value=em.create(ValueRecord,{value:'  trimmed  '});await em.flush();
  const stored=await orm.em.fork().findOneOrFail(ValueRecord,{id:value.id});
  const matched=await NamedRows(orm.em.fork(),User,{email:'factory@example.invalid'});
  return {factoryPersisted:row.id>0,castValue:stored.value,scopeCount:matched.length,observerCreates:observer.createdCount};
 }finally{await orm.close(true);}
}`);
    await mkdir(join(root,'src','commands'));
    await writeFile(join(root,'src','commands','ConsumeNative.ts'),`import {consume} from '../../consume-native.ts';export default {name:'fixture:consume-native',description:'Actual native generated components',async handle(_i:any,c:any){c.output(JSON.stringify(await consume(c.root)));}};`);
    const result=await run('fixture:consume-native');
    expect(result).toMatchObject({code:0});
    expect(JSON.parse(result.stdout)).toEqual({factoryPersisted:true,castValue:'trimmed',scopeCount:1,observerCreates:1});
  });

  test("actual persisted scheduler pause and resume control due command execution", async () => {
    const {root,run}=await fixture();
    await writeFile(join(root,'schedule.ts'),`export default [{id:'paused',argv:['report:tick'],expression:'* * * * *'}];`);
    await mkdir(join(root,'src','commands'));
    await writeFile(join(root,'src','commands','Tick.ts'),`export default {name:'report:tick',description:'Controlled schedule',async handle(_i:any,c:any){await Bun.write(c.root+'/controlled-tick','ran');}};`);
    expect((await run('schedule:pause')).code).toBe(0);
    const paused=await run('schedule:run');
    expect(paused.code).toBe(0);
    expect(JSON.parse(paused.stdout).results).toEqual([{id:'paused',outcome:'skipped-paused'}]);
    expect(await Bun.file(join(root,'controlled-tick')).exists()).toBe(false);
    expect((await run('schedule:resume')).code).toBe(0);
    expect((await run('schedule:run')).code).toBe(0);
    expect(await readFile(join(root,'controlled-tick'),'utf8')).toBe('ran');
    expect((await lstat(join(root,'.bundle-schedule','control.json'))).mode & 0o777).toBe(0o600);
  });

  test("persisted scheduler interrupt waits for active settlement and new consumers baseline it",async()=>{
    const {root,run,env}=await fixture();
    const started=join(root,'controlled-started'),release=join(root,'controlled-release'),finished=join(root,'controlled-finished'),later=join(root,'controlled-later');
    await writeFile(join(root,'schedule.ts'),`export default [{id:'active',argv:['report:active'],expression:'* * * * *'},{id:'later',argv:['report:later'],expression:'* * * * *'}];`);
    await mkdir(join(root,'src','commands'));
    await writeFile(join(root,'src','commands','Controlled.ts'),`import {existsSync,writeFileSync} from 'node:fs';export const active={name:'report:active',description:'Active controlled',async handle(){writeFileSync(${JSON.stringify(started)},'started');while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(5);writeFileSync(${JSON.stringify(finished)},'finished');}};export const later={name:'report:later',description:'Later controlled',handle(){writeFileSync(${JSON.stringify(later)},'later');}};`);
    const child=Bun.spawn([process.execPath,'run','index.ts','schedule:work','--sleep','1'],{cwd:root,env,stdout:'pipe',stderr:'pipe'});
    const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text();
    try{
      const deadline=Date.now()+5000;
      while(!await Bun.file(started).exists()&&child.exitCode===null&&Date.now()<deadline)await Bun.sleep(10);
      expect(await Bun.file(started).exists()).toBe(true);
      expect((await run('schedule:interrupt')).code).toBe(0);
      expect(child.exitCode).toBeNull();
      expect(await Bun.file(finished).exists()).toBe(false);
      await writeFile(release,'release');
      expect(await Promise.race([child.exited,Bun.sleep(5000).then(()=> 'timeout')])).toBe(0);
      expect(await Bun.file(finished).exists()).toBe(true);
      expect(await Bun.file(later).exists()).toBe(false);
      expect(await stderr).toBe('');
      expect(await stdout).toContain('"interrupted":true');
      expect((await run('schedule:run')).code).toBe(0);
      expect(await Bun.file(later).exists()).toBe(true);
    }finally{if(child.exitCode===null){child.kill('SIGKILL');await child.exited;}}
  },12000);

  test("actual scheduler lists safely and executes exact due command argv", async () => {
    const {root,run,env}=await fixture();
    await writeFile(join(root,"schedule.ts"), `export default [{id:'daily',argv:['report:daily','private argv; no shell'],expression:'30 12 * * *'}];`);
    await mkdir(join(root,"src","commands"));
    await writeFile(join(root,"src","commands","Report.ts"), `import {writeFile} from 'node:fs/promises';import {join} from 'node:path';export default {name:'report:daily',description:'Scheduled consumer',arguments:[{name:'value'}],async handle(i:any,c:any){await writeFile(join(c.root,'schedule-marker'),i.args.value);c.output('private output');}};`);
    const list=await run('schedule:list','--json','--at','2026-11-07T12:30:00Z');
    expect(list.code).toBe(0);
    expect(list.stdout+list.stderr).not.toContain('private argv');
    expect(JSON.parse(list.stdout).tasks).toMatchObject([{id:'daily',due:true,timezone:'UTC'}]);
    expect(await Bun.file(join(root,'schedule-marker')).exists()).toBe(false);
    expect((await run('schedule:run','--at','2026-11-07T12:29:00Z')).code).toBe(0);
    expect(await Bun.file(join(root,'schedule-marker')).exists()).toBe(false);
    const result=await run('schedule:run','--at','2026-11-07T12:30:00Z');
    expect(result.code).toBe(0);
    expect(result.stdout+result.stderr).not.toMatch(/private argv|private output/);
    expect(await readFile(join(root,'schedule-marker'),'utf8')).toBe('private argv; no shell');
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test("actual finite scheduler work deduplicates one observed minute", async () => {
    const {root,run}=await fixture();
    await writeFile(join(root,'schedule.ts'), `export default [{id:'tick',argv:['report:tick'],expression:'* * * * *'}];`);
    await mkdir(join(root,'src','commands'));
    await writeFile(join(root,'src','commands','Tick.ts'), `import {appendFile} from 'node:fs/promises';import {join} from 'node:path';export default {name:'report:tick',description:'Tick',async handle(_i:any,c:any){await appendFile(join(c.root,'ticks'),'tick\\n');}};`);
    const result=await run('schedule:work','--sleep','1','--max-cycles','3');
    expect(result.code).toBe(0);
    expect((await readFile(join(root,'ticks'),'utf8')).trim().split('\n')).toHaveLength(1);
    expect(result.stdout).toContain('"cycles":3');
    expect((await run('schedule:run','--at','not-a-date')).code).toBe(1);
  });

  test("SIGTERM cooperatively stops active scheduled commands and releases overlap ownership", async () => {
    const {root,env}=await fixture();
    const started=join(root,'scheduled-started'), stopped=join(root,'scheduled-stopped');
    await writeFile(join(root,'schedule.ts'), `export default [{id:'active',argv:['report:active'],expression:'* * * * *'},{id:'later',argv:['report:later'],expression:'* * * * *'}];`);
    await mkdir(join(root,'src','commands'));
    await writeFile(join(root,'src','commands','Active.ts'), `import {writeFileSync} from 'node:fs';export const active={name:'report:active',description:'Cooperative',async handle(_i:any,c:any){await new Promise<void>(resolve=>{c.signal.addEventListener('abort',()=>{writeFileSync(${JSON.stringify(stopped)},'stopped');resolve();},{once:true});writeFileSync(${JSON.stringify(started)},'started');});}};export const later={name:'report:later',description:'Must skip',handle(){writeFileSync(${JSON.stringify(join(root,'scheduled-later'))},'bad');}};`);
    const child=Bun.spawn([process.execPath,'run','index.ts','schedule:work'],{cwd:root,env,stdout:'pipe',stderr:'pipe'});
    const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text();
    try {
      const deadline=Date.now()+5000;
      while(!await Bun.file(started).exists()&&child.exitCode===null&&Date.now()<deadline)await Bun.sleep(10);
      expect(await Bun.file(started).exists()).toBe(true);
      child.kill('SIGTERM');
      expect(await Promise.race([child.exited,Bun.sleep(5000).then(()=> 'timeout')])).toBe(143);
      expect(await Bun.file(stopped).exists()).toBe(true);
      expect(await Bun.file(join(root,'scheduled-later')).exists()).toBe(false);
      expect(await readdir(join(root,'.bundle-command-locks'))).toEqual([]);
      expect(await stderr).toBe('');
      expect(await stdout).toContain('cancelled');
    } finally {if(child.exitCode===null){child.kill('SIGKILL');await child.exited;}}
  },12000);

  test("actual generated mail and notification classes persist explicit local deliveries", async () => {
    const { root, run, env } = await fixture();
    expect((await run("make:mail", "Billing/InvoiceMail")).code).toBe(0);
    expect((await run("make:notification", "Billing/InvoiceNotice")).code).toBe(0);
    await expect(lstat(join(root, ".bundle-mail"))).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(root, "src", "commands"));
    await writeFile(join(root, "src", "commands", "Deliver.ts"), `
import {InvoiceMail} from "../mail/Billing/InvoiceMail.ts";
import {InvoiceNotice} from "../notifications/Billing/InvoiceNotice.ts";
import {sendMailable} from "../mail/mail.ts";
import {LocalOutboxMailTransport} from "../mail/outbox.ts";
import {notifyMail} from "../notifications/notification.ts";
export default {name:"fixture:deliver",description:"Explicit local persistence only",async handle(_i:any,c:any){
 const transport=new LocalOutboxMailTransport(c.root);
 const first=await sendMailable(transport,new InvoiceMail(),{signal:c.signal});
 const second=await notifyMail(transport,new InvoiceNotice(),"private-recipient@example.invalid",{signal:c.signal});
 c.output(JSON.stringify({first,second,metadata:await transport.list({limit:10})}));
}};`);
    const delivered = await run("fixture:deliver");
    expect(delivered).toMatchObject({code:0});
    const result = JSON.parse(delivered.stdout);
    expect(result.first.accepted).toBe(true);
    expect(result.second.accepted).toBe(true);
    expect(result.metadata).toHaveLength(2);
    expect(delivered.stdout + delivered.stderr).not.toContain("private-recipient");
    for (const receipt of [result.first, result.second]) {
      const path = join(root, ".bundle-mail", "outbox", receipt.id + ".json");
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      const record = JSON.parse(await readFile(path, "utf8"));
      expect(record).toMatchObject({ version: 1, id: receipt.id });
      expect(typeof record.message.text).toBe("string");
    }
    const notification = JSON.parse(await readFile(join(root, ".bundle-mail", "outbox", result.second.id + ".json"), "utf8"));
    expect(notification.message.to).toEqual(["private-recipient@example.invalid"]);
    expect((await lstat(join(root, ".bundle-mail", "outbox"))).mode & 0o777).toBe(0o700);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
    expect((await run("--force", "make:mail", "Billing/InvoiceMail")).code).toBe(1);
    expect((await run("--force", "make:notification", "Billing/InvoiceNotice")).code).toBe(1);
  });

  test("actual customized mail stubs are consumed losslessly without implicit dispatch", async () => {
    const { root, run } = await fixture();
    expect((await run("stub:publish")).code).toBe(0);
    const stub = join(root, "stubs", "mail.ts.stub");
    await writeFile(stub, `import type {Mailable as _Mailable,MailMessage as _MailMessage} from "{{runtimeImport}}";
export class {{name}} implements _Mailable {build():_MailMessage{return {to:["private@example.invalid"],subject:"Private λ subject",text:"private body\\nsecond line λ"};}}`);
    expect((await run("make:mail", "Billing/PrivateMail")).code).toBe(0);
    await expect(lstat(join(root, ".bundle-mail"))).rejects.toMatchObject({ code: "ENOENT" });
    await mkdir(join(root, "src", "commands"));
    await writeFile(join(root, "src", "commands", "Deliver.ts"), `
import {PrivateMail} from "../mail/Billing/PrivateMail.ts";
import {sendMailable} from "../mail/mail.ts";
import {LocalOutboxMailTransport} from "../mail/outbox.ts";
export default {name:"fixture:deliver",description:"Explicit customized local persistence",async handle(_i:any,c:any){c.output(JSON.stringify(await sendMailable(new LocalOutboxMailTransport(c.root),new PrivateMail())));}};`);
    const delivered = await run("fixture:deliver");
    expect(delivered.code).toBe(0);
    expect(delivered.stdout + delivered.stderr).not.toContain("private body");
    const receipt = JSON.parse(delivered.stdout);
    const record = JSON.parse(await readFile(join(root, ".bundle-mail", "outbox", receipt.id + ".json"), "utf8"));
    expect(record.message).toEqual({to:["private@example.invalid"],subject:"Private λ subject",text:"private body\nsecond line λ"});
  });

  test("actual invalid text-mail refuses without private content or outbox state", async () => {
    const { root, run, env } = await fixture();
    expect((await run("stub:publish")).code).toBe(0);
    await writeFile(join(root, "stubs", "mail.ts.stub"), `import type {Mailable,MailMessage} from "{{runtimeImport}}";
export class {{name}} implements Mailable {build():MailMessage{return {to:["private-recipient@example.invalid"],subject:"private-subject\\r\\nBcc: injected@example.invalid",text:"private-content"};}}`);
    expect((await run("make:mail", "InvalidMail")).code).toBe(0);
    await mkdir(join(root, "src", "commands"));
    await writeFile(join(root, "src", "commands", "Invalid.ts"), `
import {InvalidMail} from "../mail/InvalidMail.ts";
import {sendMailable} from "../mail/mail.ts";
import {LocalOutboxMailTransport} from "../mail/outbox.ts";
export default {name:"fixture:invalid-mail",description:"Reject invalid mail",async handle(_i:any,c:any){await sendMailable(new LocalOutboxMailTransport(c.root),new InvalidMail());}};`);
    const result = await run("fixture:invalid-mail");
    expect(result.code).toBe(1);
    expect(result.stdout + result.stderr).not.toMatch(/private-recipient|private-subject|private-content|injected@example/);
    await expect(lstat(join(root, ".bundle-mail"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test("actual generated policies deny by default before a live HTTP handler executes",async()=>{
    const {root,run,env}=await fixture(),marker=join(root,"policy-handler-ran");
    expect((await run("make:policy","Billing/InvoicePolicy")).code).toBe(0);
    await writeFile(join(root,"routes.ts"),`
import {createRouter} from "./src/http/router.ts";
import {policyMiddleware} from "./src/http/authorization.ts";
import {InvoicePolicy} from "./src/http/policies/Billing/InvoicePolicy.ts";
import {writeFileSync} from "node:fs";
const guard=policyMiddleware({policy:new InvoicePolicy(),ability:"invoice.read",principal:()=>null,resource:()=>({secret:"private-resource"})});
export default createRouter().add("GET","/invoice",()=>{writeFileSync(${JSON.stringify(marker)},"ran");return Response.json({leaked:true});},{middleware:[guard]});`);
    const server=await startApplicationServer({root,port:0});
    try{
      const response=await fetch(new URL("invoice",server.url));
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({error:"Forbidden"});
      expect(await Bun.file(marker).exists()).toBe(false);
    }finally{await server.stop();}
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test("actual customized policy stubs authorize explicit fixture identities and resources",async()=>{
    const {root,run}=await fixture(),marker=join(root,"allowed-policy-handler");
    expect((await run("stub:publish")).code).toBe(0);
    await writeFile(join(root,"stubs","policy.ts.stub"),`
import type {AuthorizationPolicy,PolicyContext} from "{{runtimeImport}}";
export class {{name}} implements AuthorizationPolicy {async can(context:PolicyContext):Promise<boolean>{await Promise.resolve();return context.ability==="invoice.read" && (context.principal as any)?.id===(context.resource as any)?.owner;}}`);
    expect((await run("make:policy","Billing/InvoicePolicy")).code).toBe(0);
    const generated=join(root,"src","http","policies","Billing","InvoicePolicy.ts");
    const original=await readFile(generated,"utf8");
    expect((await run("--force","make:policy","Billing/InvoicePolicy")).code).toBe(1);
    expect(await readFile(generated,"utf8")).toBe(original);
    await writeFile(join(root,"routes.ts"),`
import {createRouter} from "./src/http/router.ts";
import {policyMiddleware} from "./src/http/authorization.ts";
import {InvoicePolicy} from "./src/http/policies/Billing/InvoicePolicy.ts";
import {writeFileSync} from "node:fs";
// Explicit test identity injection only: this header resolver is NOT authentication.
const guard=policyMiddleware({policy:new InvoicePolicy(),ability:"invoice.read",principal:({request}:any)=>{const id=request.headers.get("x-fixture-principal");return id?{id}:null;},resource:({params}:any)=>({id:params.id,owner:"fixture-owner"})});
export default createRouter().add("GET","/invoices/:id",({params}:any)=>{writeFileSync(${JSON.stringify(marker)},"ran");return Response.json({id:params.id});},{middleware:[guard]});`);
    const server=await startApplicationServer({root,port:0});
    try{
      const url=new URL("invoices/42",server.url);
      expect((await fetch(url)).status).toBe(403);
      expect((await fetch(url,{headers:{"x-fixture-principal":"other"}})).status).toBe(403);
      expect(await Bun.file(marker).exists()).toBe(false);
      const allowed=await fetch(url,{headers:{"x-fixture-principal":"fixture-owner"}});
      expect(allowed.status).toBe(200);
      expect(await allowed.json()).toEqual({id:"42"});
      expect(await readFile(marker,"utf8")).toBe("ran");
    }finally{await server.stop();}
  });

  test.each([
    ["throws",'throw new Error("private-policy-error");'],
    ["returns truthy nonboolean",'return ("allow" as unknown as boolean);'],
  ] as const)("a live policy that %s fails closed without exposing context",async(_label,body)=>{
    const {root,run}=await fixture(),marker=join(root,"invalid-policy-handler");
    expect((await run("stub:publish")).code).toBe(0);
    await writeFile(join(root,"stubs","policy.ts.stub"),`import type {AuthorizationPolicy,PolicyContext} from "{{runtimeImport}}";export class {{name}} implements AuthorizationPolicy {can(_context:PolicyContext):boolean {${body}}}`);
    expect((await run("make:policy","FailClosedPolicy")).code).toBe(0);
    await writeFile(join(root,"routes.ts"),`
import {createRouter} from "./src/http/router.ts";
import {policyMiddleware} from "./src/http/authorization.ts";
import {FailClosedPolicy} from "./src/http/policies/FailClosedPolicy.ts";
import {writeFileSync} from "node:fs";
const guard=policyMiddleware({policy:new FailClosedPolicy(),ability:"read",principal:()=>({secret:"private-principal"}),resource:()=>({secret:"private-resource"})});
export default createRouter().add("GET","/private",()=>{writeFileSync(${JSON.stringify(marker)},"ran");return Response.json({leaked:true});},{middleware:[guard]});`);
    const server=await startApplicationServer({root,port:0});
    try{
      const response=await fetch(new URL("private",server.url));
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Internal Server Error");
      expect(await Bun.file(marker).exists()).toBe(false);
    }finally{await server.stop();}
  });

  test("actual event generators deliver through cached runtime registrations without namespace collisions",async()=>{
    const {root,run}=await fixture();
    expect((await run("stub:publish")).code).toBe(0);
    expect(await readdir(join(root,"stubs"))).toHaveLength(27);
    await writeFile(join(root,"stubs","listener.ts.stub"),'export class {{name}} {static received:unknown[]=[];handle(payload:unknown,signal:AbortSignal):void {if(!signal.aborted){{name}}.received.push(payload);}}');
    expect((await run("make:event","Billing/InvoiceCreated")).code).toBe(0);
    expect((await run("make:event","Shipping/InvoiceCreated")).code).toBe(0);
    expect((await run("make:listener","Billing/RecordInvoice")).code).toBe(0);
    await writeFile(join(root,"events.ts"),'import {defineEvents} from "./src/events/definitions.ts";import {InvoiceCreated} from "./src/events/Billing/InvoiceCreated.ts";export default defineEvents([{event:InvoiceCreated.eventName,listeners:[{module:"src/listeners/Billing/RecordInvoice.ts",export:"RecordInvoice",method:"handle"}]}]);');
    expect((await run("event:cache")).code).toBe(0);
    await mkdir(join(root,"src","commands"));
    await writeFile(join(root,"src","commands","GeneratedEvents.ts"),`
import {loadApplicationEvents} from "../events/cache.ts";
import {InvoiceCreated as Billing} from "../events/Billing/InvoiceCreated.ts";
import {InvoiceCreated as Shipping} from "../events/Shipping/InvoiceCreated.ts";
import {RecordInvoice} from "../listeners/Billing/RecordInvoice.ts";
export default {name:"fixture:generated-events",description:"Consume generated events/listeners",async handle(_input:any,context:any){const bus=await loadApplicationEvents(context.root);await Shipping.dispatch(bus,{wrong:true},context.signal);await Billing.dispatch(bus,{invoice:42},context.signal);context.output(JSON.stringify(RecordInvoice.received));}};`);
    const delivered=await run("fixture:generated-events");
    expect(delivered.code).toBe(0);
    expect(JSON.parse(delivered.stdout)).toEqual([{invoice:42}]);
    expect((await run("make:listener","AbortSignal")).code).toBe(1);
  });

  test("actual generated jobs consume customized stubs through persisted CLI execution",async()=>{
    const {root,env,run}=await fixture();
    expect((await run("stub:publish")).code).toBe(0);
    const delivered=join(root,"generated-job.jsonl");
    await writeFile(join(root,"stubs","job.ts.stub"),`import {appendFileSync} from "node:fs";export class {{name}} {handle(payload:unknown,signal:AbortSignal):void {if(signal.aborted)throw new Error("cancelled");appendFileSync(${JSON.stringify(delivered)},JSON.stringify({job:"{{name}}",payload})+"\\n");}}`);
    expect((await run("make:job","Billing/IssueInvoice")).code).toBe(0);
    const generated=join(root,"src","jobs","Billing","IssueInvoice.ts");
    const source=await readFile(generated,"utf8");
    expect(source).toContain("appendFileSync");
    expect((await run("--force","make:job","Billing/IssueInvoice")).code).toBe(1);
    expect(await readFile(generated,"utf8")).toBe(source);
    expect((await run("make:job","AbortSignal")).code).toBe(1);
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const path=join(root,".bundle-queue","queue.sqlite");
    const producer=new QueueStore(path);
    try {producer.enqueue("default",{module:"src/jobs/Billing/IssueInvoice.ts",export:"IssueInvoice",method:"handle",payload:{invoice:42}});}
    finally{producer.close();}
    const result=await run("queue:work","--once");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({outcome:"completed",settlement:"acknowledged"});
    expect(JSON.parse((await readFile(delivered,"utf8")).trim())).toEqual({job:"IssueInvoice",payload:{invoice:42}});
    const reopened=new QueueStore(path);
    try{expect(reopened.reserve(["default"])).toBeNull();}finally{reopened.close();}
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test("actual generated job middleware wraps a persisted job using its customized consumed stub", async () => {
    const {root,run,env}=await fixture();
    expect((await run("stub:publish")).code).toBe(0);
    const marker=join(root,"middleware-order.jsonl");
    await writeFile(join(root,"stubs","job-middleware.ts.stub"), `
import type {JobMiddleware} from "{{runtimeImport}}";
import {appendFileSync} from "node:fs";
export const {{name}}:JobMiddleware=async(context,next)=>{
  const id=(context.job as any).payload.id;
  appendFileSync(${JSON.stringify(marker)},JSON.stringify(["before",id])+"\\n");
  await next();
  appendFileSync(${JSON.stringify(marker)},JSON.stringify(["after",id])+"\\n");
};`);
    const generated=await run("make:job-middleware","Billing/Trace");
    expect(generated.code).toBe(0);
    const path=join(root,"src","queue","middleware","Billing","Trace.ts");
    expect(await readFile(path,"utf8")).toContain("appendFileSync");
    expect((await run("--force","make:job-middleware","Billing/Trace")).code).toBe(1);
    await writeFile(join(root,"job.ts"),`import {appendFileSync} from "node:fs";export function handle(payload:any){appendFileSync(${JSON.stringify(marker)},JSON.stringify(["job",payload.id])+"\\n");}`);
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const store=new QueueStore(join(root,".bundle-queue","queue.sqlite"));
    try {store.enqueue("default",{module:"job.ts",export:"handle",payload:{id:42},middleware:[{module:"src/queue/middleware/Billing/Trace.ts",export:"Trace"}]});} finally {store.close();}
    const worked=await run("queue:work","--once");
    expect(worked.code).toBe(0);
    expect(JSON.parse(worked.stdout)).toMatchObject({outcome:"completed",settlement:"acknowledged"});
    expect((await readFile(marker,"utf8")).trim().split("\n").map(line=>JSON.parse(line))).toEqual([["before",42],["job",42],["after",42]]);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test.each([
    ["throws",'throw new Error("private-middleware-error")',"failed",false],
    ["twice","await next();await next();","failed",true],
    ["skips","return;","completed",false],
    ["hangs","await new Promise(()=>{});","timed-out",false],
    ["recovers","await next.recover(()=>{});","completed",true],
  ] as const)("persisted job middleware %s has truthful settlement without unintended handler execution", async(_name,body,outcome,ran)=>{
    const {root,run}=await fixture(), marker=join(root,"middleware-target");
    await writeFile(join(root,"middleware.ts"),`export async function handle(_context:any,next:any){${body}}`);
    await writeFile(join(root,"job.ts"),`import {writeFileSync} from "node:fs";export function handle(){writeFileSync(${JSON.stringify(marker)},"ran");${_name === "recovers" ? 'throw new Error("private-target-error");' : ""}}`);
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const store=new QueueStore(join(root,".bundle-queue","queue.sqlite"));
    try{store.enqueue("default",{module:"job.ts",export:"handle",payload:null,middleware:[{module:"middleware.ts",export:"handle"}]},{maxAttempts:1});}finally{store.close();}
    const worked=await run("queue:work","--once","--timeout","500");
    expect(worked.code).toBe(0);
    expect(JSON.parse(worked.stdout)).toMatchObject({outcome,settlement:outcome==="completed"?"acknowledged":"failed"});
    expect(worked.stdout+worked.stderr).not.toContain("private-middleware-error");
    expect(worked.stdout+worked.stderr).not.toContain("private-target-error");
    expect(await Bun.file(marker).exists()).toBe(ran);
  });

  test("actual queued commands persist argv and discover their implementation only when consumed", async () => {
    const { root, run, env } = await fixture();
    await mkdir(join(root,"src","commands"));
    const argv = ["fixture:queued", "literal space", "$(touch not-a-shell)", "", "λ; echo no"];
    await writeFile(join(root,"src","commands","Dispatch.ts"), `
import { dispatchCommand } from "../queue/dispatch.ts";
export default {name:"fixture:dispatch",description:"Dispatch a future command",async handle(_input:any,context:any){
  context.output(String(await dispatchCommand({root:context.root,argv:${JSON.stringify(argv)},maxAttempts:2})));
}};`);
    const dispatched = await run("fixture:dispatch");
    expect(dispatched.code).toBe(0);
    const id = Number(dispatched.stdout.trim());
    expect(Number.isSafeInteger(id)).toBe(true);
    // The implementation does not exist at dispatch time. The next worker discovers it.
    const marker = join(root,"queued-command.json");
    await writeFile(join(root,"src","commands","Queued.ts"), `
import {writeFile} from "node:fs/promises";
export default {name:"fixture:queued",description:"Consume exact queued arguments",arguments:[{name:"values",variadic:true}],async handle(input:any,context:any){
  context.output("private-command-output");context.error("private-command-error");
  await writeFile(${JSON.stringify(marker)},JSON.stringify({values:input.args.values,root:context.root}));
}};`);
    const worked = await run("queue:work","--once");
    expect(worked.code).toBe(0);
    expect(worked.stderr).toBe("");
    expect(JSON.parse(worked.stdout)).toEqual({id,queue:"default",attempt:1,outcome:"completed",settlement:"acknowledged",commandExitCode:0});
    expect(JSON.parse(await readFile(marker,"utf8"))).toEqual({values:argv.slice(1),root});
    expect(await Bun.file(join(root,"not-a-shell")).exists()).toBe(false);
    const store = new QueueStore(join(root,".bundle-queue","queue.sqlite"));
    try { expect(store.reserve(["default"])).toBeNull(); } finally {store.close();}
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test("actual queued built-in commands operate on the selected project", async () => {
    const {root,run,env} = await fixture();
    await mkdir(join(root,"src","commands"));
    await writeFile(join(root,"src","commands","Dispatch.ts"), `
import {dispatchCommand} from "../queue/dispatch.ts";
export default {name:"fixture:dispatch",description:"Dispatch built-in generator",async handle(_i:any,c:any){await dispatchCommand({root:c.root,argv:["make:class","Queued/InvoiceRecord"],maxAttempts:1});}};`);
    expect((await run("fixture:dispatch")).code).toBe(0);
    const generated = join(root,"src","classes","Queued","InvoiceRecord.ts");
    expect(await Bun.file(generated).exists()).toBe(false);
    const worked=await run("queue:work","--once");
    expect(worked.code).toBe(0);
    expect(JSON.parse(worked.stdout)).toMatchObject({outcome:"completed",settlement:"acknowledged",commandExitCode:0});
    expect(await readFile(generated,"utf8")).toContain("export class InvoiceRecord");
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test("actual queued nonzero command statuses retry, fail and recover without exposing command diagnostics", async () => {
    const { root, run } = await fixture();
    await mkdir(join(root,"src","commands"));
    await writeFile(join(root,"src","commands","Dispatch.ts"), `
import {dispatchCommand} from "../queue/dispatch.ts";
export default {name:"fixture:dispatch",description:"Dispatch failing command",async handle(_i:any,c:any){c.output(String(await dispatchCommand({root:c.root,argv:["fixture:queued","private-argv-value"],maxAttempts:2})));}};`);
    const idResult = await run("fixture:dispatch");
    expect(idResult.code).toBe(0);
    const id = Number(idResult.stdout.trim());
    const target = join(root,"src","commands","Queued.ts");
    const content = (status:number) => `export default {name:"fixture:queued",description:"Return exact status",arguments:[{name:"value"}],handle(_i:any,c:any){c.output("private-command-output");c.error("private-command-error");return ${status};}};`;
    await writeFile(target,content(7));
    const worked = await run("queue:work","--stop-when-empty","--backoff","0");
    expect(worked.code).toBe(0);
    expect(worked.stderr).toBe("");
    expect(worked.stdout.trim().split("\n").map(line=>JSON.parse(line))).toEqual([
      {id,queue:"default",attempt:1,outcome:"failed",settlement:"released",commandExitCode:7},
      {id,queue:"default",attempt:2,outcome:"failed",settlement:"failed",commandExitCode:7},
    ]);
    const failed = await run("queue:failed");
    expect(JSON.parse(failed.stdout).failed.map((row:any)=>[row.id,row.attempts])).toEqual([[id,2]]);
    expect(failed.stdout+failed.stderr).not.toContain("private-argv-value");
    await writeFile(target,content(0));
    expect((await run("queue:retry",String(id))).code).toBe(0);
    const recovered = await run("queue:work","--once");
    expect(recovered.code).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({id,attempt:1,outcome:"completed",settlement:"acknowledged",commandExitCode:0});
  });

  test.each([130,143])("queued handler return %i is a failed attempt, not queue cancellation", async status => {
    const {root,run} = await fixture();
    await mkdir(join(root,"src","commands"));
    await writeFile(join(root,"src","commands","Dispatch.ts"), `
import {dispatchCommand} from "../queue/dispatch.ts";
export default {name:"fixture:dispatch",description:"Dispatch status",async handle(_i:any,c:any){await dispatchCommand({root:c.root,argv:["fixture:queued"],maxAttempts:1});}};`);
    await writeFile(join(root,"src","commands","Queued.ts"),`export default {name:"fixture:queued",description:"Not actual cancellation",handle(){return ${status};}};`);
    expect((await run("fixture:dispatch")).code).toBe(0);
    const worked = await run("queue:work","--once");
    expect(worked.code).toBe(0);
    expect(JSON.parse(worked.stdout)).toMatchObject({attempt:1,outcome:"failed",settlement:"failed",commandExitCode:status});
    expect(JSON.parse((await run("queue:failed")).stdout).failed).toHaveLength(1);
  });

  test("queued automatic prompts fail noninteractively without leaking prompt text", async () => {
    const {root,run} = await fixture();
    await mkdir(join(root,"src","commands"));
    await writeFile(join(root,"src","commands","Dispatch.ts"), `
import {dispatchCommand} from "../queue/dispatch.ts";
export default {name:"fixture:dispatch",description:"Dispatch prompt",async handle(_i:any,c:any){await dispatchCommand({root:c.root,argv:["fixture:queued"],maxAttempts:1});}};`);
    await writeFile(join(root,"src","commands","Queued.ts"),`export default {name:"fixture:queued",description:"No queued interactive terminal",arguments:[{name:"answer",prompt:"private queued prompt"}],handle(){throw new Error("must not invoke handler");}};`);
    expect((await run("fixture:dispatch")).code).toBe(0);
    const worked = await run("queue:work","--once");
    expect(worked.code).toBe(0);
    expect(JSON.parse(worked.stdout)).toMatchObject({outcome:"failed",settlement:"failed",commandExitCode:1});
    expect(worked.stdout+worked.stderr).not.toContain("private queued prompt");
  });

  test("actual queued command timeouts exhaust attempts without claiming a command exit status", async () => {
    const {root,run} = await fixture();
    await mkdir(join(root,"src","commands"));
    await writeFile(join(root,"src","commands","Dispatch.ts"), `
import {dispatchCommand} from "../queue/dispatch.ts";
export default {name:"fixture:dispatch",description:"Dispatch hanging command",async handle(_i:any,c:any){await dispatchCommand({root:c.root,argv:["fixture:queued"],maxAttempts:2});}};`);
    await writeFile(join(root,"src","commands","Queued.ts"),`export default {name:"fixture:queued",description:"Never finishes",async handle(){await new Promise(()=>{});}};`);
    expect((await run("fixture:dispatch")).code).toBe(0);
    const worked = await run("queue:work","--stop-when-empty","--timeout","300","--backoff","0");
    expect(worked.code).toBe(0);
    const attempts = worked.stdout.trim().split("\n").map(line=>JSON.parse(line));
    expect(attempts.map(({attempt,outcome,settlement})=>({attempt,outcome,settlement}))).toEqual([
      {attempt:1,outcome:"timed-out",settlement:"released"},
      {attempt:2,outcome:"timed-out",settlement:"failed"},
    ]);
    expect(attempts.every(row=>!Object.hasOwn(row,"commandExitCode"))).toBe(true);
    expect(JSON.parse((await run("queue:failed")).stdout).failed.map((row:any)=>row.attempts)).toEqual([2]);
  },10000);

  test("SIGTERM cooperatively cancels a queued command and refunds its last attempt", async () => {
    const {root,run,env} = await fixture();
    await mkdir(join(root,"src","commands"));
    await writeFile(join(root,"src","commands","Dispatch.ts"), `
import {dispatchCommand} from "../queue/dispatch.ts";
export default {name:"fixture:dispatch",description:"Dispatch cancellable command",async handle(_i:any,c:any){await dispatchCommand({root:c.root,argv:["fixture:queued"],maxAttempts:1});}};`);
    const started = join(root,"queued-command-started"), stopped = join(root,"queued-command-stopped");
    await writeFile(join(root,"src","commands","Queued.ts"), `
import {writeFileSync} from "node:fs";
export default {name:"fixture:queued",description:"Observe cooperative cancellation",async handle(_i:any,c:any){
  await new Promise<void>(resolve=>{c.signal.addEventListener("abort",()=>{writeFileSync(${JSON.stringify(stopped)},"stopped");resolve();},{once:true});writeFileSync(${JSON.stringify(started)},"started");});
}};`);
    expect((await run("fixture:dispatch")).code).toBe(0);
    const child = Bun.spawn([process.execPath,"run","index.ts","queue:work","--once"],{cwd:root,env,stdout:"pipe",stderr:"pipe"});
    const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
    try {
      const deadline = Date.now()+5000;
      while(!await Bun.file(started).exists() && child.exitCode===null && Date.now()<deadline) await Bun.sleep(10);
      expect(await Bun.file(started).exists()).toBe(true);
      child.kill("SIGTERM");
      expect(await Promise.race([child.exited,Bun.sleep(2000).then(()=>"timed out")])).toBe(143);
      expect(await stderr).toBe("");
      expect(JSON.parse(await stdout)).toMatchObject({attempt:1,outcome:"cancelled",settlement:"released"});
      expect(await Bun.file(stopped).exists()).toBe(true);
      const store = new QueueStore(join(root,".bundle-queue","queue.sqlite"));
      try {
        expect(store.listFailed()).toHaveLength(0);
        const recovered=store.reserve(["default"]);
        expect(recovered?.attempt).toBe(1);
        if(recovered) expect(store.ack(recovered.receipt)).toBe(true);
      } finally {store.close();}
    } finally {if(child.exitCode===null){child.kill("SIGKILL");await child.exited;}}
  },10000);

  test("actual queue worker claims, executes and acknowledges persisted jobs", async () => {
    const {root,env,run}=await fixture();
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const path=join(root,".bundle-queue","queue.sqlite");
    const queue=new QueueStore(path);
    queue.enqueue("default",{module:"job.ts",export:"handle",payload:{id:7}});
    queue.close();
    await writeFile(join(root,"job.ts"),'import {appendFileSync} from "node:fs";export function handle(payload){appendFileSync(new URL("./delivered.jsonl",import.meta.url),JSON.stringify(payload)+"\\n");}');
    const worked=await run("queue:work","--once");
    expect(worked.code).toBe(0);
    expect(worked.stderr).toBe("");
    expect(JSON.parse(worked.stdout.trim())).toMatchObject({outcome:"completed",settlement:"acknowledged"});
    expect(JSON.parse((await readFile(join(root,"delivered.jsonl"),"utf8")).trim())).toEqual({id:7});
    const reopened=new QueueStore(path);
    try {expect(reopened.reserve(["default"])).toBeNull();}finally{reopened.close();}
    expect((await run("queue:work","--stop-when-empty")).code).toBe(0);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test("actual queue listener consumes jobs in fresh owned processes with a finite cycle limit",async()=>{
    const {root,run,env}=await fixture();
    const marker=join(root,"listen-processes.jsonl");
    await writeFile(join(root,"job.ts"),`import {appendFileSync} from "node:fs";export function handle(payload:any){appendFileSync(${JSON.stringify(marker)},JSON.stringify({payload,pid:process.pid})+"\\n");}`);
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const path=join(root,".bundle-queue","queue.sqlite"), store=new QueueStore(path);
    try{for(const payload of ["first","second"])store.enqueue("default",{module:"job.ts",export:"handle",payload});}finally{store.close();}
    const worked=await run("queue:listen","--max-cycles","2","--sleep","1","--timeout","1000");
    expect(worked.code).toBe(0);
    expect(worked.stderr).toBe("");
    const records=(await readFile(marker,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    expect(records.map(row=>row.payload)).toEqual(["first","second"]);
    expect(new Set(records.map(row=>row.pid)).size).toBe(2);
    expect(worked.stdout.trim().split("\n").map(line=>JSON.parse(line).settlement)).toEqual(["acknowledged","acknowledged"]);
    const after=new QueueStore(path);
    try{expect(after.reserve(["default"])).toBeNull();}finally{after.close();}
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test("running queue listeners settle active work before a restart-generation exit",async()=>{
    const {root,run,env}=await fixture(), started=join(root,"listen-started"), release=join(root,"listen-release"), completed=join(root,"listen-completed");
    await writeFile(join(root,"job.ts"),`import {writeFileSync,existsSync,appendFileSync} from "node:fs";export async function handle(payload:any){writeFileSync(${JSON.stringify(started)},"started");while(!existsSync(${JSON.stringify(release)}))await Bun.sleep(5);appendFileSync(${JSON.stringify(completed)},payload+"\\n");}`);
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const path=join(root,".bundle-queue","queue.sqlite"), store=new QueueStore(path);
    let second:number;
    try{store.enqueue("default",{module:"job.ts",export:"handle",payload:"active"});second=store.enqueue("default",{module:"job.ts",export:"handle",payload:"untouched"});}finally{store.close();}
    const child=Bun.spawn([process.execPath,"run","index.ts","queue:listen","--max-cycles","2","--sleep","1"],{cwd:root,env,stdout:"pipe",stderr:"pipe"});
    const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text();
    try{
      const deadline=Date.now()+5000;
      while(!await Bun.file(started).exists()&&child.exitCode===null&&Date.now()<deadline)await Bun.sleep(10);
      expect(await Bun.file(started).exists()).toBe(true);
      expect((await run("queue:restart")).code).toBe(0);
      expect(child.exitCode).toBeNull();
      await writeFile(release,"release");
      expect(await Promise.race([child.exited,Bun.sleep(5000).then(()=>"timed out")])).toBe(0);
      expect(await stderr).toBe("");
      expect((await stdout).trim().split("\n").map(line=>JSON.parse(line).settlement)).toEqual(["acknowledged"]);
      expect(await readFile(completed,"utf8")).toBe("active\n");
      const remaining=new QueueStore(path);
      try{const reservation=remaining.reserve(["default"]);expect(reservation?.id).toBe(second!);expect(reservation?.attempt).toBe(1);if(reservation)remaining.ack(reservation.receipt);}finally{remaining.close();}
    }finally{if(child.exitCode===null){child.kill("SIGKILL");await child.exited;}}
  },12000);

  test("SIGTERM reaches the queue listener's owned child and refunds active work",async()=>{
    const {root,env}=await fixture(),started=join(root,"listen-signal-started"),stopped=join(root,"listen-signal-stopped");
    await writeFile(join(root,"job.ts"),`import {writeFileSync} from "node:fs";export async function handle(_p:any,signal:AbortSignal){await new Promise<void>(resolve=>{signal.addEventListener("abort",()=>{writeFileSync(${JSON.stringify(stopped)},"stopped");resolve();},{once:true});writeFileSync(${JSON.stringify(started)},"started");});}`);
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const path=join(root,".bundle-queue","queue.sqlite"),store=new QueueStore(path);
    try{store.enqueue("default",{module:"job.ts",export:"handle",payload:null},{maxAttempts:1});}finally{store.close();}
    const child=Bun.spawn([process.execPath,"run","index.ts","queue:listen","--sleep","1"],{cwd:root,env,stdout:"pipe",stderr:"pipe"});
    const stdout=new Response(child.stdout).text(),stderr=new Response(child.stderr).text();
    try{
      const deadline=Date.now()+5000;
      while(!await Bun.file(started).exists()&&child.exitCode===null&&Date.now()<deadline)await Bun.sleep(10);
      expect(await Bun.file(started).exists()).toBe(true);
      child.kill("SIGTERM");
      expect(await Promise.race([child.exited,Bun.sleep(5000).then(()=>"timed out")])).toBe(143);
      expect(await stderr).toBe("");
      expect(await stdout).toContain('"outcome":"cancelled"');
      expect(await Bun.file(stopped).exists()).toBe(true);
      const remaining=new QueueStore(path);
      try{const reservation=remaining.reserve(["default"]);expect(reservation?.attempt).toBe(1);expect(remaining.listFailed()).toHaveLength(0);if(reservation)remaining.ack(reservation.receipt);}finally{remaining.close();}
    }finally{if(child.exitCode===null){child.kill("SIGKILL");await child.exited;}}
  },12000);

  test("actual queue worker honors queue priority and its finite job limit",async()=>{
    const {root,run}=await fixture();
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const path=join(root,".bundle-queue","queue.sqlite");
    const producer=new QueueStore(path);
    producer.enqueue("low",{module:"job.ts",export:"handle",payload:"low-first"});
    producer.enqueue("high",{module:"job.ts",export:"handle",payload:"high-priority"});
    producer.enqueue("low",{module:"job.ts",export:"handle",payload:"remaining"});producer.close();
    await writeFile(join(root,"job.ts"),'import {appendFileSync} from "node:fs";export function handle(payload){appendFileSync(new URL("./order",import.meta.url),String(payload)+"\\n");}');
    const worked=await run("queue:work","--queue","high,low","--max-jobs","2");
    expect(worked.code).toBe(0);
    expect(await readFile(join(root,"order"),"utf8")).toBe("high-priority\nlow-first\n");
    expect(worked.stdout.trim().split("\n")).toHaveLength(2);
    const remaining=new QueueStore(path);
    try {const job=remaining.reserve(["low"]);expect(job?.job?.payload).toBe("remaining");if(job)remaining.ack(job.receipt);}finally{remaining.close();}
  });

  test("running queue workers observe pause and resume after finishing their active job",async()=>{
    const {root,env,run}=await fixture();
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const producer=new QueueStore(join(root,".bundle-queue","queue.sqlite"));
    try{
      producer.enqueue("high",{module:"job.ts",export:"handle",payload:"active"});
      producer.enqueue("high",{module:"job.ts",export:"handle",payload:"paused"});
      producer.enqueue("low",{module:"job.ts",export:"handle",payload:"low"});
    }finally{producer.close();}
    const started=join(root,"active-started"),release=join(root,"release-active"),low=join(root,"low-completed"),order=join(root,"controls-order");
    await writeFile(join(root,"job.ts"),`import {appendFileSync,existsSync,writeFileSync} from "node:fs";export async function handle(payload,signal){if(payload==="active"){writeFileSync(${JSON.stringify(started)},"yes");while(!existsSync(${JSON.stringify(release)})){if(signal.aborted)throw new Error("cancelled");await Bun.sleep(10);}}appendFileSync(${JSON.stringify(order)},payload+"\\n");if(payload==="low")writeFileSync(${JSON.stringify(low)},"yes");}`);
    const child=Bun.spawn([process.execPath,"run","index.ts","queue:work","--queue","high,low","--sleep","10","--max-jobs","3"],{cwd:root,env,stdout:"pipe",stderr:"pipe"});
    const output=new Response(child.stdout).text(),errors=new Response(child.stderr).text();
    try{
      let deadline=Date.now()+5000;
      while(!await Bun.file(started).exists()&&child.exitCode===null&&Date.now()<deadline)await Bun.sleep(10);
      expect(await Bun.file(started).exists()).toBe(true);
      expect((await run("queue:pause","high")).code).toBe(0);
      await writeFile(release,"yes");
      deadline=Date.now()+5000;
      while(!await Bun.file(low).exists()&&child.exitCode===null&&Date.now()<deadline)await Bun.sleep(10);
      expect(await Bun.file(low).exists()).toBe(true);
      expect(await readFile(order,"utf8")).toBe("active\nlow\n");
      expect(child.exitCode).toBeNull();
      expect((await run("queue:resume","high")).code).toBe(0);
      expect(await Promise.race([child.exited,Bun.sleep(3000).then(()=>"timed out")])).toBe(0);
      expect(await errors).toBe("");
      expect((await output).trim().split("\n").map(line=>JSON.parse(line).settlement)).toEqual(["acknowledged","acknowledged","acknowledged"]);
      expect(await readFile(order,"utf8")).toBe("active\nlow\npaused\n");
    }finally{if(child.exitCode===null){child.kill("SIGKILL");await child.exited;}}
  },12000);

  test("restart requests settle active work then exit without claiming the next job",async()=>{
    const {root,env,run}=await fixture();
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const path=join(root,".bundle-queue","queue.sqlite");
    const producer=new QueueStore(path);
    let nextId=0;
    try{
      producer.enqueue("default",{module:"job.ts",export:"handle",payload:"active"});
      nextId=producer.enqueue("default",{module:"job.ts",export:"handle",payload:"next"});
    }finally{producer.close();}
    const started=join(root,"restart-active"),release=join(root,"restart-release"),order=join(root,"restart-order");
    await writeFile(join(root,"job.ts"),`import {appendFileSync,existsSync,writeFileSync} from "node:fs";export async function handle(payload,signal){if(payload==="active"){writeFileSync(${JSON.stringify(started)},"yes");while(!existsSync(${JSON.stringify(release)})){if(signal.aborted)throw new Error("restart interrupted active work");await Bun.sleep(10);}}appendFileSync(${JSON.stringify(order)},payload+"\\n");}`);
    const child=Bun.spawn([process.execPath,"run","index.ts","queue:work","--max-jobs","2"],{cwd:root,env,stdout:"pipe",stderr:"pipe"});
    const output=new Response(child.stdout).text(),errors=new Response(child.stderr).text();
    try{
      const deadline=Date.now()+5000;
      while(!await Bun.file(started).exists()&&child.exitCode===null&&Date.now()<deadline)await Bun.sleep(10);
      expect(await Bun.file(started).exists()).toBe(true);
      expect((await run("queue:restart")).code).toBe(0);
      expect(child.exitCode).toBeNull();
      await writeFile(release,"yes");
      expect(await Promise.race([child.exited,Bun.sleep(3000).then(()=>"timed out")])).toBe(0);
      expect(await errors).toBe("");
      expect((await output).trim().split("\n").map(line=>JSON.parse(line).settlement)).toEqual(["acknowledged"]);
      expect(await readFile(order,"utf8")).toBe("active\n");
      const remaining=new QueueStore(path);
      try{
        const claim=remaining.reserve(["default"]);
        expect(claim?.id).toBe(nextId);
        expect(claim?.attempt).toBe(1);
        expect(remaining.settle(claim!.receipt,{outcome:"cancelled"})).toBe("released");
      }finally{remaining.close();}
      expect((await run("queue:work","--once")).code).toBe(0);
      expect(await readFile(order,"utf8")).toBe("active\nnext\n");
    }finally{if(child.exitCode===null){child.kill("SIGKILL");await child.exited;}}
  },10000);

  test("actual idle queue worker survives concurrent first publication and atomic control replacements",async()=>{
    const {root,env}=await fixture();
    await writeFile(join(root,"job.ts"),'export function handle(){}');
    const path=join(root,".bundle-queue","queue.sqlite");
    const child=Bun.spawn([process.execPath,"run","index.ts","queue:work","--sleep","1","--max-jobs","1"],{cwd:root,env,stdout:"pipe",stderr:"pipe"});
    const output=new Response(child.stdout).text(),errors=new Response(child.stderr).text();
    try{
      const deadline=Date.now()+5000;
      while(!await Bun.file(path).exists()&&child.exitCode===null&&Date.now()<deadline)await Bun.sleep(1);
      expect(await Bun.file(path).exists()).toBe(true);
      for(let index=0;index<200;index++){
        await pauseQueue(root,"default");
        await resumeQueue(root,"default");
      }
      const producer=new QueueStore(path);
      try{producer.enqueue("default",{module:"job.ts",export:"handle",payload:null});}finally{producer.close();}
      expect(await Promise.race([child.exited,Bun.sleep(3000).then(()=>"timed out")])).toBe(0);
      expect(await errors).toBe("");
      expect(JSON.parse(await output)).toMatchObject({attempt:1,outcome:"completed",settlement:"acknowledged"});
    }finally{if(child.exitCode===null){child.kill("SIGKILL");await child.exited;}}
  },15000);

  test("unsafe queue control state refuses work before a reservation is consumed",async()=>{
    const {root,run}=await fixture();
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const path=join(root,".bundle-queue","queue.sqlite");
    const producer=new QueueStore(path);
    try{producer.enqueue("default",{module:"job.ts",export:"handle",payload:null});}finally{producer.close();}
    await writeFile(join(root,"job.ts"),'export function handle(){}');
    await writeFile(join(root,".bundle-queue","control.json"),'{"unsafe":"private-control-content"}',{mode:0o600});
    const result=await run("queue:work","--once");
    expect(result.code).toBe(1);
    expect(result.stdout+result.stderr).not.toContain("private-control-content");
    const untouched=new QueueStore(path);
    try{expect(untouched.reserve(["default"])?.attempt).toBe(1);}finally{untouched.close();}
  });

  test("actual worker retry override persists a higher budget while honoring priority and timeout flags",async()=>{
    const {root,env,run}=await fixture();
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const path=join(root,".bundle-queue","queue.sqlite");
    const queue=new QueueStore(path);
    let highId=0;
    try{
      queue.enqueue("low",{module:"job.ts",export:"handle",payload:"low"},{maxAttempts:5});
      highId=queue.enqueue("high",{module:"job.ts",export:"handle",payload:"high"},{maxAttempts:1});
    }finally{queue.close();}
    const marker=join(root,"override-order");
    await writeFile(join(root,"job.ts"),`import {appendFileSync} from "node:fs";export function handle(payload){appendFileSync(${JSON.stringify(marker)},payload+"\\n");if(payload==="high")throw new Error("private-tries-handler-error");}`);
    const result=await run("queue:work","--queue","high,low","--tries","2","--max-jobs","2","--timeout","1000","--backoff","0");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const attempts=result.stdout.trim().split("\n").map(line=>JSON.parse(line));
    expect(attempts).toEqual([
      {id:highId,queue:"high",attempt:1,outcome:"failed",settlement:"released"},
      {id:highId,queue:"high",attempt:2,outcome:"failed",settlement:"failed"},
    ]);
    expect(result.stdout).not.toContain("private-tries-handler-error");
    expect(await readFile(marker,"utf8")).toBe("high\nhigh\n");
    expect((await run("queue:work","--queue","low","--once")).code).toBe(0);
    expect(await readFile(marker,"utf8")).toBe("high\nhigh\nlow\n");
    const failed=JSON.parse((await run("queue:failed","--queue","high")).stdout).failed;
    expect(failed.map((row:{id:number;attempts:number})=>[row.id,row.attempts])).toEqual([[highId,2]]);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test("actual timed-out attempts obey a lower worker retry override",async()=>{
    const {root,run}=await fixture();
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const queue=new QueueStore(join(root,".bundle-queue","queue.sqlite"));
    let id=0;
    try{id=queue.enqueue("default",{module:"job.ts",export:"handle",payload:null},{maxAttempts:10});}finally{queue.close();}
    await writeFile(join(root,"job.ts"),'export async function handle(){await new Promise(()=>{});}');
    const result=await run("queue:work","--tries","2","--timeout","250","--backoff","0","--stop-when-empty");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n").map(line=>JSON.parse(line))).toEqual([
      {id,queue:"default",attempt:1,outcome:"timed-out",settlement:"released"},
      {id,queue:"default",attempt:2,outcome:"timed-out",settlement:"failed"},
    ]);
    expect(JSON.parse((await run("queue:failed")).stdout).failed.map((row:{id:number;attempts:number})=>[row.id,row.attempts])).toEqual([[id,2]]);
  });

  test("actual cancellation refunds an explicitly chosen last attempt without losing its policy",async()=>{
    const {root,env}=await fixture();
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const path=join(root,".bundle-queue","queue.sqlite");
    const producer=new QueueStore(path);
    try{producer.enqueue("default",{module:"job.ts",export:"handle",payload:null},{maxAttempts:5});}finally{producer.close();}
    const marker=join(root,"override-started");
    await writeFile(join(root,"job.ts"),`import {writeFileSync} from "node:fs";export async function handle(){writeFileSync(${JSON.stringify(marker)},"yes");await new Promise(()=>{});}`);
    const child=Bun.spawn([process.execPath,"run","index.ts","queue:work","--tries","1","--once"],{cwd:root,env,stdout:"pipe",stderr:"pipe"});
    const output=new Response(child.stdout).text(),errors=new Response(child.stderr).text();
    try{
      const deadline=Date.now()+5000;
      while(!await Bun.file(marker).exists()&&child.exitCode===null&&Date.now()<deadline)await Bun.sleep(10);
      expect(await Bun.file(marker).exists()).toBe(true);
      child.kill("SIGTERM");
      expect(await Promise.race([child.exited,Bun.sleep(2000).then(()=>"timed out")])).toBe(143);
      expect(await errors).toBe("");
      expect(await output).toContain('"outcome":"cancelled"');
      const recovered=new QueueStore(path);
      try{
        expect(recovered.listFailed()).toHaveLength(0);
        const claim=recovered.reserve(["default"]);
        expect(claim?.attempt).toBe(1);
        expect(recovered.settle(claim!.receipt,{outcome:"failed"})).toBe("failed");
        expect(recovered.listFailed()).toHaveLength(1);
      }finally{recovered.close();}
    }finally{if(child.exitCode===null){child.kill("SIGKILL");await child.exited;}}
  },8000);

  test.each(["0","101","-1","1.5","Infinity"])("invalid worker --tries %s refuses before storage creation",async(value)=>{
    const {root,run}=await fixture();
    expect((await run("queue:work","--tries",value,"--once")).code).toBe(1);
    expect(await Bun.file(join(root,".bundle-queue","queue.sqlite")).exists()).toBe(false);
  });

  test("actual queue failure, retry and owned failed-job deletion are not no-ops",async()=>{
    const {root,run}=await fixture();
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const path=join(root,".bundle-queue","queue.sqlite");
    const queue=new QueueStore(path);
    const id=queue.enqueue("default",{module:"job.ts",export:"handle",payload:{secret:"private-queue-payload"}},{maxAttempts:1});
    queue.close();
    await writeFile(join(root,"job.ts"),'export function handle(){throw new Error("private-handler-exception");}');
    const worked=await run("queue:work","--once");
    expect(worked.code).toBe(0);
    expect(worked.stdout).toContain('"outcome":"failed"');
    expect(worked.stdout).toContain('"settlement":"failed"');
    expect(worked.stderr).not.toContain("private-handler-exception");
    const failed=await run("queue:failed");
    expect(failed.code).toBe(0);
    expect(JSON.parse(failed.stdout).failed[0].id).toBe(id);
    expect(failed.stdout).not.toContain("private-queue-payload");
    expect((await run("queue:forget",String(id))).code).toBe(1);
    expect(JSON.parse((await run("queue:failed")).stdout).failed).toHaveLength(1);
    expect((await run("queue:retry",String(id))).code).toBe(0);
    await writeFile(join(root,"job.ts"),'export function handle(){}');
    expect((await run("queue:work","--once")).code).toBe(0);
    expect(JSON.parse((await run("queue:failed")).stdout).failed).toHaveLength(0);
    const another=new QueueStore(path);
    const last=another.enqueue("default",{module:"job.ts",export:"missing",payload:null},{maxAttempts:1});another.close();
    expect((await run("queue:work","--once")).code).toBe(0);
    expect((await run("--force","queue:forget",String(last))).code).toBe(0);
    expect(JSON.parse((await run("queue:failed")).stdout).failed).toHaveLength(0);
  });

  test("actual queue monitoring emits scoped counts and a consumed threshold event",async()=>{
    const {root,env,run}=await fixture();
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const queue=new QueueStore(join(root,".bundle-queue","queue.sqlite"));
    try{
      queue.enqueue("selected",{module:"job.ts",export:"handle",payload:"private-monitor-payload"});
      queue.enqueue("selected",{module:"job.ts",export:"handle",payload:null});
      queue.enqueue("selected",{module:"job.ts",export:"handle",payload:null},{availableAt:Date.now()+60_000});
      queue.enqueue("other",{module:"job.ts",export:"handle",payload:null});
    }finally{queue.close();}
    const marker=join(root,"queue-busy.json");
    await writeFile(join(root,"monitor.ts"),`import {writeFileSync} from "node:fs";export function handle(payload:unknown,signal:AbortSignal){if(!signal.aborted)writeFileSync(${JSON.stringify(marker)},JSON.stringify(payload));}`);
    await writeFile(join(root,"events.ts"),'import {defineEvents} from "./src/events/definitions.ts";export default defineEvents([{event:"queue.busy",listeners:[{module:"monitor.ts",export:"handle"}]}]);');
    expect((await run("event:cache")).code).toBe(0);
    await writeFile(join(root,"events.ts"),'throw new Error("uncached monitor entrypoint");');
    const normal=await run("queue:monitor","--queue","selected","--max","3");
    expect(normal.code).toBe(0);
    expect(JSON.parse(normal.stdout)).toEqual({queue:"selected",ready:2,delayed:1,reserved:0,expired:0,failed:0,max:3,exceeded:false});
    expect(await Bun.file(marker).exists()).toBe(false);
    const busy=await run("queue:monitor","--queue","selected","--max","2");
    expect(busy.code).toBe(1);
    expect(JSON.parse(busy.stdout)).toEqual({queue:"selected",ready:2,delayed:1,reserved:0,expired:0,failed:0,max:2,exceeded:true});
    expect(busy.stdout).not.toContain("private-monitor-payload");
    expect(await Bun.file(marker).exists()).toBe(true);
    expect(await Bun.file(marker).json()).toEqual(JSON.parse(busy.stdout));
    await writeFile(join(root,"monitor.ts"),'export function handle(){throw new Error("private-monitor-listener-error");}');
    const rejected=await run("queue:monitor","--queue","selected","--max","0");
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).not.toContain("private-monitor-listener-error");
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test("actual queue clear preserves both live and expired receipts and unrelated queues",async()=>{
    const {root,env,run}=await fixture();
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const path=join(root,".bundle-queue","queue.sqlite");
    let now=Date.now();
    const queue=new QueueStore(path,()=>now);
    let activeReceipt="";let expiredId=0;let otherId=0;
    try{
      queue.enqueue("selected",{module:"job.ts",export:"handle",payload:"active"});
      activeReceipt=queue.reserve(["selected"],{leaseMs:60_000})!.receipt;
      queue.enqueue("selected",{module:"job.ts",export:"handle",payload:"ready"});
      queue.enqueue("selected",{module:"job.ts",export:"handle",payload:"delayed"},{availableAt:now+60_000});
      otherId=queue.enqueue("other",{module:"job.ts",export:"handle",payload:"other"});
      now-=100_000;
      expiredId=queue.enqueue("selected",{module:"job.ts",export:"handle",payload:"expired"});
      expect(queue.reserve(["selected"],{leaseMs:1})!.id).toBe(expiredId);
    }finally{queue.close();}
    expect((await run("queue:clear","selected")).code).toBe(1);
    expect((await run("--force","queue:clear","selected")).code).toBe(0);
    const reopened=new QueueStore(path);
    try{
      const recovered=reopened.reserve(["selected"]);
      expect(recovered?.id).toBe(expiredId);
      expect(recovered?.attempt).toBe(2);
      expect(reopened.ack(recovered!.receipt)).toBe(true);
      expect(reopened.ack(activeReceipt)).toBe(true);
      expect(reopened.reserve(["selected"])).toBeNull();
      const other=reopened.reserve(["other"]);
      expect(other?.id).toBe(otherId);
      expect(reopened.ack(other!.receipt)).toBe(true);
    }finally{reopened.close();}
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test("actual queue pruning uses a strict cutoff and explicit flush preserves runnable jobs",async()=>{
    const {root,run}=await fixture();
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const path=join(root,".bundle-queue","queue.sqlite");
    let now=1000;
    const queue=new QueueStore(path,()=>now);
    let atCutoff=0;let otherFailure=0;let pending=0;
    try{
      queue.enqueue("selected",{module:"job.ts",export:"handle",payload:null});
      expect(queue.fail(queue.reserve(["selected"])!.receipt,"older")).toBe(true);
      now=2000;
      atCutoff=queue.enqueue("selected",{module:"job.ts",export:"handle",payload:null});
      expect(queue.fail(queue.reserve(["selected"])!.receipt,"at cutoff")).toBe(true);
      otherFailure=queue.enqueue("other",{module:"job.ts",export:"handle",payload:null});
      expect(queue.fail(queue.reserve(["other"])!.receipt,"other queue")).toBe(true);
      pending=queue.enqueue("selected",{module:"job.ts",export:"handle",payload:"keep"});
    }finally{queue.close();}
    expect((await run("queue:prune-failed","--queue","selected","--before","2000")).code).toBe(1);
    expect((await run("--force","queue:prune-failed","--queue","selected","--before","2000")).code).toBe(0);
    const inspected=new QueueStore(path);
    try{expect(inspected.listFailed().map(row=>row.id)).toEqual([atCutoff,otherFailure]);}finally{inspected.close();}
    expect((await run("--force","queue:flush")).code).toBe(1);
    expect((await run("--force","queue:flush","--all")).code).toBe(0);
    const remaining=new QueueStore(path);
    try{
      expect(remaining.listFailed()).toHaveLength(0);
      const claim=remaining.reserve(["selected"]);
      expect(claim?.id).toBe(pending);
      expect(remaining.ack(claim!.receipt)).toBe(true);
    }finally{remaining.close();}
  });

  test.each([
    ["queue:clear","bad/name"],
    ["queue:flush","--queue","selected","--all"],
    ["queue:flush"],
    ["queue:prune-failed","--all","--before","-1"],
    ["queue:prune-failed","--all","--before","invalid"],
  ] as string[][])("invalid queue operation %j refuses without storage initialization",async(...args)=>{
    const {root,run}=await fixture();
    expect((await run("--force",...args)).code).toBe(1);
    expect(await Bun.file(join(root,".bundle-queue","queue.sqlite")).exists()).toBe(false);
  });

  test("actual failed-job pages continue across deletion without exposing private records",async()=>{
    const {root,env,run}=await fixture();
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const queue=new QueueStore(join(root,".bundle-queue","queue.sqlite"));
    const ids:number[]=[];
    try{
      for(let index=0;index<5;index++){
        ids.push(queue.enqueue("selected",{module:"job.ts",export:"handle",payload:{secret:"private-page-payload"}}));
        const claimed=queue.reserve(["selected"]);
        expect(claimed).not.toBeNull();
        expect(queue.fail(claimed!.receipt,"private-page-reason")).toBe(true);
      }
      queue.enqueue("other",{module:"job.ts",export:"handle",payload:null});
      const other=queue.reserve(["other"]);
      expect(queue.fail(other!.receipt,"other reason")).toBe(true);
    }finally{queue.close();}
    const first=await run("queue:failed","--queue","selected","--limit","2");
    expect(first.code).toBe(0);
    const page=JSON.parse(first.stdout);
    expect(page.failed.map((row:{id:number})=>row.id)).toEqual(ids.slice(0,2));
    expect(page.nextAfterId).toBe(ids[1]);
    expect(first.stdout).not.toContain("private-page-payload");
    expect(first.stdout).not.toContain("private-page-reason");
    expect((await run("--force","queue:forget",String(ids[1]))).code).toBe(0);
    const second=await run("queue:failed","--queue","selected","--limit","2","--after",String(page.nextAfterId));
    expect(second.code).toBe(0);
    const next=JSON.parse(second.stdout);
    expect(next.failed.map((row:{id:number})=>row.id)).toEqual(ids.slice(2,4));
    expect(next.nextAfterId).toBe(ids[3]);
    const last=JSON.parse((await run("queue:failed","--queue","selected","--limit","2","--after",String(next.nextAfterId))).stdout);
    expect(last.failed.map((row:{id:number})=>row.id)).toEqual(ids.slice(4));
    expect(last.nextAfterId).toBeNull();
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test.each([["--limit","0"],["--limit","1001"],["--after","-1"],["--queue","bad/name"]])("failed-job option %s=%s refuses before storage creation",async(option,value)=>{
    const {root,run}=await fixture();
    expect((await run("queue:failed",option!,value!)).code).toBe(1);
    expect(await Bun.file(join(root,".bundle-queue","queue.sqlite")).exists()).toBe(false);
  });

  test.each([["SIGTERM",143],["SIGINT",130]] as const)("%s cancels only the owned queue job and releases its receipt",async(signal,status)=>{
    const {root,env}=await fixture();
    await mkdir(join(root,".bundle-queue"),{mode:0o700});
    const path=join(root,".bundle-queue","queue.sqlite");
    const producer=new QueueStore(path);
    producer.enqueue("default",{module:"job.ts",export:"handle",payload:null},{maxAttempts:1});producer.close();
    const marker=join(root,"started");
    await writeFile(join(root,"job.ts"),`import {writeFileSync} from "node:fs";export async function handle(){writeFileSync(${JSON.stringify(marker)},"yes");await new Promise(()=>{});}`);
    const child=Bun.spawn([process.execPath,"run","index.ts","queue:work","--once"],{cwd:root,env,stdout:"pipe",stderr:"pipe"});
    const output=new Response(child.stdout).text(),errors=new Response(child.stderr).text();
    try{
      const deadline=Date.now()+5000;
      while(!await Bun.file(marker).exists()&&child.exitCode===null&&Date.now()<deadline)await Bun.sleep(10);
      expect(await Bun.file(marker).exists()).toBe(true);
      child.kill(signal);
      expect(await Promise.race([child.exited,Bun.sleep(2000).then(()=>"timed out")])).toBe(status);
      expect(await errors).toBe("");
      expect(await output).toContain('"outcome":"cancelled"');
      const recovered=new QueueStore(path);
      try {expect(recovered.listFailed()).toHaveLength(0);const next=recovered.reserve(["default"]);expect(next?.attempt).toBe(1);if(next)recovered.ack(next.receipt);}finally{recovered.close();}
    }finally{if(child.exitCode===null){child.kill("SIGKILL");await child.exited;}}
  },8000);

  test("actual event commands cache registrations consumed by next-process dispatch", async () => {
    const { root, env, run } = await fixture();
    await writeFile(join(root,"listener.ts"),`import {appendFileSync} from "node:fs"; export class Listener {handle(payload: {id:number}) {appendFileSync(${JSON.stringify(join(root,"delivered.jsonl"))},JSON.stringify(payload)+"\\n");}}`);
    await writeFile(join(root,"events.ts"),'import {defineEvents} from "./src/events/definitions.ts"; export default defineEvents([{event:"invoice.created",listeners:[{module:"listener.ts",export:"Listener",method:"handle"}]}]);');
    const listed = await run("event:list","--json");
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("invoice.created");
    expect(listed.stdout).toContain("listener.ts#Listener.handle");
    expect(await Bun.file(join(root,"delivered.jsonl")).exists()).toBe(false);
    expect((await run("event:cache")).code).toBe(0);
    await writeFile(join(root,"events.ts"),'throw new Error("uncached event source was evaluated");');
    expect((await run("event:list","--json")).code).toBe(0);
    await mkdir(join(root,"src","commands"));
    await writeFile(join(root,"src","commands","Dispatch.ts"),`
import {loadApplicationEvents} from "../events/cache.ts";
export default {name:"fixture:dispatch",description:"Dispatch persisted event registration",async handle(_input:any,context:any) {const bus=await loadApplicationEvents(context.root); await bus.dispatch("invoice.created",{id:7},context.signal);}};`);
    expect((await run("fixture:dispatch")).code).toBe(0);
    expect(JSON.parse((await readFile(join(root,"delivered.jsonl"),"utf8")).trim())).toEqual({id:7});
    const unrelated = join(root,"bootstrap","cache","fixture.lock");
    await writeFile(unrelated,"keep");
    expect((await run("event:clear")).code).toBe(0);
    expect(await readFile(unrelated,"utf8")).toBe("keep");
    expect((await run("fixture:dispatch")).code).toBe(1);
    expect((await run("event:clear")).code).toBe(0);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test("actual optimization builds consumed caches and clears only its declared targets", async () => {
    const { root, run } = await fixture();
    await mkdir(join(root,"config"));
    await writeFile(join(root,"config","app.ts"),'export default {label:"cached",secret:"do-not-echo-secret"};');
    await writeFile(join(root,"handler.ts"),'export function index() {return new Response("cached");}');
    await writeFile(join(root,"routes.ts"),'import {defineRoutes} from "./src/http/route-definitions.ts"; export default defineRoutes([{method:"GET",path:"/cached",handler:{module:"handler.ts",export:"index"}}]);');
    await writeFile(join(root,"events.ts"),'import {defineEvents} from "./src/events/definitions.ts"; export default defineEvents([{event:"optimized",listeners:[{module:"handler.ts",export:"index"}]}]);');
    const built = await run("optimize");
    expect(built.code).toBe(0);
    expect(built.stdout).not.toContain("do-not-echo-secret");
    expect(JSON.parse(built.stdout).operations.filter((operation:{status:string})=>operation.status==="completed").length).toBeGreaterThanOrEqual(2);
    await writeFile(join(root,"config","app.ts"),'export default {label:"source"};');
    await writeFile(join(root,"routes.ts"),'throw new Error("source-secret-failure");');
    await writeFile(join(root,"events.ts"),'throw new Error("event-source-secret-failure");');
    expect((await run("event:list","--json")).stdout).toContain("optimized");
    expect(JSON.parse((await run("config:show","app.label")).stdout)).toBe("cached");
    expect((await run("route:list","--json")).code).toBe(0);
    const collision = await run("optimize");
    expect(collision.code).toBe(1);
    expect(JSON.parse(collision.stdout).operations.filter((operation:{status:string})=>operation.status==="failed").length).toBeGreaterThanOrEqual(2);
    const partial = await run("--force","optimize");
    expect(partial.code).toBe(1);
    expect(partial.stderr).not.toContain("source-secret-failure");
    const operations = JSON.parse(partial.stdout).operations as {target:string;status:string}[];
    expect(operations.find(operation=>operation.target==="configuration")?.status).toBe("completed");
    expect(operations.find(operation=>operation.target==="routes")?.status).toBe("failed");
    expect(JSON.parse((await run("config:show","app.label")).stdout)).toBe("source");
    const unrelated = join(root,"bootstrap","cache","deployment.lock");
    await writeFile(unrelated,"preserve unrelated lock");
    expect((await run("optimize:clear")).code).toBe(0);
    expect(await readFile(unrelated,"utf8")).toBe("preserve unrelated lock");
    expect((await run("route:list")).code).toBe(1);
    expect((await run("event:list")).code).toBe(1);
    expect((await run("optimize:clear")).code).toBe(0);
  });

  test("actual down and up commands affect requests on the same running HTTP worker", async () => {
    const { root, env, run } = await fixture();
    await writeFile(join(root, "routes.ts"), `import {createRouter} from "./src/http/router.ts"; export default createRouter().add("GET","/health",()=>Response.json({healthy:true}));\n`);
    const server = await startApplicationServer({root,port:0});
    const url = new URL("health",server.url);
    try {
      expect((await fetch(url)).status).toBe(200);
      const down = await run("down","--retry","7","--refresh","4");
      expect(down.code).toBe(0);
      const blocked = await fetch(url);
      expect(blocked.status).toBe(503);
      expect(blocked.headers.get("retry-after")).toBe("7");
      expect(blocked.headers.get("refresh")).toBe("4");
      expect(blocked.headers.get("cache-control")).toContain("no-store");
      expect(await blocked.text()).not.toContain(root);
      const head = await fetch(url,{method:"HEAD"});
      expect(head.status).toBe(503);
      expect(await head.text()).toBe("");
      expect((await run("up")).code).toBe(0);
      expect(await(await fetch(url)).json()).toEqual({healthy:true});
      expect((await run("up")).code).toBe(0);
      const marker = join(root,"storage","framework","down.json");
      await writeFile(marker,'{"unrelated":"must-not-delete-or-leak"}');
      const unsafe = await fetch(url);
      expect(unsafe.status).toBe(503);
      expect(await unsafe.text()).not.toContain("must-not-delete-or-leak");
      expect((await run("up")).code).toBe(1);
      expect(await readFile(marker,"utf8")).toContain("must-not-delete-or-leak");
      expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
    } finally { await server.stop(); }
  });

  test("HTTP generators execute against consuming runtimes in the next real CLI test process", async () => {
    const { root, run } = await fixture();
    for (const [kind, name] of [["controller","InvoiceController"],["middleware","TraceMiddleware"],["request","InvoiceRequest"],["resource","InvoiceResource"],["rule","InvoiceRule"]]) {
      const generated = await run(`make:${kind}`, `Billing/${name}`);
      expect(generated.code).toBe(0);
      expect(generated.stderr).toBe("");
    }
    await mkdir(join(root,"tests"));
    await writeFile(join(root,"tests","generated-http.test.ts"), `
import {test,expect} from "bun:test";
import {createRouter} from "../src/http/router.ts";
import {validate} from "../src/http/validation.ts";
import {InvoiceController} from "../src/http/controllers/Billing/InvoiceController.ts";
import {TraceMiddleware} from "../src/http/middleware/Billing/TraceMiddleware.ts";
import {InvoiceRequest} from "../src/http/requests/Billing/InvoiceRequest.ts";
import {InvoiceResource} from "../src/http/resources/Billing/InvoiceResource.ts";
import {InvoiceRule} from "../src/http/rules/Billing/InvoiceRule.ts";
test("generated HTTP contracts", async () => {
  const router=createRouter().add("GET","/",context=>new InvoiceController().handle(context),{middleware:[TraceMiddleware]});
  expect(await(await router.fetch(new Request("http://localhost/"))).text()).toBe("OK");
  const validated=await InvoiceRequest(new Request("http://localhost/",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:"Ada"})}));
  expect(validated.ok).toBe(true);
  const entity={name:"Ada",password:"must-not-serialize"};
  expect(await InvoiceResource(entity).json()).toEqual({data:{name:"Ada"}});
  expect((await validate(InvoiceRule,"")).ok).toBe(false);
  expect((await validate(InvoiceRule,"valid")).ok).toBe(true);
});\n`);
    const tested = await run("test","./tests/generated-http.test.ts");
    expect(tested.code).toBe(0);
    expect(tested.stderr).toContain("1 pass");
  });

  test("the actual CLI lists and serves code-first routes and shuts down its listener on SIGTERM", async () => {
    const { root, env, run } = await fixture();
    await writeFile(join(root, "routes.ts"), `
import { createRouter } from "./src/http/router.ts";
const router = createRouter();
router.add("GET", "/health", () => Response.json({healthy:true}), {name:"health"});
export default router;\n`);
    const listed = await run("route:list", "--json", "--path", "health");
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout).routes[0]).toMatchObject({method:"GET",path:"/health",name:"health"});
    const child = Bun.spawn([process.execPath, "run", "index.ts", "serve", "--port", "0"], {cwd:root,env,stdout:"pipe",stderr:"pipe"});
    const reader = child.stdout.getReader();
    const errors = new Response(child.stderr).text();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = (async () => {
        let text = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Server exited before reporting readiness.");
          text += new TextDecoder().decode(chunk.value);
          if (text.includes("\n")) return (JSON.parse(text.trim()) as {listening:string}).listening;
        }
      })();
      const url = await Promise.race([ready, new Promise<never>((_,reject) => { timer=setTimeout(() => reject(new Error("Server readiness timed out.")),5000); })]);
      clearTimeout(timer);
      expect(await (await fetch(new URL("health",url))).json()).toEqual({healthy:true});
      child.kill("SIGTERM");
      expect(await child.exited).toBe(143);
      expect(await errors).toBe("");
      await expect(fetch(new URL("health",url))).rejects.toThrow();
      expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
      await reader.cancel();
    }
  },10000);

  test("the actual CLI prompts for declared missing arguments only on a terminal", async () => {
    const { root, env, run } = await fixture();
    await mkdir(join(root, "src", "commands"));
    await writeFile(join(root, "src", "commands", "Prompt.ts"), `
export default { name: "fixture:prompt", description: "Prompt fixture",
  arguments: [{ name: "value", prompt: "Fixture question" }],
  handle(input: any, context: any) { context.output("ANSWER:" + input.args.value); } };
export const incomplete = { name: "fixture:incomplete", description: "Missing unprompted argument",
  arguments: [{ name: "one", prompt: "One" }, { name: "two" }], handle() {} };
`);
    const missing = await run("fixture:incomplete");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("two");
    const help = await run("help", "fixture:incomplete");
    expect(help.stdout).toContain("<one> <two>");
    const refused = await run("fixture:prompt");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("interactive terminal");
    expect((await run("fixture:prompt", "supplied")).stdout.trim()).toBe("ANSWER:supplied");
    const script = `
import os, pty, select, subprocess, sys, termios, time
master, slave = pty.openpty()
before = termios.tcgetattr(slave)
p = subprocess.Popen([sys.argv[2], 'run', 'index.ts', 'fixture:prompt'], cwd=sys.argv[1], stdin=slave, stdout=slave, stderr=slave)
out = b''
try:
    deadline = time.monotonic() + 5
    while b'Fixture question' not in out and time.monotonic() < deadline:
        if select.select([master], [], [], .1)[0]: out += os.read(master, 4096)
    assert b'Fixture question' in out, out
    os.write(master, 'terminal-value\\n'.encode())
    while p.poll() is None and time.monotonic() < deadline:
        if select.select([master], [], [], .1)[0]: out += os.read(master, 4096)
    assert p.poll() == 0, out
    while select.select([master], [], [], 0)[0]:
        try: out += os.read(master, 4096)
        except OSError: break
    assert b'ANSWER:terminal-value' in out, out
    assert termios.tcgetattr(slave) == before
finally:
    if p.poll() is None: p.kill(); p.wait()
    os.close(master); os.close(slave)
`;
    const child = Bun.spawn(["python3", "-I", "-c", script, root, process.execPath], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ stdout, stderr, code }).toEqual({ stdout: "", stderr: "", code: 0 });
  }, 10000);

  test("custom commands consume plain rendering helpers through the actual entry point", async () => {
    const { root, run } = await fixture();
    await mkdir(join(root, "src", "commands"));
    await writeFile(join(root, "src", "commands", "Render.ts"), `
import { createConsoleOutput } from "../console/output.ts";
export default { name: "fixture:render", description: "Render a report",
  handle(_input: unknown, context: any) {
    const output = createConsoleOutput({ write: text => process.stdout.write(text), env: context.env });
    try {
      output.table([["Item", "Count"], ["invoice", 2]]);
      const progress = output.progress("Report", 2);
      progress.complete();
      output.spinner("Saving").stop();
    } finally { output.close(); }
  } };
`);
    const result = await run("fixture:render");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("invoice");
    expect(result.stdout).toContain("2/2");
    expect(result.stdout).toContain("Saving");
    expect(result.stdout).not.toContain("\u001b");
  });

  test("actual log command reads and follows persisted application records without database setup", async () => {
    const { root, env, run } = await fixture();
    const logger = new Logger({ root, env });
    await logger.log("info", "not selected");
    await logger.log("warning", "application log persisted", { password: "log-secret" });
    const result = await run("pail", "--json", "--level", "warning");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.entries.map((entry: { message: string }) => entry.message)).toEqual(["application log persisted"]);
    expect(result.stdout).not.toContain("log-secret");
    const followed = await run("pail", "--follow", "--timeout", "30", "--json");
    expect(followed.code).toBe(0);
    expect(followed.stdout).toContain("application log persisted");
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test("actual information commands inspect environment and local docs without database setup", async () => {
    const { root, run } = await fixture();
    const about = await run("about", "--only", "environment");
    expect(about.code).toBe(0);
    expect(JSON.parse(about.stdout).environment.name).toBe("test");
    await writeFile(join(root, "README.md"), "# Fixture documentation\n");
    const docs = await run("docs", "--json");
    expect(docs.code).toBe(0);
    expect(JSON.parse(docs.stdout)).toEqual({ page: "readme", path: join(root, "README.md"), opened: false });
  });

  test("discovers new public generators and operations without database configuration", async () => {
    const { run, env } = await fixture();
    const result = await run("list", "--format", "json");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const names = JSON.parse(result.stdout).commands.map((command: { name: string }) => command.name);
    for (const name of ["make:command", "make:class", "make:interface", "make:enum", "make:exception", "make:test", "config:show", "config:cache", "config:clear", "config:publish", "env", "key:generate", "env:encrypt", "env:decrypt"]) {
      expect(names).toContain(name);
    }
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test("generates a custom command that the next actual CLI process discovers and executes", async () => {
    const { root, run } = await fixture();
    const generated = await run("make:command", "ImportProducts");
    expect(generated.code).toBe(0);
    expect(generated.stderr).toBe("");
    const commands = await readdir(join(root, "src", "commands"));
    expect(commands).toContain("ImportProducts.ts");
    const module = await import(pathToFileURL(join(root, "src", "commands", "ImportProducts.ts")).href);
    expect(typeof module.default.name).toBe("string");
    const result = await run(module.default.name);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.length).toBeGreaterThan(0);
    const help = await run("help", module.default.name);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain(module.default.name);
    const duplicate = await run("make:command", "ImportProducts");
    expect(duplicate.code).toBe(1);
  });

  test("preserves custom handler exit status through the real process boundary", async () => {
    const { root, run } = await fixture();
    await mkdir(join(root, "src", "commands"));
    await writeFile(join(root, "src", "commands", "Fail.ts"), `export default {
  name: "fixture:fail", description: "A deliberate fixture failure",
  handle(_input: unknown, context: { output: (text: string) => void }) {
    context.output("fixture executed");
    return 7;
  },
};\n`);
    const result = await run("fixture:fail");
    expect(result.stdout.trim()).toBe("fixture executed");
    expect(result.code).toBe(7);
  });

  test("loads, redacts, caches, and clears config through separate CLI processes", async () => {
    const { root, run } = await fixture();
    expect((await run("config:publish")).code).toBe(0);
    await writeFile(join(root, "config", "app.ts"), `export default { name: "Fixture App", password: "do-not-print-this-password", nested: { token: "do-not-print-this-token" } };\n`);
    const shown = await run("config:show", "app");
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("Fixture App");
    expect(shown.stdout).not.toContain("do-not-print-this-password");
    expect(shown.stdout).not.toContain("do-not-print-this-token");
    expect((await run("config:cache")).code).toBe(0);
    await writeFile(join(root, "config", "app.ts"), `export default { name: "Changed Source" };\n`);
    expect((await run("config:show", "app")).stdout).toContain("Fixture App");
    expect((await run("config:clear")).code).toBe(0);
    expect((await run("config:show", "app")).stdout).toContain("Changed Source");
  });

  test("round-trips a fixture environment without printing its key or plaintext", async () => {
    const { root, run, env } = await fixture();
    const key = `base64:${Buffer.alloc(32, 23).toString("base64")}`;
    const original = "APP_NAME=Fixture\nPRIVATE_VALUE=never-print-fixture-plaintext\n";
    await writeFile(join(root, ".env"), original);
    expect((await run("env")).stdout).toContain("test");
    const encrypted = await run("env:encrypt", "--key", key);
    expect(encrypted.code).toBe(0);
    expect(encrypted.stdout + encrypted.stderr).not.toContain(key);
    expect(encrypted.stdout + encrypted.stderr).not.toContain("never-print-fixture-plaintext");
    expect(await readFile(join(root, ".env"), "utf8")).toBe(original);
    expect(await Bun.file(join(root, ".env.encrypted")).exists()).toBe(true);
    const refused = await run("env:decrypt", "--key", key);
    expect(refused.code).toBe(1);
    expect(await readFile(join(root, ".env"), "utf8")).toBe(original);
    const decrypted = await run("env:decrypt", "--key", key, "--force");
    expect(decrypted.code).toBe(0);
    expect(decrypted.stdout + decrypted.stderr).not.toContain(key);
    expect(decrypted.stdout + decrypted.stderr).not.toContain("never-print-fixture-plaintext");
    expect(await readFile(join(root, ".env"), "utf8")).toBe(original);
    expect(await Bun.file(env.DB_DATABASE).exists()).toBe(false);
  });

  test("the actual test command forwards filtered test results and failure status", async () => {
    const { root, run } = await fixture();
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "tests", "native.test.ts"), `import { test, expect } from "bun:test";
test("selected native test", () => { console.log("native subprocess executed"); expect(2 + 2).toBe(4); });
test("deliberate native failure", () => { throw new Error("native failure sentinel"); });\n`);
    const passing = await run("test", "./tests/native.test.ts", "--filter", "^selected");
    expect(passing.code).toBe(0);
    expect(passing.stdout).toContain("native subprocess executed");
    expect(passing.stderr).toContain("1 pass");
    const failing = await run("test", "./tests/native.test.ts", "--filter", "^deliberate");
    expect(failing.code).toBe(1);
    expect(failing.stderr).toContain("native failure sentinel");
  });

  test("test subprocess stdout is relayed without inserting chunk-boundary newlines", async () => {
    const { root, run } = await fixture();
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "tests", "raw.test.ts"), `import { test } from "bun:test";
test("raw output", async () => {
  await new Promise<void>(resolve => process.stdout.write("RAW:", () => resolve()));
  process.stdout.write("αβEND");
});\n`);
    const result = await run("test", "./tests/raw.test.ts");
    expect(result.code).toBe(0);
    // Bun may print its own version banner before the test's raw payload.
    expect(result.stdout.slice(result.stdout.indexOf("RAW:"))).toBe("RAW:αβEND");
  });

  test("termination reaches the running test child and preserves signal exit status", async () => {
    const { root, env } = await fixture();
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "tests", "signal.test.ts"), `import { test } from "bun:test";
test("wait for termination", async () => {
  console.log("CHILD_READY:" + process.pid);
  await new Promise(resolve => setTimeout(resolve, 30000));
});\n`);
    const child = Bun.spawn([process.execPath, "run", "index.ts", "test", "./tests/signal.test.ts"], {
      cwd: root, env, stdout: "pipe", stderr: "pipe",
    });
    const errors = new Response(child.stderr).text();
    const reader = child.stdout.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ready = (async () => {
        let output = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Test child exited before readiness.");
          output += new TextDecoder().decode(chunk.value);
          const match = /CHILD_READY:(\d+)/.exec(output);
          if (match) return Number(match[1]);
        }
      })();
      const testPid = await Promise.race([
        ready,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Timed out waiting for test readiness.")), 5000); }),
      ]);
      clearTimeout(timer);
      child.kill("SIGTERM");
      expect(await child.exited).toBe(143);
      expect(() => process.kill(testPid, 0)).toThrow();
      await errors;
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
      await reader.cancel();
    }
  }, 10000);
});
