import { test, expect } from 'bun:test';
import { Command } from 'commander';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerLanguage } from './language.ts';

test('lang:publish creates an exclusive English catalogue', async () => {
 const root=await mkdtemp(join(tmpdir(),'bundle-language-cli-'));
 try {
  const output:string[]=[]; const program=new Command();
  registerLanguage(program,{root,output:text=>output.push(text)});
  await program.parseAsync(['lang:publish'],{from:'user'});
  expect(JSON.parse(output[0]!)).toEqual({created:['lang/en.ts']});
  const original=await readFile(join(root,'lang/en.ts'),'utf8');
  await expect(program.parseAsync(['lang:publish'],{from:'user'})).rejects.toThrow();
  expect(await readFile(join(root,'lang/en.ts'),'utf8')).toBe(original);
 } finally {await rm(root,{recursive:true,force:true});}
});
