import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileCron } from './cron';

export interface ScheduleDefinition {
  readonly id: string;
  readonly argv: readonly string[];
  readonly expression: string;
  readonly timezone?: 'UTC';
  readonly overlap?: 'skip' | 'allow';
}

function dense(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) throw new Error('Invalid schedule array');
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !('value' in d)) throw new Error('Invalid schedule array');
  }
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid schedule definition');
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !['id', 'argv', 'expression', 'timezone', 'overlap'].includes(key) || !d.enumerable || !('value' in d) || d.value === undefined) throw new Error('Invalid schedule definition');
    result[key] = d.value;
  }
  return result;
}
function validText(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
export function defineSchedules(input: readonly ScheduleDefinition[]): readonly ScheduleDefinition[] {
  const ids = new Set<string>();
  const definitions = dense(input, 128).map(value => {
    const item = object(value);
    if (typeof item.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(item.id) || ids.has(item.id)) throw new Error('Invalid schedule id');
    ids.add(item.id);
    const argv = dense(item.argv, 128);
    if (!argv.length || argv.some(value => !validText(value) || value.length > 4096) || typeof argv[0] !== 'string' || argv[0].length > 128 || !/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/.test(argv[0])) throw new Error('Invalid schedule arguments');
    if (typeof item.expression !== 'string') throw new Error('Invalid schedule expression');
    compileCron(item.expression);
    if (item.timezone !== undefined && item.timezone !== 'UTC') throw new Error('Invalid schedule timezone');
    if (item.overlap !== undefined && item.overlap !== 'skip' && item.overlap !== 'allow') throw new Error('Invalid schedule overlap');
    const normalized = Object.freeze({ id: item.id, argv: Object.freeze([...argv] as string[]), expression: item.expression, timezone: 'UTC' as const, overlap: (item.overlap ?? 'skip') as 'skip' | 'allow' });
    if (Buffer.byteLength(JSON.stringify(normalized)) > 64 * 1024) throw new Error('Schedule definition too large');
    return normalized;
  });
  if (Buffer.byteLength(JSON.stringify(definitions)) > 1024 * 1024) throw new Error('Schedules too large');
  return Object.freeze(definitions);
}

/** Loads trusted executable code; imported dependencies are not sandboxed. */
export async function loadSchedules(root: string): Promise<readonly ScheduleDefinition[]> {
  try {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new Error();
    const canonical = await realpath(root);
    const file = join(canonical, 'schedule.ts');
    let stat;
    try { stat = await lstat(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defineSchedules([]);
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error();
    const module = await import(pathToFileURL(file).href);
    return defineSchedules(module.default);
  } catch {
    throw new Error('Unable to load schedules');
  }
}
