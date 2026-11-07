export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type Pagination = { page: number; perPage: number; total: number };
export type CollectionOptions = { meta?: unknown; pagination?: Pagination; status?: number; headers?: ConstructorParameters<typeof Headers>[0] };
export type ResourceOptions = { meta?: unknown; status?: number; headers?: ConstructorParameters<typeof Headers>[0] };
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
function jsonValue(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) throw new TypeError('Value is not JSON serializable');
  const isArray = Array.isArray(value); const proto = Object.getPrototypeOf(value);
  if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new TypeError('Value is not JSON serializable');
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value); const keys = Reflect.ownKeys(descriptors);
    if (isArray) {
      const length = (value as unknown[]).length;
      if (keys.some(k => typeof k !== 'string' || (k !== 'length' && (!/^(0|[1-9]\d*)$/.test(k) || Number(k) >= length || !('value' in descriptors[k]!) || !descriptors[k]!.enumerable)))) throw new TypeError('Value is not JSON serializable');
      const result: JsonValue[] = []; for (let i = 0; i < length; i++) { const d = descriptors[String(i)]; if (!d) throw new TypeError('Value is not JSON serializable'); result.push(jsonValue(d.value, ancestors)); } return result;
    }
    const result: Record<string, JsonValue> = Object.create(null);
    for (const key of keys) { if (typeof key !== 'string' || unsafe.has(key)) throw new TypeError('Value is not JSON serializable'); const d = descriptors[key]!; if (!('value' in d) || !d.enumerable) throw new TypeError('Value is not JSON serializable'); result[key] = jsonValue(d.value, ancestors); } return result;
  } finally { ancestors.delete(value); }
}
function response(data: unknown, options: ResourceOptions, pagination?: Pagination): Response {
  const result: Record<string, JsonValue> = { data: jsonValue(data) };
  if (options.meta !== undefined) result.meta = jsonValue(options.meta);
  if (pagination !== undefined) { const { page, perPage, total } = pagination; if (![page, perPage, total].every(Number.isSafeInteger) || page < 1 || perPage < 1 || total < 0) throw new TypeError('Invalid pagination'); result.pagination = { page, perPage, total, lastPage: Math.max(1, Math.ceil(total / perPage)) }; }
  const headers = new Headers(options.headers); if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8'); return new Response(JSON.stringify(result), { status: options.status ?? 200, headers });
}
export function resource<T>(item: T, transform: (item: T) => unknown, options: ResourceOptions = {}): Response { return response(transform(item), options); }
export function resourceCollection<T>(items: readonly T[], transform: (item: T, index: number) => unknown, options: CollectionOptions = {}): Response { return response(items.map(transform), options, options.pagination); }
