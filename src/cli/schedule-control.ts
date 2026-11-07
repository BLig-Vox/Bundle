import type { Command } from 'commander';
import { pauseSchedule, resumeSchedule, interruptSchedule } from '../schedule/control.ts';

export function registerScheduleControl(program: Command, context: {root:string; output:(text:string)=>void}): void {
  for (const [operation, execute] of [
    ['pause', pauseSchedule], ['resume', resumeSchedule], ['interrupt', interruptSchedule],
  ] as const) {
    program.command(`schedule:${operation}`).description(`Request scheduler ${operation}`).action(async () => {
      try {
        const {paused, generation} = await execute(context.root);
        context.output(JSON.stringify({operation, paused, generation}));
      } catch {
        throw new Error('Unable to update schedule control.');
      }
    });
  }
}
