import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { chmod, link, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalOutboxMailTransport } from './outbox';

test('outbox persists mail and exposes only metadata in list', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-mail-'));
  try {
    const outbox = new LocalOutboxMailTransport(root);
    const receipt = await outbox.send({ to: ['a@example.invalid'], subject: 's', text: 'private' });
    const entries = await outbox.list({ limit: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.recipientCount).toBe(1);
    expect(JSON.stringify(entries)).not.toContain('private');
    expect((await outbox.read(receipt.id)).message.text).toBe('private');
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('outbox uses private modes, accepts root aliases and concurrent unique writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-mail-'));
  const alias = `${root}-alias`;
  try {
    await symlink(root, alias);
    const box = new LocalOutboxMailTransport(alias);
    const receipts = await Promise.all(Array.from({ length: 20 }, (_, i) => box.send({ to: ['a@example.invalid'], subject: `s${i}`, text: 't' })));
    expect(new Set(receipts.map(item => item.id)).size).toBe(20);
    expect((await box.list({ limit: 100 })).length).toBe(20);
    expect((await lstat(join(root, '.bundle-mail'))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, '.bundle-mail', 'outbox'))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, '.bundle-mail', 'outbox', `${receipts[0]!.id}.json`))).mode & 0o777).toBe(0o600);
  } finally { await rm(alias, { force: true }); await rm(root, { recursive: true, force: true }); }
});

test('outbox refuses and preserves hardlinked or corrupt records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-mail-'));
  try {
    const box = new LocalOutboxMailTransport(root);
    const receipt = await box.send({ to: ['a@example.invalid'], subject: 's', text: 'secret' });
    const path = join(root, '.bundle-mail', 'outbox', `${receipt.id}.json`);
    const extra = join(root, 'extra');
    await link(path, extra);
    await expect(box.read(receipt.id)).rejects.toThrow('Outbox operation failed.');
    await expect(box.list()).rejects.toThrow('Outbox operation failed.');
    expect(await readFile(extra, 'utf8')).toContain('secret');
    await rm(extra);
    await writeFile(path, Buffer.from([0xff]));
    await chmod(path, 0o600);
    await expect(box.read(receipt.id)).rejects.toThrow('Outbox operation failed.');
    expect(await readFile(path)).toEqual(Buffer.from([0xff]));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('outbox refuses a symlinked private directory without touching its target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-mail-'));
  const target = await mkdtemp(join(tmpdir(), 'bundle-mail-target-'));
  try {
    await symlink(target, join(root, '.bundle-mail'));
    const box = new LocalOutboxMailTransport(root);
    await expect(box.send({ to: ['a@example.invalid'], subject: 's', text: '' })).rejects.toThrow('Outbox operation failed.');
    expect((await lstat(join(root, '.bundle-mail'))).isSymbolicLink()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});


test('refuses a substituted temporary inode during publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-mail-race-'));
  const originalLink = fs.link;
  let substituted = '';
  let destination = '';
  const interceptor = spyOn(fs, 'link').mockImplementation(async (source, target) => {
    substituted = String(source);
    destination = String(target);
    await fs.rename(substituted, `${substituted}.displaced`);
    await fs.writeFile(substituted, 'foreign data', { mode: 0o600 });
    await originalLink(source, target);
  });
  try {
    const box = new LocalOutboxMailTransport(root);
    await expect(box.send({ to: ['a@example.invalid'], subject: 's', text: 't' })).rejects.toThrow();
    expect(substituted).not.toBe('');
    expect(await fs.readFile(substituted, 'utf8')).toBe('foreign data');
    expect(await fs.readFile(destination, 'utf8')).toBe('foreign data');
  } finally { interceptor.mockRestore(); await rm(root, { recursive: true, force: true }); }
});


test('list refuses directories exceeding the examined entry bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-mail-bound-'));
  try {
    const box = new LocalOutboxMailTransport(root);
    await box.list();
    const dir = join(root, '.bundle-mail', 'outbox');
    await Promise.all(Array.from({ length: 1001 }, (_, i) => fs.writeFile(join(dir, `extra-${i}`), 'x')));
    await expect(box.list({ limit: 1 })).rejects.toThrow('Outbox operation failed.');
    expect((await fs.readdir(dir)).length).toBe(1001);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cancellation during publication removes only the owned final entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-mail-cancel-'));
  const controller = new AbortController();
  const originalLink = fs.link;
  const interceptor = spyOn(fs, 'link').mockImplementation(async (source, target) => {
    await originalLink(source, target);
    controller.abort();
  });
  try {
    const box = new LocalOutboxMailTransport(root);
    await expect(box.send({ to: ['a@example.invalid'], subject: 's', text: 't' }, { signal: controller.signal })).rejects.toThrow();
    expect(await fs.readdir(join(root, '.bundle-mail', 'outbox'))).toEqual([]);
  } finally { interceptor.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test('read refuses oversized and symlink records without touching them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-mail-record-'));
  try {
    const box = new LocalOutboxMailTransport(root);
    const receipt = await box.send({ to: ['a@example.invalid'], subject: 's', text: 't' });
    const path = join(root, '.bundle-mail', 'outbox', `${receipt.id}.json`);
    await writeFile(path, 'x'.repeat(131073));
    await expect(box.read(receipt.id)).rejects.toThrow('Outbox operation failed.');
    expect((await lstat(path)).size).toBe(131073);
    await rm(path);
    const target = join(root, 'foreign');
    await writeFile(target, 'foreign');
    await symlink(target, path);
    await expect(box.read(receipt.id)).rejects.toThrow('Outbox operation failed.');
    expect(await readFile(target, 'utf8')).toBe('foreign');
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('bounded list returns a record from more than 1000 accepted messages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-mail-many-'));
  try {
    const box = new LocalOutboxMailTransport(root);
    for (let i = 0; i < 1001; i += 50) await Promise.all(Array.from({ length: Math.min(50, 1001 - i) }, () => box.send({ to: ['a@example.invalid'], subject: 's', text: 't' })));
    expect(await box.list({ limit: 1 })).toHaveLength(1);
    let count = 0;
    for await (const _entry of box.iterate()) count++;
    expect(count).toBe(1001);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('listing skips an active publication and sees it after completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-mail-live-'));
  let resume!: () => void;
  let linked!: () => void;
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const ready = new Promise<void>(resolve => { linked = resolve; });
  const originalLink = fs.link;
  let interceptor: ReturnType<typeof spyOn> | undefined;
  try {
    const box = new LocalOutboxMailTransport(root);
    const first = await box.send({ to: ['a@example.invalid'], subject: 'first', text: 't' });
    interceptor = spyOn(fs, 'link').mockImplementation(async (source, target) => { await originalLink(source, target); linked(); await paused; });
    const sending = box.send({ to: ['a@example.invalid'], subject: 'second', text: 't' });
    await ready;
    try { expect((await box.list({ limit: 10 })).map(item => item.id)).toEqual([first.id]); }
    finally { resume(); }
    const second = await sending;
    expect(new Set((await box.list({ limit: 10 })).map(item => item.id))).toEqual(new Set([first.id, second.id]));
  } finally { resume?.(); interceptor?.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

test('rejects a record over 128 KiB before creating a temporary file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-mail-large-'));
  try {
    const box = new LocalOutboxMailTransport(root);
    await expect(box.send({ to: ['a@example.invalid'], subject: 's', text: '\\'.repeat(65500) })).rejects.toThrow();
    const directory = join(root, '.bundle-mail', 'outbox');
    expect(await fs.readdir(directory)).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('publication syncs newly created directory entries and outbox before acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-mail-sync-'));
  const originalOpen = fs.open;
  const synced: string[] = [];
  const interceptor = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    const sync = handle.sync.bind(handle);
    handle.sync = async () => { synced.push(String(args[0])); await sync(); };
    return handle;
  });
  try {
    await new LocalOutboxMailTransport(root).send({ to: ['a@example.invalid'], subject: 's', text: 't' });
    expect(synced).toContain(root);
    expect(synced).toContain(join(root, '.bundle-mail'));
    expect(synced).toContain(join(root, '.bundle-mail', 'outbox'));
  } finally { interceptor.mockRestore(); await rm(root, { recursive: true, force: true }); }
});


test('directory sync failure rejects delivery and removes the owned record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bundle-mail-nosync-'));
  const originalOpen = fs.open;
  const outbox = join(root, '.bundle-mail', 'outbox');
  const interceptor = spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === outbox) handle.sync = async () => { throw new Error('sync unavailable'); };
    return handle;
  });
  try {
    await expect(new LocalOutboxMailTransport(root).send({ to: ['a@example.invalid'], subject: 's', text: 't' })).rejects.toThrow('Outbox operation failed.');
    expect(await fs.readdir(outbox)).toEqual([]);
  } finally { interceptor.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
