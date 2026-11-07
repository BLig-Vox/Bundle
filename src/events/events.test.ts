import { expect, test } from 'bun:test';
import { EventBus } from './bus';
import { defineEvents } from './definitions';

test('dispatch snapshots listeners, preserves payload and aggregates errors in order', async () => {
  const bus = new EventBus(); const seen: unknown[] = []; const payload = {};
  const first = new Error('first'); const second = new Error('second');
  let remove = () => {};
  bus.on('saved', async (value, signal) => { seen.push([value, signal]); remove(); throw first; });
  remove = bus.on('saved', () => { seen.push('second'); throw second; });
  const controller = new AbortController();
  try { await bus.dispatch('saved', payload, controller.signal); throw new Error('expected failure'); }
  catch (error) { expect(error).toBeInstanceOf(AggregateError); expect((error as AggregateError).errors).toEqual([first, second]); }
  expect(seen).toEqual([[payload, controller.signal], 'second']);
});

test('unsubscribe owns one registration even when the same callback is repeated', async () => {
  const bus = new EventBus(); const seen: string[] = [];
  const first = () => { seen.push('A'); };
  bus.on('saved', first);
  bus.on('saved', () => { seen.push('B'); });
  const removeLast = bus.on('saved', first);
  removeLast(); removeLast();
  await bus.dispatch('saved', null);
  expect(seen).toEqual(['A', 'B']);
});

test('cancellation awaits active listener and prevents the next', async () => {
  const bus = new EventBus(); const controller = new AbortController(); const seen: number[] = [];
  bus.on('x', async () => { controller.abort(); await Promise.resolve(); seen.push(1); });
  bus.on('x', () => { seen.push(2); });
  await bus.dispatch('x', null, controller.signal); expect(seen).toEqual([1]);
});

test('definitions are copied and frozen and reject the entrypoint', () => {
  const input = [{ event: 'x', listeners: [{ module: 'listeners.ts', export: 'run' }] }];
  const result = defineEvents(input); input[0]!.listeners[0]!.export = 'changed';
  expect(result[0]!.listeners[0]!.export).toBe('run'); expect(Object.isFrozen(result[0]!.listeners[0])).toBe(true);
  expect(() => defineEvents([{ event: 'x', listeners: [{ module: 'events.ts', export: 'run' }] }])).toThrow();
});
