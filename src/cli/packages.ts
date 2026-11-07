import type { Command } from 'commander';
import { cachePackages, clearPackageCache } from '../packages/cache';

export function registerPackages(program: Command, context: { root: string; output: (text: string) => void; signal?: AbortSignal }): void {
  program.command('package:discover').description('Cache explicit package metadata; replacement requires --force')
    .action(async () => {
      try { context.output(JSON.stringify(await cachePackages(context.root, { overwrite: program.opts().force === true, signal: context.signal }))); }
      catch { throw new Error('Package discovery failed.'); }
    });
  program.command('package:clear').description('Remove the package metadata cache')
    .action(async () => {
      try { context.signal?.throwIfAborted(); context.output(JSON.stringify({ cleared: await clearPackageCache(context.root) })); }
      catch { throw new Error('Package cache clear failed.'); }
    });
}
