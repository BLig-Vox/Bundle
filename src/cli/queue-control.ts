import type { Command } from 'commander';
import { pauseQueue, resumeQueue, requestQueueRestart } from '../queue/control.ts';

export function registerQueueControl(program: Command, context: {root: string; output: (text: string) => void}): void {
  program.command('queue:pause <queue>').description('Persist a local queue pause request').action(async (queue: string) => {
    context.output(JSON.stringify({queue, ...await pauseQueue(context.root,queue)}));
  });
  program.command('queue:resume <queue>').description('Remove a local queue pause request').action(async (queue: string) => {
    context.output(JSON.stringify({queue, ...await resumeQueue(context.root,queue)}));
  });
  program.command('queue:restart').description('Publish a local worker restart request').action(async () => {
    context.output(JSON.stringify(await requestQueueRestart(context.root)));
  });
}
