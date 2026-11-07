import type { Command } from 'commander';
import { publishLanguageResources } from '../localization/publication.ts';

export function registerLanguage(program: Command, context: {root: string; output: (text: string) => void}): void {
 program.command('lang:publish').description('Publish the bundled English language resource').action(async () => {
  const result = await publishLanguageResources(context.root);
  context.output(JSON.stringify(result));
 });
}
