export interface HttpContext {
  request: Request;
  params: Readonly<Record<string, string>>;
  state: Map<string, unknown>;
}

export type HttpHandler = (context: HttpContext) => Response | Promise<Response>;
export type HttpMiddleware = (context: HttpContext, next: () => Promise<Response>) => Response | Promise<Response>;
export interface RouteMetadata {
  method: string;
  path: string;
  name?: string;
  middleware: string[];
}

type Segment = { kind: 'literal'; value: string } | { kind: 'parameter'; value: string };
type Route = { methods: string[]; path: string; segments: Segment[]; handler: HttpHandler; name?: string; middleware: HttpMiddleware[] };

function parsePath(path: string): Segment[] {
  if (typeof path !== 'string' || !path.startsWith('/') || (path !== '/' && path.endsWith('/'))) throw new Error('Invalid route path');
  const names = new Set<string>();
  return (path === '/' ? [] : path.slice(1).split('/')).map(segment => {
    if (segment.startsWith(':')) {
      const name = segment.slice(1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name)) throw new Error('Invalid route parameter');
      names.add(name);
      return { kind: 'parameter', value: name };
    }
    if (!/^[A-Za-z0-9._~-]+$/.test(segment) || segment === '.' || segment === '..') throw new Error('Unsupported route segment');
    return { kind: 'literal', value: segment };
  });
}

// 0 means equal shapes, 1/-1 means one is strictly more specific, null means disjoint.
function compare(a: Segment[], b: Segment[]): number | null {
  if (a.length !== b.length) return null;
  let aMore = false, bMore = false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!, right = b[i]!;
    if (left.kind === 'literal' && right.kind === 'literal' && left.value !== right.value) return null;
    if (left.kind === 'literal' && right.kind === 'parameter') aMore = true;
    if (left.kind === 'parameter' && right.kind === 'literal') bMore = true;
  }
  if (aMore && bMore) return 2;
  return aMore ? 1 : bMore ? -1 : 0;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string | readonly string[], path: string, handler: HttpHandler, options: { name?: string; middleware?: readonly HttpMiddleware[] } = {}): this {
    const input = typeof method === 'string' ? [method] : method;
    if (!Array.isArray(input) || input.length === 0 || input.some(value => typeof value !== 'string' || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value))) throw new Error('Invalid HTTP method');
    const methods = input.map(value => value.toUpperCase());
    if (new Set(methods).size !== methods.length) throw new Error('Duplicate HTTP method');
    const segments = parsePath(path);
    if (typeof handler !== 'function') throw new Error('Invalid route handler');
    if (options.name !== undefined && (typeof options.name !== 'string' || !options.name.trim())) throw new Error('Invalid route name');
    if (options.middleware !== undefined && (!Array.isArray(options.middleware) || options.middleware.some(item => typeof item !== 'function'))) throw new Error('Invalid route middleware');
    for (const existing of this.routes) {
      if (options.name !== undefined && existing.name === options.name) throw new Error('Duplicate route name');
      const relation = compare(segments, existing.segments);
      if (relation === 2) throw new Error('Ambiguous route patterns');
      if (relation === 0 && methods.some(value => existing.methods.includes(value))) throw new Error('Duplicate route method and path');
    }
    this.routes.push({ methods, path, segments, handler, ...(options.name === undefined ? {} : { name: options.name }), middleware: [...(options.middleware ?? [])] });
    return this;
  }

  describe(): RouteMetadata[] {
    return this.routes.flatMap(route => route.methods.map(method => ({ method, path: route.path, ...(route.name === undefined ? {} : { name: route.name }), middleware: route.middleware.map(item => item.name || 'anonymous') })));
  }

  async fetch(request: Request): Promise<Response> {
    const head = request.method === 'HEAD';
    let response: Response;
    try {
      response = await this.dispatch(request);
      if (!(response instanceof Response)) throw new Error('Invalid handler response');
    } catch {
      response = new Response('Internal Server Error', { status: 500, headers: { 'Cache-Control': 'no-store' } });
    }
    if (!head) return response;
    // HEAD discards the handler's body. Signal its source without letting a slow
    // or rejected cleanup delay or break the response.
    try { if (response.body) void response.body.cancel().catch(() => {}); } catch { /* Cleanup is best-effort. */ }
    return new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  private async dispatch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    let parts: string[];
    try { parts = pathname === '/' ? [] : pathname.slice(1).split('/').map(decodeURIComponent); }
    catch { return new Response('Bad Request', { status: 400 }); }
    const matches = this.routes.filter(route => route.segments.length === parts.length && route.segments.every((segment, index) => segment.kind === 'parameter' ? parts[index] !== '' : segment.value === parts[index]));
    if (matches.length === 0) return new Response('Not Found', { status: 404 });
    const best = matches.reduce((current, candidate) => compare(candidate.segments, current.segments) === 1 ? candidate : current);
    const same = matches.filter(route => compare(route.segments, best.segments) === 0);
    const allowed = new Set(same.flatMap(route => route.methods));
    if (allowed.has('GET')) allowed.add('HEAD');
    allowed.add('OPTIONS');
    const allow = [...allowed].sort().join(', ');
    const method = request.method;
    const selected = same.find(route => route.methods.includes(method)) ?? (method === 'HEAD' ? same.find(route => route.methods.includes('GET')) : undefined);
    if (!selected) return method === 'OPTIONS' ? new Response(null, { status: 204, headers: { Allow: allow } }) : new Response('Method Not Allowed', { status: 405, headers: { Allow: allow } });
    const params: Record<string, string> = Object.create(null);
    selected.segments.forEach((segment, index) => { if (segment.kind === 'parameter') params[segment.value] = parts[index]!; });
    const context: HttpContext = { request, params: Object.freeze(params), state: new Map() };
    let last = -1;
    const invoke = async (index: number): Promise<Response> => {
      if (index <= last) throw new Error('next() called more than once');
      last = index;
      const middleware = selected.middleware[index];
      return middleware ? middleware(context, () => invoke(index + 1)) : selected.handler(context);
    };
    return invoke(0);
  }
}

export function createRouter(): Router { return new Router(); }
