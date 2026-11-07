import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalRoot, readPublicationManifest, record, validName } from './definitions.ts';

export interface PublicationSelection { readonly package?: string; readonly tag?: string; readonly all?: boolean }
function selection(input: PublicationSelection): PublicationSelection {
 const value=record(input,['package','tag','all']);
 if ('all' in value && value.all !== true) throw Error();
 if ('package' in value && !validName(value.package)) throw Error();
 if ('tag' in value && !validName(value.tag)) throw Error();
 if (value.all === true ? ('package' in value || 'tag' in value) : !('package' in value || 'tag' in value)) throw Error();
 return { ...(value.all === true ? {all:true} : {}), ...(typeof value.package === 'string' ? {package:value.package} : {}), ...(typeof value.tag === 'string' ? {tag:value.tag} : {}) };
}
async function inspectParents(base: string, relative: string, create: boolean, signal?: AbortSignal): Promise<void> {
 const segments=relative.split('/').slice(0,-1); let current=base; let missing=false;
 for (const segment of segments) {
  signal?.throwIfAborted(); current=join(current,segment);
  if (missing && !create) continue;
  try {
   if (create) { try { await mkdir(current,{mode:0o700}); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } signal?.throwIfAborted(); }
   const info=await lstat(current); signal?.throwIfAborted(); if (!info.isDirectory() || info.isSymbolicLink()) throw Error();
  } catch (e) { if (!create && (e as NodeJS.ErrnoException).code === 'ENOENT') missing=true; else throw e; }
 }
}
async function readSource(base: string, path: string, signal?: AbortSignal): Promise<Buffer> {
 await inspectParents(base,path,false,signal); signal?.throwIfAborted();
 const file=join(base,path); const before=await lstat(file); signal?.throwIfAborted();
 if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 65536) throw Error();
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  signal?.throwIfAborted(); const info=await handle.stat(); signal?.throwIfAborted();
  if (!info.isFile() || info.nlink !== 1 || info.size > 65536 || info.dev !== before.dev || info.ino !== before.ino) throw Error();
  const data=Buffer.alloc(info.size + 1); let length=0;
  while (length < data.length) { const read=await handle.read(data,length,data.length-length,length); signal?.throwIfAborted(); if (!read.bytesRead) break; length+=read.bytesRead; }
  const after=await handle.stat(); signal?.throwIfAborted();
  if (length !== info.size || after.size !== info.size || after.nlink !== 1 || after.dev !== info.dev || after.ino !== info.ino || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw Error();
  return data.subarray(0,length);
 } finally { await handle.close(); }
}
async function publishResources(options: {root: string; selection: PublicationSelection; signal?: AbortSignal}, scope: 'vendor' | 'configuration'): Promise<{created: string[]}> {
 try {
  const root=options.root; const selected=selection(options.selection); const signal=options.signal;
  signal?.throwIfAborted(); const base=await canonicalRoot(root); signal?.throwIfAborted();
  const manifest=await readPublicationManifest(base,signal); signal?.throwIfAborted();
  const assets=manifest.assets.filter(asset => (scope === 'vendor' || asset.destination.startsWith('config/')) && (selected.all || (!selected.package || selected.package === asset.package) && (!selected.tag || selected.tag === asset.tag)));
  if (!assets.length) throw Error();
  const destinations=new Set(assets.map(asset => asset.destination));
  if (assets.some(asset => destinations.has(asset.source) || assets.some(other => other.destination.startsWith(`${asset.destination}/`)))) throw Error();
  const contents: Buffer[]=[]; let total=0;
  for (const asset of assets) {
   const content=await readSource(base,asset.source,signal); signal?.throwIfAborted(); total+=content.length; if (total > 1048576) throw Error(); contents.push(content);
   await inspectParents(base,asset.destination,false,signal); signal?.throwIfAborted();
   try { await lstat(join(base,asset.destination)); throw Error(); }
   catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
   signal?.throwIfAborted();
  }
  const created: string[]=[];
  for (let i=0;i<assets.length;i++) {
   const asset=assets[i]!; await inspectParents(base,asset.destination,true,signal); signal?.throwIfAborted();
   const handle=await open(join(base,asset.destination),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try { signal?.throwIfAborted(); await handle.writeFile(contents[i]!); signal?.throwIfAborted(); } finally { await handle.close(); }
   signal?.throwIfAborted(); created.push(asset.destination);
  }
  return {created};
 } catch { throw Error(scope === 'vendor' ? 'Unable to publish vendor resources' : 'Unable to publish configuration resources'); }
}

export function publishVendorResources(options: {root: string; selection: PublicationSelection; signal?: AbortSignal}): Promise<{created: string[]}> {
 return publishResources(options, 'vendor');
}

export function publishConfigurationResources(options: {root: string; selection: PublicationSelection; signal?: AbortSignal}): Promise<{created: string[]}> {
 return publishResources(options, 'configuration');
}
