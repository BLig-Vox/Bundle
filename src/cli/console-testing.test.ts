import { afterEach, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from '../database/config.ts';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  await mkdir(join(projectRoot, '.data'), { recursive: true }); const root = await mkdtemp(join(projectRoot, '.data', 'console-harness-consumer-')); roots.push(root);
  await cp(join(projectRoot, 'src'), join(root, 'src'), { recursive: true });
  await cp(join(projectRoot, 'package.json'), join(root, 'package.json'));
  return { root, env: { ...process.env, BUN_OPTIONS: '', APP_ENV: 'test', NODE_ENV: 'test', DB_CONNECTION: 'invalid', DB_DATABASE: join(root, 'must-not-exist.sqlite') } };
}
test('public harness consumes generated commands and generated native tests through the real runner', async () => {
  const { testCommand } = await import('../console/testing.ts'); const options = await fixture();
  (await testCommand(['make:command', 'HarnessGreet', '--command', 'fixture:greet'], options)).assertExitCode(0).assertNoError();
  const greet = await testCommand(['fixture:greet'], options); greet.assertExitCode(0).assertOutputIncludes('HarnessGreet executed.').assertNoError();
  (await testCommand(['make:test', 'HarnessSmoke', '--unit'], options)).assertExitCode(0).assertNoError();
  const native = await testCommand(['test', './tests/Unit/HarnessSmoke.test.ts'], options); native.assertExitCode(0).assertErrorIncludes('1 pass');
  expect(await Bun.file(options.env.DB_DATABASE).exists()).toBe(false);
  expect(await Bun.file(join(options.root, 'src/commands/HarnessGreet.ts')).exists()).toBe(true);
});
test('public harness exercises automatic required argument retries and exact error/status assertions', async () => {
  const { testCommand } = await import('../console/testing.ts'); const options = await fixture(); await mkdir(join(options.root, 'src', 'commands'));
  await writeFile(join(options.root, 'src', 'commands', 'Automatic.ts'), `export default {name:'fixture:auto',description:'Native automatic prompt',arguments:[{name:'name',prompt:'Your name'}],handle(input:any,context:any){context.output('Hello '+input.args.name);context.error('Expected diagnostic');return 6;}};`);
  const result = await testCommand(['fixture:auto'], { ...options, prompts: [{ method: 'text', message: 'Your name', lines: ['', 'Ada'] }] });
  result.assertExitCode(6).assertOutputIncludes('Hello Ada').assertErrorIncludes('Expected diagnostic').assertPromptIncludes('Your name').assertPromptIncludes('A value is required');
  expect(() => result.assertExitCode(0)).toThrow(); expect(() => result.assertNoError()).toThrow();
  expect(await Bun.file(options.env.DB_DATABASE).exists()).toBe(false);
});
test('public harness rejects a caught unexpected concurrent prompt after command settlement', async () => {
  const {testCommand}=await import('../console/testing.ts');const options=await fixture();await mkdir(join(options.root,'src','commands'));const marker=join(options.root,'settled');
  await writeFile(join(options.root,'src','commands','Concurrent.ts'),`export default {name:'fixture:concurrent',description:'Caught concurrent prompt',async handle(_input:any,context:any){const first=context.prompts.text({message:'First'});await context.prompts.text({message:'Unexpected'}).catch(()=>{});await first;await Bun.write(${JSON.stringify(marker)},'settled');return 0;}};`);
  await expect(testCommand(['fixture:concurrent'],{...options,prompts:[{method:'text',message:'First',lines:['answer']}]})).rejects.toThrow('Harness prompt steps did not match');
  expect(await Bun.file(marker).text()).toBe('settled');
});
test('public harness snapshots caller scripts argv and environment before asynchronous work', async () => {
  const { testCommand } = await import('../console/testing.ts'); const options = await fixture(); await mkdir(join(options.root, 'src', 'commands'));
  await writeFile(join(options.root, 'src', 'commands', 'Snapshot.ts'), `export default {name:'fixture:snapshot',description:'Snapshots',async handle(_input:any,context:any){const name=await context.prompts.text({message:'Name'});context.output(name+':'+context.env.HARNESS_VALUE);}};`);
  const lines=['Original'];const prompts=[{method:'text' as const,message:'Name',lines}];const argv=['fixture:snapshot'];const env={...options.env,HARNESS_VALUE:'Before'};
  const pending=testCommand(argv,{root:options.root,env,prompts});lines[0]='Changed';prompts[0]!.message='Changed';prompts.length=0;argv[0]='list';env.HARNESS_VALUE='After';
  const result=await pending;result.assertExitCode(0).assertOutputIncludes('Original:Before').assertNoError();
  expect(Object.isFrozen(result)).toBe(true);expect(()=>result.assertExitCode(Number.NaN)).toThrow(TypeError);expect(()=>result.assertOutputIncludes(123 as unknown as string)).toThrow(TypeError);
});
test('public harness cancellation aborts an active native async search without taking global signal ownership', async () => {
  const { testCommand } = await import('../console/testing.ts'); const options = await fixture(); await mkdir(join(options.root, 'src', 'commands'));
  const controller=new AbortController();const key='__harness_abort_'+crypto.randomUUID();const before=process.listenerCount('SIGTERM');
  (globalThis as any)[key]=()=>queueMicrotask(()=>controller.abort(Error('fixture cancellation')));
  try {
    await writeFile(join(options.root, 'src', 'commands', 'Cancel.ts'), `export default {name:'fixture:cancel',description:'Cancel native search',async handle(_input:any,context:any){await context.prompts.search({message:'Find',search(){globalThis[${JSON.stringify(key)}]();return new Promise(()=>{});}});}};`);
    const result=await testCommand(['fixture:cancel'],{...options,signal:controller.signal,prompts:[{method:'search',message:'Find',lines:['query','1']}]});
    result.assertExitCode(1).assertErrorIncludes('Prompt aborted');expect(controller.signal.aborted).toBe(true);expect(process.listenerCount('SIGTERM')).toBe(before);
  } finally {delete (globalThis as any)[key];}
});
test('public harness settles scoped services before providers on mismatch and output overflow', async () => {
  const { testCommand } = await import('../console/testing.ts');
  for(const overflow of [false,true]) {
    const options=await fixture();await mkdir(join(options.root,'src','commands'));const marker=join(options.root,'disposed');
    await writeFile(join(options.root,'providers.ts'),`export default [{module:'provider.ts',export:'Provider'}];`);
    await writeFile(join(options.root,'provider.ts'),`import {appendFile} from 'node:fs/promises';export class Provider{register({container}:any){container.register('owned','scoped',()=>({async dispose(){await appendFile(${JSON.stringify(marker)},'scope;');}}));}async dispose(){await appendFile(${JSON.stringify(marker)},'provider;');}}`);
    await writeFile(join(options.root,'src','commands','Owned.ts'),`export default {name:'fixture:owned',description:'Owned cleanup',async handle(_input:any,context:any){context.services.resolve('owned');${overflow?`context.output('x'.repeat(64));`:`await context.prompts.text({message:'Actual'});`}}};`);
    await expect(testCommand(['fixture:owned'],{...options,maxOutputBytes:overflow?8:1024,...(!overflow?{prompts:[{method:'text' as const,message:'Wrong',lines:['unused']}]}:{})})).rejects.toThrow(overflow?'Harness output limit exceeded':'Harness prompt steps did not match');
    expect(await readFile(marker,'utf8')).toBe('scope;provider;');
  }
});
test('public harness drives real text password confirmation and choice/search prompts without secret echo', async () => {
  const { testCommand } = await import('../console/testing.ts'); const options = await fixture(); await mkdir(join(options.root, 'src', 'commands'));
  await writeFile(join(options.root, 'src', 'commands', 'Dialogue.ts'), `export default {name:'fixture:dialogue',description:'Native prompt dialogue',async handle(_input:any,context:any){const p=context.prompts;const name=await p.text({message:'Name'});const secret=await p.password({message:'Secret'});const accepted=await p.confirm({message:'Continue'});const team=await p.select({message:'Team',options:[{label:'Red',value:'red'},{label:'Blue',value:'blue'}]});const roles=await p.multiselect({message:'Roles',options:[{label:'Read',value:'read'},{label:'Write',value:'write'}]});const country=await p.search({message:'Country',search:async(q:string)=>q==='un'?[{label:'United',value:'UK'}]:[]});context.output(JSON.stringify({name,passwordLength:secret.length,accepted,team,roles,country}));}};`);
  const result = await testCommand(['fixture:dialogue'], { ...options, prompts: [
    { method: 'text', message: 'Name', lines: ['Ada'] }, { method: 'password', message: 'Secret', lines: ['very-secret'] },
    { method: 'confirm', message: 'Continue', lines: ['yes'] }, { method: 'select', message: 'Team', lines: ['2'] },
    { method: 'multiselect', message: 'Roles', lines: ['1,2'] }, { method: 'search', message: 'Country', lines: ['un', '1'] },
  ] });
  result.assertExitCode(0).assertNoError().assertPromptIncludes('Secret').assertPromptIncludes('Country');
  expect(JSON.parse(result.output)).toEqual({ name: 'Ada', passwordLength: 11, accepted: true, team: 'blue', roles: ['read', 'write'], country: 'UK' });
  expect(result.output + result.error + result.promptOutput).not.toContain('very-secret');
  expect(await Bun.file(options.env.DB_DATABASE).exists()).toBe(false);
});
