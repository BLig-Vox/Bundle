/** Dependency-free, minute-resolution UTC cron matcher. */
export interface CompiledCron {
  readonly fields: readonly (readonly number[])[];
  readonly dayUnrestricted: boolean;
  readonly weekdayUnrestricted: boolean;
}

export function compileCron(expression: string): CompiledCron {
  if (typeof expression !== 'string' || expression.length > 128 || !/^[\x09-\x0d\x20-\x7e]+$/.test(expression)) throw new Error('Invalid cron expression');
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Invalid cron expression');
  const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;
  const fields = parts.map((part, index) => {
    const [min, max] = bounds[index]!;
    const values = new Set<number>();
    for (const component of part.split(',')) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(component);
      if (!match) throw new Error('Invalid cron expression');
      const base = match[1]!;
      if (match[2] !== undefined && base !== '*' && !base.includes('-')) throw new Error('Invalid cron expression');
      const step = match[2] === undefined ? 1 : Number(match[2]);
      if (!Number.isSafeInteger(step) || step <= 0) throw new Error('Invalid cron expression');
      const range = base === '*' ? [min, max] : base.split('-').map(Number);
      const start = range[0]!; const end = range[1] ?? start;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < min || end > max || start > end) throw new Error('Invalid cron expression');
      for (let n = start; n <= end; n += step) values.add(n);
    }
    return Object.freeze([...values].sort((a, b) => a - b));
  });
  return Object.freeze({ fields: Object.freeze(fields), dayUnrestricted: parts[2] === '*', weekdayUnrestricted: parts[4] === '*' });
}

export function isCronDue(compiled: CompiledCron, at: Date): boolean {
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new Error('Invalid date');
  const f = compiled.fields;
  if (!f[0]!.includes(at.getUTCMinutes()) || !f[1]!.includes(at.getUTCHours()) || !f[3]!.includes(at.getUTCMonth() + 1)) return false;
  const day = f[2]!.includes(at.getUTCDate()); const weekday = f[4]!.includes(at.getUTCDay());
  return compiled.dayUnrestricted ? weekday : compiled.weekdayUnrestricted ? day : day || weekday;
}
