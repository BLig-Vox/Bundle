import type { Command } from 'commander';
import { publishVendorResources } from '../publication/publish.ts';

export function registerPublication(program: Command, context: {root: string; output: (text: string) => void; signal?: AbortSignal}): void {
 program.command('vendor:publish').description('Publish explicitly selected local vendor resources')
  .option('--package <name>', 'Select a package')
  .option('--tag <tag>', 'Select a tag')
  .option('--all', 'Select all assets')
  .action(async (options: {package?: string; tag?: string; all?: boolean}) => {
   try {
    const selection = { ...(options.package !== undefined ? {package:options.package} : {}), ...(options.tag !== undefined ? {tag:options.tag} : {}), ...(options.all !== undefined ? {all:options.all} : {}) };
    const result = await publishVendorResources({root:context.root,selection,signal:context.signal});
    context.signal?.throwIfAborted();
    context.output(JSON.stringify(result));
   } catch { throw new Error('Vendor publication failed.'); }
  });
}
