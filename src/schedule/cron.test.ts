import { describe, expect, test } from 'bun:test';
import { compileCron, isCronDue } from './cron';

describe('UTC cron', () => {
  test('matches ranges, unions and steps in UTC ignoring seconds', () => {
    const cron = compileCron('*/15 1-5/2 1,15 * *');
    expect(isCronDue(cron, new Date('2026-11-15T03:30:59Z'))).toBe(true);
    expect(isCronDue(cron, new Date('2026-11-15T04:30:00Z'))).toBe(false);
    expect(isCronDue(cron, new Date('2026-11-16T03:30:00Z'))).toBe(false);
    expect(Object.isFrozen(cron)).toBe(true);
  });
  test('uses day OR only when both day fields are restricted, including wildcard steps', () => {
    expect(isCronDue(compileCron('0 0 1 * 1'), new Date('2026-11-02T00:00Z'))).toBe(true);
    expect(isCronDue(compileCron('0 0 * * 1'), new Date('2026-11-03T00:00Z'))).toBe(false);
    expect(isCronDue(compileCron('0 0 */2 * 1'), new Date('2026-11-02T00:00Z'))).toBe(true);
    expect(isCronDue(compileCron('0 0 1 * *'), new Date('2026-11-02T00:00Z'))).toBe(false);
  });
  test('rejects malformed or unsupported expressions and invalid dates', () => {
    for (const value of ['', '* * * *', '* * * * * *', '@daily', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 7', '1/2 * * * *', '*/0 * * * *', '3-1 * * * *', '1,,2 * * * *', '*, * * * *', '-1 * * * *', '1.0 * * * *', 'JAN * * * *', `${'9'.repeat(200)} * * * *`, '*/9999999999999999999999 * * * *']) expect(() => compileCron(value)).toThrow();
    expect(() => isCronDue(compileCron('* * * * *'), new Date(NaN))).toThrow();
  });
});
