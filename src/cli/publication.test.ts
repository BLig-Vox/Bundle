import { test, expect, afterEach } from 'bun:test';
import { Command } from 'commander';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerPublication } from './publication.ts';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{recursive:true,force:true}))); });

test('registers explicit vendor publication command', () => {
 const program = new Command(); registerPublication(program,{root:'/tmp',output:()=>{}});
 const command=program.commands.find(command => command.name()==='vendor:publish');
 expect(command).toBeDefined();
 expect(command!.options.map(option => option.long)).toEqual(['--package','--tag','--all']);
});

test('global force preserves existing files and reports generic failure', async () => {
 const root=await mkdtemp(join(tmpdir(),'bundle-publication-cli-')); roots.push(root);
 await mkdir(join(root,'vendor')); await mkdir(join(root,'resources'));
 await writeFile(join(root,'vendor/secret.json'),'private content');
 await writeFile(join(root,'resources/data.json'),'existing');
 await writeFile(join(root,'publish.ts'),`export default ${JSON.stringify({version:1,assets:[{package:'demo',tag:'data',source:'vendor/secret.json',destination:'resources/data.json'}]})}`);
 const program=new Command(); program.option('--force'); let output='';
 registerPublication(program,{root,output:text=>{output+=text;}});
 await expect(program.parseAsync(['--force','vendor:publish','--all'],{from:'user'})).rejects.toThrow('Vendor publication failed.');
 expect(output).toBe(''); expect(await readFile(join(root,'resources/data.json'),'utf8')).toBe('existing');
});
