import type { Command } from 'commander';
import { cacheEvents, clearEventCache, loadApplicationEvents } from '../events/cache';
import { generateRegisteredEventListeners } from './event-generation';

export function registerEvents(program: Command, context: { root: string; output: (text: string) => void }): void {
  program.command('event:generate').description('Generate missing registered class listeners')
    .action(async () => {
      try { context.output(JSON.stringify(await generateRegisteredEventListeners(context.root))); }
      catch { throw new Error('Cannot generate registered event listeners.'); }
    });
  program.command('event:list').description('List local event listener registrations')
    .option('--json', 'Print structured event metadata')
    .action(async (options: { json?: boolean }) => {
      const events = (await loadApplicationEvents(context.root)).describe();
      context.output(options.json ? JSON.stringify({ events }, null, 2) : events.length ? events.map(item => `${item.event} (${item.listeners} listeners): ${item.listenerNames.map(name => JSON.stringify(name)).join(', ')}`).join('\n') : 'No events.');
    });
  program.command('event:cache').description('Cache event registrations; replacement requires --force')
    .action(async () => context.output(JSON.stringify({ cached: await cacheEvents(context.root, { overwrite: program.opts().force === true }) })));
  program.command('event:clear').description('Remove the event registration cache')
    .action(async () => context.output(JSON.stringify({ cleared: await clearEventCache(context.root) })));
}
