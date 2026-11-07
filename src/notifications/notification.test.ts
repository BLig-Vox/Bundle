import { expect, test } from 'bun:test';
import { notifyMail } from './notification';

test('notification explicitly adapts recipient to mail', async () => {
  let recipient = '';
  const receipt = await notifyMail({ async send(message) { recipient = message.to[0] ?? ''; return { id: 'n', accepted: true }; } }, { toMail(to) { return { to: [to], subject: 's', text: 't' }; } }, 'a@example.invalid');
  expect(recipient).toBe('a@example.invalid');
  expect(receipt.accepted).toBe(true);
});


test('notification does not send when cancelled during adaptation', async () => {
  const controller = new AbortController();
  let called = false;
  await expect(notifyMail({ async send() { called = true; return { id: 'x', accepted: true }; } }, { async toMail(to) { controller.abort(); return { to: [to], subject: 's', text: '' }; } }, 'a@example.invalid', { signal: controller.signal })).rejects.toThrow();
  expect(called).toBe(false);
});
