import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateMailMessage, type MailMessage, type MailOptions, type MailReceipt, type MailTransport } from './mail';

export interface OutboxRecord { readonly version: 1; readonly id: string; readonly createdAt: string; readonly message: MailMessage }
export interface OutboxMetadata { readonly id: string; readonly createdAt: string; readonly recipientCount: number }
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maxRecord = 131072;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const owner = (uid: number) => typeof process.getuid !== 'function' || uid === process.getuid();

async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o700 || !owner(stat.uid)) throw new Error('unsafe directory');
}
async function syncDirectory(path: string): Promise<void> {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('unsafe directory');
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (!actual.isDirectory() || !sameFile(before, actual)) throw new Error('changed directory');
    await handle.sync();
  } finally { await handle.close(); }
}
function validFile(stat: Stats): boolean {
  return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600 && owner(stat.uid) && stat.size <= maxRecord;
}
function sameFile(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
async function unlinkOwned(path: string, own: Stats): Promise<void> {
  try { if (sameFile(await lstat(path), own)) await unlink(path); } catch (error) { if (!missing(error)) throw error; }
}
function record(value: unknown, id: string): OutboxRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== 'createdAt,id,message,version') throw new Error('invalid record');
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || input.id !== id || typeof input.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.createdAt) || Number.isNaN(Date.parse(input.createdAt)) || new Date(input.createdAt).toISOString() !== input.createdAt) throw new Error('invalid record');
  return Object.freeze({ version: 1, id, createdAt: input.createdAt, message: validateMailMessage(input.message) });
}
export class LocalOutboxMailTransport implements MailTransport {
  private readonly root: string;
  constructor(root: string) {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Invalid outbox root.');
    this.root = root;
  }
  // Node's path-based filesystem API cannot defend against hostile concurrent tree renames.
  private async directory(): Promise<string> {
    const root = await realpath(this.root);
    const base = join(root, '.bundle-mail');
    await privateDirectory(base);
    await syncDirectory(root);
    const directory = join(base, 'outbox');
    await privateDirectory(directory);
    await syncDirectory(base);
    return directory;
  }
  async send(message: MailMessage, options?: MailOptions): Promise<MailReceipt> {
    options?.signal?.throwIfAborted();
    const snapshot = validateMailMessage(message);
    try {
      const directory = await this.directory();
      options?.signal?.throwIfAborted();
      const id = randomUUID();
      const data = JSON.stringify({ version: 1, id, createdAt: new Date().toISOString(), message: snapshot });
      if (Buffer.byteLength(data) > maxRecord) throw new Error('oversized');
      const temp = join(directory, `.${id}.tmp`);
      const target = join(directory, `${id}.json`);
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const own = await handle.stat();
      let committed = false;
      let linked = false;
      let closed = false;
      try {
        if (!validFile(own)) throw new Error('unsafe temporary');
        await handle.writeFile(data, 'utf8');
        await handle.sync();
        options?.signal?.throwIfAborted();
        const before = await lstat(temp);
        if (!validFile(before) || !sameFile(before, own)) throw new Error('changed temporary');
        options?.signal?.throwIfAborted();
        await link(temp, target);
        linked = true;
        const final = await lstat(target);
        const temporary = await lstat(temp);
        if (!sameFile(final, own) || !sameFile(temporary, own) || !final.isFile() || final.nlink !== 2 || temporary.nlink !== 2 || (final.mode & 0o7777) !== 0o600 || !owner(final.uid)) throw new Error('changed publication');
        options?.signal?.throwIfAborted();
        await unlinkOwned(temp, own);
        await syncDirectory(directory);
        options?.signal?.throwIfAborted();
        await handle.close();
        closed = true;
        const published = await lstat(target);
        if (!validFile(published) || !sameFile(published, own)) throw new Error('changed publication');
        options?.signal?.throwIfAborted();
        committed = true;
      } finally {
        if (!closed) await handle.close();
        if (!committed) {
          if (linked) await unlinkOwned(target, own);
          await unlinkOwned(temp, own);
        }
      }
      return { id, accepted: true };
    } catch (error) {
      options?.signal?.throwIfAborted();
      throw new Error('Outbox operation failed.');
    }
  }
  private async readAt(directory: string, id: string): Promise<OutboxRecord> {
    const path = join(directory, `${id}.json`);
    const before = await lstat(path);
    if (!validFile(before)) throw new Error('unsafe file');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const actual = await handle.stat();
      if (!validFile(actual) || actual.dev !== before.dev || actual.ino !== before.ino) throw new Error('changed file');
      const buffer = Buffer.alloc(maxRecord + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      if (length > maxRecord || !validFile(after) || after.size !== length || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs || after.ctimeMs !== actual.ctimeMs) throw new Error('changed file');
      return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))), id);
    } finally { await handle.close(); }
  }
  async read(id: string): Promise<OutboxRecord> {
    try {
      if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('invalid id');
      return await this.readAt(await this.directory(), id);
    } catch { throw new Error('Outbox operation failed.'); }
  }
  private async *scan(maxExamined?: number): AsyncGenerator<OutboxMetadata> {
    try {
      const directory = await this.directory();
      const iterator = await opendir(directory);
      let examined = 0;
      for await (const entry of iterator) {
        if (++examined > (maxExamined ?? Number.MAX_SAFE_INTEGER)) throw new Error('outbox scan limit exceeded');
        if (!entry.name.endsWith('.json')) continue;
        const id = entry.name.slice(0, -5);
        if (!idPattern.test(id)) throw new Error('invalid filename');
        const current = await lstat(join(directory, entry.name));
        if (current.nlink === 2 && current.isFile() && (current.mode & 0o7777) === 0o600 && owner(current.uid)) {
          try {
            const temporary = await lstat(join(directory, `.${id}.tmp`));
            if (temporary.isFile() && !temporary.isSymbolicLink() && temporary.nlink === 2 && (temporary.mode & 0o7777) === 0o600 && owner(temporary.uid) && sameFile(current, temporary)) continue;
          } catch (error) { if (!missing(error)) throw error; }
        }
        const item = await this.readAt(directory, id);
        yield Object.freeze({ id, createdAt: item.createdAt, recipientCount: item.message.to.length });
      }
    } catch { throw new Error('Outbox operation failed.'); }
  }
  // Streams filesystem-order metadata without retaining prior entries; callers may stop early.
  // The iterator is not a snapshot and does not promise stable continuation across mutations.
  iterate(): AsyncGenerator<OutboxMetadata> { return this.scan(); }
  async list(options?: { limit?: number }): Promise<OutboxMetadata[]> {
    const limit = options?.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Outbox operation failed.');
    const entries: OutboxMetadata[] = [];
    for await (const item of this.scan(1000)) {
      entries.push(item);
      if (entries.length === limit) break;
    }
    return entries;
  }
}
