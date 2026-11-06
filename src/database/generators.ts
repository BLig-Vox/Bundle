import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function className(value: string): string {
  if (!/^[A-Z][A-Za-z0-9]*$/.test(value)) {
    throw new Error("Use a PascalCase class name containing only letters and numbers, e.g. Product.");
  }
  return value;
}

async function createFile(directory: string, name: string, content: string) {
  await mkdir(directory, { recursive: true });
  const filename = join(directory, `${name}.ts`);
  // Exclusive creation: generators never replace existing code or follow an existing symlink.
  await writeFile(filename, content, { flag: "wx" });
  return filename;
}

export function generateModel(directory: string, name: string) {
  className(name);
  if (["Date", "String", "Number", "Boolean", "BigInt", "Buffer", "Object", "Array"].includes(name)) {
    throw new Error("Model names must not shadow built-in scalar types, e.g. Date. Choose a domain-specific name.");
  }
  return createFile(directory, name, `import { EntitySchema as _BundleEntitySchema, OptionalProps as _BundleOptionalProps } from "@mikro-orm/core";

export class ${name} {
  [_BundleOptionalProps]?: "createdAt" | "updatedAt";
  id!: number;
  createdAt = new globalThis.Date();
  updatedAt = new globalThis.Date();
}

export default new _BundleEntitySchema<${name}>({
  class: ${name},
  properties: {
    id: { type: "number", primary: true },
    createdAt: { type: globalThis.Date },
    updatedAt: { type: globalThis.Date, onUpdate: () => new globalThis.Date() },
  },
});
`);
}

export function generateSeeder(directory: string, name: string) {
  className(name);
  if (!name.endsWith("Seeder")) throw new Error("Seeder class names must end with Seeder, e.g. ProductSeeder.");
  return createFile(directory, name, `import type { EntityManager as _BundleEntityManager } from "@mikro-orm/core";
import { Seeder as _BundleSeeder } from "@mikro-orm/seeder";

export class ${name} extends _BundleSeeder {
  override async run(em: _BundleEntityManager): Promise<void> {
    // Create or upsert your seed data here. The seed manager flushes after run().
    void em;
  }
}
`);
}
