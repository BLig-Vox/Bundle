import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { bundledMessages, languageRoot } from './messages.ts';

export async function publishLanguageResources(root: string): Promise<{created: string[]}> {
 try {
  const base = await languageRoot(root); const dir = join(base,'lang');
  try { await mkdir(dir, {mode: 0o700}); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error();
  const handle = await open(join(dir,'en.ts'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`export default ${JSON.stringify(bundledMessages, null, 2)};\n`); } finally { await handle.close(); }
  return {created:['lang/en.ts']};
 } catch { throw Error('Unable to publish language resources'); }
}
