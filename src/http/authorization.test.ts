import { expect, test } from 'bun:test';
import { evaluatePolicy, authorizePolicy, AuthorizationDeniedError, policyMiddleware } from './authorization.ts';
import { Router } from './router.ts';

const context = () => ({ ability: 'invoice.read', principal: null, resource: null, signal: new AbortController().signal });

test('policies bind instances, require strict decisions and respect cancellation', async () => {
  const policy = { allowed: true, can() { return this.allowed; } };
  expect(await evaluatePolicy(policy, context())).toBe(true);
  await expect(evaluatePolicy({ can: () => 1 } as never, context())).rejects.toThrow();
  await expect(evaluatePolicy(policy, { ...context(), ability: 'bad ability' })).rejects.toThrow();
  await expect(authorizePolicy({ can: () => false }, context())).rejects.toBeInstanceOf(AuthorizationDeniedError);
  const controller = new AbortController();
  await expect(evaluatePolicy({ async can() { controller.abort(); return true; } }, { ...context(), signal: controller.signal })).rejects.toThrow();
  await expect(evaluatePolicy(policy, { ...context(), signal: controller.signal })).rejects.toThrow();
});

test('authorization rechecks cancellation at the decision completion boundary', async () => {
  const controller = new AbortController();
  const policy = {can() { queueMicrotask(() => queueMicrotask(() => controller.abort(new Error('completion cancelled')))); return true; }};
  await expect(authorizePolicy(policy, {...context(),signal:controller.signal})).rejects.toThrow('completion cancelled');
});

test('middleware never enters a handler after cancellation in the policy completion window', async () => {
  const controller = new AbortController();
  let called = false;
  const guard = policyMiddleware({ability:'read',principal:()=>null,policy:{can() {
    queueMicrotask(() => queueMicrotask(() => controller.abort(new Error('completion cancelled'))));
    return true;
  }}});
  const result = guard({request:new Request('http://localhost/',{signal:controller.signal}),params:{},state:new Map()},async()=>{called=true;return new Response('must not run');});
  await expect(result).rejects.toThrow('completion cancelled');
  expect(controller.signal.aborted).toBe(true);
  expect(called).toBe(false);
});

test('middleware denies safely and propagates other failures', async () => {
  let calls = 0;
  const router = new Router().add('GET', '/', () => { calls++; return new Response('ok'); }, { middleware: [policyMiddleware({ ability: 'invoice.read', policy: { can: () => false }, principal: () => 'secret' })] });
  const denied = await router.fetch(new Request('http://localhost/'));
  expect(denied.status).toBe(403);
  expect(denied.headers.get('cache-control')).toBe('no-store');
  expect(await denied.text()).not.toContain('secret');
  expect(calls).toBe(0);
  const broken = new Router().add('GET', '/', () => new Response('bad'), { middleware: [policyMiddleware({ ability: 'read', policy: { can() { throw new Error('secret'); } }, principal: () => null })] });
  expect((await broken.fetch(new Request('http://localhost/'))).status).toBe(500);
});


test('validates declarations and ability boundaries', async () => {
  for (const ability of ['', '1read', 'read space', 'read\n', 'é', 'a'.repeat(129)]) {
    await expect(evaluatePolicy({ can: () => true }, { ...context(), ability })).rejects.toThrow();
    expect(() => policyMiddleware({ ability, policy: { can: () => true }, principal: () => null })).toThrow();
  }
  expect(await evaluatePolicy({ can: async () => true }, { ...context(), ability: 'a' + 'x'.repeat(127) })).toBe(true);
  expect(() => policyMiddleware({ ability: 'read', policy: {} as never, principal: () => null })).toThrow();
  expect(() => policyMiddleware({ ability: 'read', policy: { can: () => true }, principal: null as never })).toThrow();
  expect(() => policyMiddleware({ ability: 'read', policy: { can: () => true }, principal: () => null, resource: 1 as never })).toThrow();
  await expect(authorizePolicy({ can: () => { throw new Error('policy failure'); } }, context())).rejects.toThrow('policy failure');
});

test('middleware resolves each request, awaits policy, and does not catch downstream failures', async () => {
  const seen: unknown[] = [];
  const router = new Router().add('GET', '/', () => { throw new AuthorizationDeniedError(); }, { middleware: [policyMiddleware({
    ability: 'read', principal: async ctx => ctx.request.headers.get('x-id'), resource: async () => ({ id: 1 }),
    policy: { async can(ctx) { seen.push([ctx.principal, ctx.resource, ctx.signal instanceof AbortSignal]); return true; } },
  })] });
  const response = await router.fetch(new Request('http://localhost/', { headers: { 'x-id': 'alice' } }));
  expect(response.status).toBe(500);
  expect(seen).toEqual([['alice', { id: 1 }, true]]);
  const thrownDenial = new Router().add('GET', '/', () => new Response('bad'), { middleware: [policyMiddleware({ ability: 'read', principal: () => null, policy: { can() { throw new AuthorizationDeniedError(); } } })] });
  expect((await thrownDenial.fetch(new Request('http://localhost/'))).status).toBe(500);
  const invalid = new Router().add('GET', '/', () => new Response('bad'), { middleware: [policyMiddleware({ ability: 'read', principal: () => null, policy: { can: () => 'yes' } as never })] });
  expect((await invalid.fetch(new Request('http://localhost/'))).status).toBe(500);
});
