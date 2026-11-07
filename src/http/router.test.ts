import { describe, expect, test } from 'bun:test';
import { createRouter, type HttpMiddleware } from './router';

const req = (path: string, method = 'GET') => new Request(`http://localhost${path}`, { method });

describe('HTTP router', () => {
  test('matches decoded parameters, prioritizes literals, and exposes inert metadata', async () => {
    const router = createRouter()
      .add('GET', '/users/:id', ({ params }) => Response.json(params), { name: 'users.show' })
      .add('GET', '/users/me', () => new Response('me'));
    expect(await (await router.fetch(req('/users/me'))).text()).toBe('me');
    expect(await (await router.fetch(req('/users/caf%C3%A9'))).json()).toEqual({ id: 'café' });
    expect(await (await router.fetch(req('/users/%2F'))).json()).toEqual({ id: '/' });
    expect((await router.fetch(req('/Users/me'))).status).toBe(404);
    expect((await router.fetch(req('/users/me/'))).status).toBe(404);
    expect((await router.fetch(req('/users/%ZZ'))).status).toBe(400);
    expect(router.describe()).toEqual([
      { method: 'GET', path: '/users/:id', name: 'users.show', middleware: [] },
      { method: 'GET', path: '/users/me', middleware: [] },
    ]);
  });

  test('rejects malformed patterns, ambiguous routes, and duplicate names atomically', () => {
    const router = createRouter().add('GET', '/a/:id', () => new Response(), { name: 'first' });
    for (const path of ['a', '/a/', '/a//b', '/:x/:x', '/a/*', '/a/:id?', '/a/%61', '/a?x', '/a/#x']) {
      expect(() => router.add('GET', path, () => new Response())).toThrow();
    }
    expect(() => router.add('GET', '/a/:other', () => new Response())).toThrow();
    expect(() => router.add('POST', '/b', () => new Response(), { name: 'first' })).toThrow();
    expect(() => router.add(['POST', 'GET'], '/a/:id', () => new Response())).toThrow();
    expect(() => router.add('', '/b', () => new Response())).toThrow();
    expect(router.describe()).toHaveLength(1);
    router.add('POST', '/a/:other', () => new Response());
    expect(() => createRouter().add('GET', '/:x/b', () => new Response()).add('POST', '/a/:y', () => new Response())).toThrow();
  });

  test('reports each method and middleware in independent metadata snapshots', () => {
    const named: HttpMiddleware = function named(_, next) { return next(); };
    const middleware = [named];
    const router = createRouter().add(['get', 'post'], '/x', () => new Response(), { middleware });
    middleware.length = 0;
    const result = router.describe();
    expect(result).toEqual([{ method: 'GET', path: '/x', middleware: ['named'] }, { method: 'POST', path: '/x', middleware: ['named'] }]);
    result[0]!.middleware.push('mutated');
    expect(router.describe()[0]!.middleware).toEqual(['named']);
  });

  test('selects the most specific path before evaluating methods', async () => {
    const router = createRouter().add('POST', '/users/:id', () => new Response('parameter')).add('GET', '/users/me', () => new Response('literal'));
    const response = await router.fetch(req('/users/me?ignored=yes', 'POST'));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
  });

  test('handles 404, 405, implicit HEAD and OPTIONS with deterministic Allow', async () => {
    const router = createRouter().add('get', '/x', () => new Response('body', { headers: { 'x-test': 'yes' } })).add('POST', '/x', () => new Response('posted'));
    expect((await router.fetch(req('/missing'))).status).toBe(404);
    const wrong = await router.fetch(req('/x', 'PUT'));
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('GET, HEAD, OPTIONS, POST');
    const options = await router.fetch(req('/x', 'OPTIONS'));
    expect(options.status).toBe(204);
    expect(options.headers.get('allow')).toBe('GET, HEAD, OPTIONS, POST');
    const head = await router.fetch(req('/x', 'HEAD'));
    expect(head.status).toBe(200);
    expect(head.headers.get('x-test')).toBe('yes');
    expect(await head.text()).toBe('');
    router.add('HEAD', '/x', () => new Response('explicit', { status: 202 }));
    router.add('OPTIONS', '/x', () => new Response('custom'));
    expect((await router.fetch(req('/x', 'HEAD'))).status).toBe(202);
    expect(await (await router.fetch(req('/x', 'OPTIONS'))).text()).toBe('custom');
  });

  test('runs middleware in order with isolated state and a once-only next', async () => {
    const events: string[] = [];
    const outer: HttpMiddleware = async (ctx, next) => { events.push('before'); ctx.state.set('x', 1); const result = await next(); events.push('after'); return result; };
    const inner: HttpMiddleware = async (ctx, next) => { events.push(String(ctx.state.get('x'))); return next(); };
    const router = createRouter().add('GET', '/', (ctx) => { events.push('handler'); return new Response(String(ctx.state.size)); }, { middleware: [outer, inner] });
    expect(await (await router.fetch(req('/'))).text()).toBe('1');
    expect(events).toEqual(['before', '1', 'handler', 'after']);
    const isolated = createRouter().add('GET', '/', ctx => { const size = ctx.state.size; ctx.state.set('x', 1); return new Response(String(size)); });
    expect(await (await isolated.fetch(req('/'))).text()).toBe('0');
    expect(await (await isolated.fetch(req('/'))).text()).toBe('0');
    const bad = createRouter().add('GET', '/', () => new Response(), { middleware: [async (_, next) => { await next(); return next(); }] });
    expect((await bad.fetch(req('/'))).status).toBe(500);
  });

  test('sanitizes thrown errors and passes the request signal through', async () => {
    const controller = new AbortController();
    const request = new Request('http://localhost/', { signal: controller.signal });
    const router = createRouter().add('GET', '/', ctx => { expect(ctx.request.signal.aborted).toBe(true); throw new Error('private-secret'); });
    controller.abort();
    const response = await router.fetch(request);
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('private-secret');
  });

  test('cancels discarded implicit and explicit HEAD bodies without awaiting cleanup', async () => {
    const cancelled: string[] = [];
    const stream = (label: string, cleanup: () => void | Promise<void>) => new ReadableStream<Uint8Array>({ cancel() { cancelled.push(label); return cleanup(); } });
    const router = createRouter()
      .add('GET', '/implicit', () => new Response(stream('implicit', () => Promise.reject(new Error('private')))))
      .add('HEAD', '/explicit', () => new Response(stream('explicit', () => new Promise<void>(() => {}))));
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => router.fetch(request) });
    try {
      for (const path of ['/implicit', '/explicit']) {
        const response = await Promise.race([
          fetch(`http://127.0.0.1:${server.port}${path}`, { method: 'HEAD' }),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('HEAD cleanup blocked response')), 1000)),
        ]);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('');
      }
      expect(cancelled).toEqual(['implicit', 'explicit']);
      await Bun.sleep(10);
    } finally { await server.stop(true); }
  });

  test('serves real local HTTP requests and always closes the server', async () => {
    const router = createRouter().add('GET', '/items/:id', ctx => Response.json(ctx.params));
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => router.fetch(request) });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/items/hello%20world`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id: 'hello world' });
      const missing = await fetch(`http://127.0.0.1:${server.port}/items/test`, { method: 'DELETE' });
      expect(missing.status).toBe(405);
      expect(missing.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    } finally { await server.stop(true); }
  });
});
