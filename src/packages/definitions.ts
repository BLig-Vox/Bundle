import { defineProviders, type ProviderReference } from '../console/providers';

export interface PackageDefinition { readonly name: string; readonly providers: readonly ProviderReference[] }

export function definePackages(input: readonly PackageDefinition[]): readonly PackageDefinition[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype || input.length > 32 || Reflect.ownKeys(input).length !== input.length + 1) throw new Error('Invalid package definitions.');
  const names = new Set<string>();
  const all: ProviderReference[] = [];
  const result: PackageDefinition[] = [];
  for (let i = 0; i < input.length; i++) {
    const entry = Object.getOwnPropertyDescriptor(input, String(i));
    if (!entry || !entry.enumerable || !('value' in entry)) throw new Error('Invalid package definitions.');
    const item: unknown = entry.value;
    if (!item || typeof item !== 'object' || Array.isArray(item) || ![Object.prototype, null].includes(Object.getPrototypeOf(item)) || Reflect.ownKeys(item).length !== 2) throw new Error('Invalid package definition.');
    const name = Object.getOwnPropertyDescriptor(item, 'name');
    const providers = Object.getOwnPropertyDescriptor(item, 'providers');
    if (!name?.enumerable || !('value' in name) || !providers?.enumerable || !('value' in providers) || typeof name.value !== 'string' || !/^[a-z][a-z0-9._-]{0,127}$/.test(name.value) || names.has(name.value)) throw new Error('Invalid package definition.');
    names.add(name.value);
    const refs = defineProviders(providers.value);
    all.push(...refs);
    if (all.length > 64) throw new Error('Invalid package definitions.');
    result.push(Object.freeze({ name: name.value, providers: refs }));
  }
  defineProviders(all);
  return Object.freeze(result);
}
