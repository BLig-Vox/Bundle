import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishLanguageResources } from './publication.ts';
import { loadMessages } from './messages.ts';

test('published English resource is private, consumable and never overwritten', async () => {
 const root = await mkdtemp(join(tmpdir(),'bundle-publish-'));
 try {
  expect(await publishLanguageResources(root)).toEqual({created:['lang/en.ts']});
  const path=join(root,'lang/en.ts');
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await loadMessages(root))['bundle.ready']).toBe('Bundle is ready.');
  const before=await readFile(path,'utf8');
  await expect(publishLanguageResources(root)).rejects.toThrow();
  expect(await readFile(path,'utf8')).toBe(before);
 } finally { await rm(root,{recursive:true,force:true}); }
});
test('publication refuses a symlinked language directory or dangling output', async () => {
 const root = await mkdtemp(join(tmpdir(),'bundle-publish-')); const outside=await mkdtemp(join(tmpdir(),'bundle-outside-'));
 try {
  await symlink(outside,join(root,'lang'));
  await expect(publishLanguageResources(root)).rejects.toThrow();
  await rm(join(root,'lang')); await mkdir(join(root,'lang'));
  await symlink(join(outside,'not-created'),join(root,'lang/en.ts'));
  await expect(publishLanguageResources(root)).rejects.toThrow();
  await expect(readFile(join(outside,'not-created'))).rejects.toThrow();
 } finally {await rm(root,{recursive:true,force:true}); await rm(outside,{recursive:true,force:true});}
});
