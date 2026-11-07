import { EntityManager, type EntityClass, type EntityData, type RequiredEntityData } from '@mikro-orm/core';
import type { HttpContext, HttpHandler, HttpMiddleware } from './router';

export interface ModelResourceOperations {
  readonly index: HttpHandler;
  readonly show: HttpHandler;
  readonly store: HttpHandler;
  readonly update: HttpHandler;
  readonly destroy: HttpHandler;
}

export interface ModelResourceOptions<T extends object> {
  readonly model: EntityClass<T>;
  readonly manager: (context: HttpContext) => EntityManager | Promise<EntityManager>;
  readonly parseId: (value: string) => string | number;
  readonly create: (context: HttpContext) => RequiredEntityData<T> | Response | Promise<RequiredEntityData<T> | Response>;
  readonly update: (context: HttpContext) => EntityData<T> | Response | Promise<EntityData<T> | Response>;
  readonly serialize: (entity: T) => unknown | Promise<unknown>;
}

const registrations = new WeakMap<HttpContext, Map<object, ModelResourceOperations>>();
const fields = ['model', 'manager', 'parseId', 'create', 'update', 'serialize'] as const;

function checkSignal(context: HttpContext): void {
  if (context.request.signal.aborted) throw new Error('Request aborted');
}

function noStore(status: number, body: string | null = null): Response {
  return new Response(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function json(value: unknown, status: number): Response {
  const text = JSON.stringify(value);
  if (text === undefined || new TextEncoder().encode(text).byteLength > 1024 * 1024) throw new Error('Invalid resource output');
  return new Response(text, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function data(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid resource data');
}

function validation(response: Response): Response {
  if (response.status < 400 || response.status > 499) throw new Error('Invalid validation response');
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function modelResourceFor<T extends object>(context: HttpContext, model: EntityClass<T>): ModelResourceOperations {
  const operations = registrations.get(context)?.get(model);
  if (!operations) throw new Error('Resource not registered');
  return operations;
}

export function modelResourceMiddleware<T extends object>(options: ModelResourceOptions<T>): HttpMiddleware {
  if (!options || typeof options !== 'object' || Reflect.ownKeys(options).some(key => typeof key !== 'string' || !fields.includes(key as typeof fields[number]))) throw new Error('Invalid resource options');
  const values = fields.map(key => Object.getOwnPropertyDescriptor(options, key));
  if (values.some(descriptor => !descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function')) throw new Error('Invalid resource options');
  const { model, manager, parseId, create, update, serialize } = Object.fromEntries(fields.map((key, i) => [key, values[i]!.value])) as unknown as ModelResourceOptions<T>;

  return async (context, next) => {
    checkSignal(context);
    const supplied = await manager(context);
    checkSignal(context);
    if (!(supplied instanceof EntityManager)) throw new Error('Invalid entity manager');
    const em = supplied.fork();
    try {
      const active = registrations.get(context);
      if (active?.has(model)) throw new Error('Duplicate resource binding');
      const registry = active ?? new Map<object, ModelResourceOperations>();
      const metadata = em.getMetadata(model);
      if (metadata.primaryKeys.length !== 1) throw new Error('Unsupported primary key');
      const primary = metadata.primaryKeys[0]!;
      if (metadata.properties[primary]?.kind !== 'scalar') throw new Error('Unsupported primary key');
      const run = async <R>(fn: () => R | Promise<R>): Promise<R> => {
        checkSignal(context);
        const result = await fn();
        checkSignal(context);
        return result;
      };
      const entity = async (): Promise<T | Response> => {
        const raw = context.params.id;
        if (typeof raw !== 'string') return noStore(400, 'Bad Request');
        let id: unknown;
        try { id = parseId(raw); } catch { return noStore(400, 'Bad Request'); }
        if (!(typeof id === 'number' && Number.isSafeInteger(id) && id > 0) && !(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id))) return noStore(400, 'Bad Request');
        const found = await run(() => em.findOne(model, { [primary]: id } as never));
        checkSignal(context);
        return found ?? noStore(404, 'Not Found');
      };
      const output = async (item: T, status = 200) => {
        const value = await run(() => serialize(item));
        checkSignal(context);
        return json(value, status);
      };
      const operations: ModelResourceOperations = {
        index: async () => {
          const items = await run(() => em.find(model, {} as never, { limit: 100 }));
          checkSignal(context);
          const result = [];
          for (const item of items) {
            const value = await run(() => serialize(item));
            checkSignal(context);
            result.push(value);
          }
          return json(result, 200);
        },
        show: async () => {
          const item = await entity();
          checkSignal(context);
          return item instanceof Response ? item : output(item);
        },
        store: async () => {
          const input = await run(() => create(context));
          checkSignal(context);
          if (input instanceof Response) return validation(input);
          data(input);
          checkSignal(context);
          const item = em.create(model, input as RequiredEntityData<T>);
          checkSignal(context);
          em.persist(item);
          await run(() => em.flush());
          checkSignal(context);
          return output(item, 201);
        },
        update: async () => {
          const item = await entity();
          checkSignal(context);
          if (item instanceof Response) return item;
          const input = await run(() => update(context));
          checkSignal(context);
          if (input instanceof Response) return validation(input);
          data(input);
          if (Object.hasOwn(input, primary)) throw new Error('Primary key update refused');
          checkSignal(context);
          em.assign(item, input as never);
          await run(() => em.flush());
          checkSignal(context);
          return output(item);
        },
        destroy: async () => {
          const item = await entity();
          checkSignal(context);
          if (item instanceof Response) return item;
          checkSignal(context);
          em.remove(item);
          await run(() => em.flush());
          checkSignal(context);
          return noStore(204);
        },
      };
      registry.set(model, operations);
      if (!active) registrations.set(context, registry);
      try {
        const response = await next();
        checkSignal(context);
        return response;
      } finally { registry.delete(model); if (!active) registrations.delete(context); }
    } finally { em.clear(); }
  };
}
