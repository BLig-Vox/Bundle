import { expect, test } from 'bun:test';
import { sendMail, sendMailable, validateMailMessage } from './mail';

test('mail snapshots validated messages for transport', async () => {
  const message = { to: ['a@example.invalid'], subject: 'hello', text: 'plain' };
  let seen: unknown;
  await sendMail({ async send(value) { seen = value; return { id: '1', accepted: true }; } }, message);
  message.to[0] = 'b@example.invalid';
  expect(seen).toEqual({ to: ['a@example.invalid'], subject: 'hello', text: 'plain' });
  expect(Object.isFrozen(seen)).toBe(true);
  expect(Object.isFrozen((seen as typeof message).to)).toBe(true);
});

test('mail rejects malformed input and cancellation after build', async () => {
  expect(() => validateMailMessage({ to: ['x\n@example.invalid'], subject: 's', text: '' })).toThrow();
  const controller = new AbortController();
  await expect(sendMailable({ async send() { throw new Error('called'); } }, { async build() { controller.abort(); return { to: ['a@example.invalid'], subject: 's', text: '' }; } }, { signal: controller.signal })).rejects.toThrow();
});


test('strict message validation rejects lossy and non-data input', () => {
  const good = { to: ['a@example.invalid'], subject: 's', text: 't' };
  const sparse = Array(1);
  const getter = { ...good, get subject() { throw new Error('getter ran'); } };
  const withSymbol = { ...good, [Symbol('x')]: 1 };
  for (const value of [getter, withSymbol, { ...good, to: sparse }, { ...good, to: ['bad..local@example.invalid'] }, { ...good, text: '\ud800' }, { ...good, text: '\0' }, { ...good, subject: 'x'.repeat(999) }, { ...good, text: 'x'.repeat(65537) }, { ...good, to: Array(33).fill('a@example.invalid') }, { ...good, extra: 1 }, new Date()]) {
    expect(() => validateMailMessage(value)).toThrow();
  }
  expect(validateMailMessage({ ...good, text: 'x'.repeat(65536) }).text.length).toBe(65536);
});

test('transport completion cancellation is observed', async () => {
  const controller = new AbortController();
  await expect(sendMail({ async send() { controller.abort(); return { id: 'x', accepted: true }; } }, { to: ['a@example.invalid'], subject: 's', text: '' }, { signal: controller.signal })).rejects.toThrow();
});
