import { readEventDefinitions } from '../events/cache';
import { generateEventListenerScaffolds } from './scaffolding';

/** Generate from trusted source registrations, deliberately ignoring the event cache. */
export async function generateRegisteredEventListeners(root: string): Promise<{ created: string[]; existing: string[] }> {
  return generateEventListenerScaffolds(root, await readEventDefinitions(root));
}
