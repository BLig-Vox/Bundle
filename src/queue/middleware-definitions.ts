export interface JobMiddlewareReference { readonly module: string; readonly export: string; readonly method?: string }

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function validName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && identifier.test(value) && !forbidden.has(value);
}

/** Validate and copy bounded, plain executable references without loading application code. */
export function validateJobMiddlewareReferences(input: unknown): readonly JobMiddlewareReference[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > 16 || Reflect.ownKeys(input).length !== input.length + 1) throw new Error("Invalid job middleware array");
  const result: JobMiddlewareReference[] = [];
  for (let i = 0; i < input.length; i++) {
    const item = Object.getOwnPropertyDescriptor(input, String(i));
    if (!item || !item.enumerable || !("value" in item)) throw new Error("Invalid job middleware array");
    const value: unknown = item.value;
    if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Invalid job middleware reference");
    const fields: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== "string" || !["module", "export", "method"].includes(key) || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) throw new Error("Invalid job middleware property");
      fields[key] = descriptor.value;
    }
    if (typeof fields.module !== "string" || fields.module.length > 512 || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts$/.test(fields.module)) throw new Error("Invalid job middleware module");
    if (!validName(fields.export) || (fields.method !== undefined && !validName(fields.method))) throw new Error("Invalid job middleware name");
    result.push(Object.freeze({module: fields.module, export: fields.export, ...(fields.method === undefined ? {} : {method: fields.method as string})}));
  }
  return Object.freeze(result);
}
