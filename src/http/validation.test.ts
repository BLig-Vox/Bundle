import { describe, expect, test } from 'bun:test';
import { rules, validate, validateRequest } from './validation';

describe('validation', () => {
  const schema = rules.object({ name: rules.string({ min: 2 }), email: rules.string({ email: true }), age: rules.optional(rules.number({ min: 1 })), note: rules.nullable(rules.string()), tags: rules.array(rules.enum(['a', 'b'] as const)) });
  test('validates and strips unknown fields without coercion', async () => {
    expect(await validate(schema, { name: 'Ada', email: 'a@b.co', note: null, tags: ['a'], extra: 1 }, { unknown: 'strip' })).toEqual({ ok: true, value: { name: 'Ada', email: 'a@b.co', note: null, tags: ['a'] } });
    const result = await validate(schema, { name: 'x', email: 'bad', age: '2', tags: ['z'], extra: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.map(e => e.path)).toEqual(['name', 'email', 'age', 'note', 'tags.0', 'extra']);
  });
  test('treats inherited descriptor names as missing', async () => {
    const rule = rules.object({ toString: rules.optional(rules.string()), valueOf: rules.string() });
    expect(await validate(rule, {})).toEqual({ ok: false, errors: [{ path: 'valueOf', code: 'required' }] });
    expect((await validate(rules.object({ toString: rules.optional(rules.string()) }), {})).ok).toBe(true);
  });
  test('rejects invalid runtime unknown policies instead of stripping', async () => {
    await expect(validate(rules.object({}), { extra: 1 }, { unknown: 'typo' as 'fail' })).rejects.toThrow(TypeError);
  });
  test('does not run item validators when an array exceeds its maximum', async () => {
    let calls = 0;
    const rule = rules.array(rules.custom(rules.number(), () => { calls++; return true; }), { max: 1 });
    expect(await validate(rule, [1, 2, 3])).toEqual({ ok: false, errors: [{ path: '', code: 'max' }] });
    expect(calls).toBe(0);
  });
  test('validates nested values, nullability, bounds and booleans', async () => {
    const nested = rules.object({ active: rules.boolean(), score: rules.number({ min: -2, max: 3 }), children: rules.array(rules.object({ text: rules.string({ max: 3 }) }), { min: 1 }) });
    expect((await validate(nested, { active: true, score: -1, children: [{ text: 'yes' }] })).ok).toBe(true);
    const bad = await validate(nested, { active: 1, score: 4, children: [{ text: null }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toEqual([{ path: 'active', code: 'boolean' }, { path: 'score', code: 'max' }, { path: 'children.0.text', code: 'string' }]);
    expect((await validate(rules.optional(rules.string()), null)).ok).toBe(false);
  });
  test('rejects prototypes, accessors and unsafe keys without invoking getters', async () => {
    let accessed = false;
    const input = Object.defineProperty({}, 'name', { enumerable: true, get() { accessed = true; return 'secret'; } });
    expect((await validate(schema, input)).ok).toBe(false);
    expect(accessed).toBe(false);
    expect((await validate(schema, Object.create({ name: 'Ada' }))).ok).toBe(false);
    expect((await validate(schema, JSON.parse('{"__proto__":{}}'))).ok).toBe(false);
  });
  test('custom rules hide exceptions and observe cancellation', async () => {
    const rule = rules.custom(rules.string(), async () => { throw new Error('secret'); });
    const result = await validate(rule, 'private');
    expect(JSON.stringify(result)).not.toContain('secret');
    const controller = new AbortController(); controller.abort();
    expect(await validate(rule, 'private', { signal: controller.signal })).toEqual({ ok: false, errors: [{ path: '', code: 'aborted' }] });
  });
  test('aborts a pending async custom rule without leaking its error', async () => {
    const controller = new AbortController();
    const pending = validate(rules.custom(rules.string(), () => new Promise<boolean>(() => {})), 'secret', { signal: controller.signal });
    await Promise.resolve(); controller.abort();
    expect(await pending).toEqual({ ok: false, errors: [{ path: '', code: 'aborted' }] });
  });
  test('cancels an oversized stream and a stalled stream on abort', async () => {
    let canceled = 0;
    const make = (stream: ReadableStream<Uint8Array>) => new Request('http://localhost/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream });
    const oversized = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(5)); }, cancel() { canceled++; } });
    expect((await validateRequest(make(oversized), rules.string(), { maxBytes: 4 })).ok).toBe(false);
    expect(canceled).toBe(1);
    const controller = new AbortController();
    const stalled = new ReadableStream<Uint8Array>({ cancel() { canceled++; } });
    const pending = validateRequest(make(stalled), rules.string(), { maxBytes: 10, signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, errors: [{ path: '', code: 'aborted' }] });
    expect(canceled).toBe(2);
  });
  test('honors request cancellation even with an additional signal', async () => {
    const controller = new AbortController();
    const other = new AbortController();
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
    const request = new Request('http://localhost/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, signal: controller.signal });
    const pending = validateRequest(request, rules.string(), { maxBytes: 10, signal: other.signal });
    controller.abort();
    const result = await Promise.race([pending, Bun.sleep(30).then(() => 'timeout')]);
    expect(result).toEqual({ ok: false, errors: [{ path: '', code: 'aborted' }] });
    expect(canceled).toBe(true);
    other.abort();
  });
  test('streams bounded JSON and rejects invalid input', async () => {
    const request = (body: string, type = 'application/json') => new Request('http://localhost/', { method: 'POST', headers: { 'content-type': type }, body });
    expect((await validateRequest(request('{"x":1}'), rules.object({ x: rules.number() }), { maxBytes: 20 })).ok).toBe(true);
    expect(await validateRequest(request('{bad'), schema, { maxBytes: 20 })).toEqual({ ok: false, errors: [{ path: '', code: 'json' }] });
    expect(await validateRequest(request('{}', 'text/plain'), schema, { maxBytes: 20 })).toEqual({ ok: false, errors: [{ path: '', code: 'content_type' }] });
    expect(await validateRequest(request('{"long":12345}'), schema, { maxBytes: 4 })).toEqual({ ok: false, errors: [{ path: '', code: 'body_too_large' }] });
  });
});
