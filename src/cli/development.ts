import { CommanderError, type Command } from 'commander';

export interface DevelopmentCommandContext {
  root: string;
  env: NodeJS.ProcessEnv;
  output?: (text: string) => void;
  error?: (text: string) => void;
  signal?: AbortSignal;
}

/** Commands and manifests are trusted application code, not sandboxed plugins. */
export function registerDevelopment(program: Command, context: DevelopmentCommandContext): void {
  const checkSignal = () => {
    if (context.signal?.aborted) throw new CommanderError(String(context.signal.reason).includes('SIGINT') ? 130 : 143, 'bundle.developmentCancelled', 'Development command cancelled.');
  };
  program.command('dev:list').description('List explicit trusted development commands without starting them')
    .action(async () => {
      checkSignal();
      try {
        const { loadDevelopment } = await import('../development/processes.ts');
        checkSignal();
        const definitions = await loadDevelopment(context.root, context.signal);
        checkSignal();
        (context.output ?? console.log)(JSON.stringify({ processes: definitions.map(({ name, argv }) => ({ name, argv })) }));
      } catch (error) {
        checkSignal();
        if (error instanceof CommanderError) throw error;
        throw new Error('Unable to list development processes. Check the explicit trusted dev.ts registry.');
      }
    });
  program.command('dev').description('Run explicit development commands as one foreground owned group')
    .action(async () => {
      checkSignal();
      if (context.env.BUNDLE_DEV_CHILD === '1') throw new Error('Nested development groups are not supported.');
      try {
        const { loadDevelopment, runDevelopment } = await import('../development/processes.ts');
        checkSignal();
        const definitions = await loadDevelopment(context.root, context.signal);
        checkSignal();
        const result = await runDevelopment({ root: context.root, definitions, env: context.env,
          ...(context.signal ? { signal: context.signal } : {}),
          ...(context.output ? { output: context.output } : {}),
          ...(context.error ? { error: context.error } : {}),
        });
        checkSignal();
        if (result.exitCode !== 0) throw new CommanderError(result.exitCode, 'bundle.developmentExit', `Development group exited with status ${result.exitCode}.`);
      } catch (error) {
        checkSignal();
        if (error instanceof CommanderError) throw error;
        throw new Error('Development group failed. Check trusted commands and their streamed diagnostics.');
      }
    });
}
