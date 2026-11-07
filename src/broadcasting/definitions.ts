const defined = new WeakSet<object>();
const identifier = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;
const MAX_CHANNELS = 128;
const MAX_NAME_LENGTH = 256;

export interface ChannelDefinition { readonly name: string }
export type ChannelDefinitions = readonly ChannelDefinition[];

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (key !== "name" || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) return false;
  }
  return true;
}

function validName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_NAME_LENGTH) return false;
  const parameters = new Set<string>();
  return value.split(".").every(segment => {
    const parameter = /^\{([^{}]+)\}$/.exec(segment);
    if (!parameter) return identifier.test(segment);
    const name = parameter[1]!;
    if (!identifier.test(name) || parameters.has(name)) return false;
    parameters.add(name);
    return true;
  });
}

/** Copy and freeze bounded channel names for safe metadata listing. */
export function defineChannels(input: readonly ChannelDefinition[]): ChannelDefinitions {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || Reflect.ownKeys(input).length !== input.length + 1) throw new Error("Expected a dense channel array");
  if (input.length > MAX_CHANNELS) throw new Error(`Channel registry exceeds ${MAX_CHANNELS} entries`);
  const values: unknown[] = [];
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || descriptor.value === undefined) throw new Error("Expected a dense data-only channel array");
    values.push(descriptor.value);
  }
  const names = new Set<string>();
  const result = values.map(item => {
    if (!isRecord(item) || !validName(item.name)) throw new Error("Invalid broadcast channel name or definition");
    if (names.has(item.name)) throw new Error(`Duplicate broadcast channel ${item.name}`);
    names.add(item.name);
    return Object.freeze({ name: item.name });
  });
  Object.freeze(result);
  defined.add(result);
  return result;
}

export function isDefinedChannels(value: unknown): value is ChannelDefinitions {
  return typeof value === "object" && value !== null && defined.has(value);
}
