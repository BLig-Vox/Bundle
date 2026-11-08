import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export function className(value: string): string {
  if (!value || value.match(/^[A-Z][A-Za-z0-9]*/)?.[0] !== value) {
    throw new Error("Use a PascalCase class name containing only letters and numbers, e.g. Product.");
  }
  return value;
}

async function createFile(directory: string, name: string, content: string) {
  // Inspect every existing ancestor before creating directories; never follow a
  // symlinked parent. Workspaces must be trusted against concurrent replacement.
  const missing: string[] = [];
  for (let path = resolve(directory);; path = dirname(path)) {
    try {
      if (!(await lstat(path)).isDirectory()) throw new Error("Generation requires real directories without symlinks.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(path);
    }
    if (dirname(path) === path) break;
  }
  for (const path of missing.reverse()) {
    try { await mkdir(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await lstat(path)).isDirectory()) throw new Error("Generation requires real directories without symlinks.");
  }
  const filename = join(directory, `${name}.ts`);
  // Exclusive creation: generators never replace existing code or follow an existing symlink.
  await writeFile(filename, content, { flag: "wx" });
  return filename;
}

export const MAX_MODEL_FIELDS = 64;
const modelTypes = {
  string: { ts: "string", orm: '"string"' },
  text: { ts: "string", orm: '"text"' },
  integer: { ts: "number", orm: '"integer"' },
  number: { ts: "number", orm: '"double"' },
  boolean: { ts: "boolean", orm: '"boolean"' },
  date: { ts: "globalThis.Date", orm: "globalThis.Date" },
  json: { ts: "_BundleJsonValue", orm: '"json"' },
};
const reservedFields = new Set((
  "id createdat updatedat constructor prototype proto tostring tolocalestring valueof hasownproperty isprototypeof propertyisenumerable "
  + "definegetter definesetter lookupgetter lookupsetter then tojson "
  + "await break case catch class const continue debugger default delete do else enum export extends false finally for function "
  + "if import in instanceof new null return super switch this throw true try typeof var void while with yield "
  + "implements interface let package private protected public static eval arguments"
).split(" "));
const canonicalField = (name: string) => name.replaceAll("_", "").toLowerCase();

/** Pure validation/rendering must finish before any filesystem or database work. */
export function modelSource(name: string, fields: string[] = []): string {
  className(name);
  if (name.length > 64 || /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i.test(name)) {
    throw new Error("Model names must be at most 64 characters and cannot be reserved device names.");
  }
  if (["Date", "String", "Number", "Boolean", "BigInt", "Buffer", "Object", "Array"].includes(name)) {
    throw new Error("Model names must not shadow built-in scalar types, e.g. Date. Choose a domain-specific name.");
  }
  if (fields.length > MAX_MODEL_FIELDS) throw new Error(`Provide at most ${MAX_MODEL_FIELDS} model fields using repeated --field name:type options.`);
  const seen = new Set<string>();
  const parsed = fields.map(field => {
    const match = /^([A-Za-z][A-Za-z0-9_]{0,63}):(string|text|integer|number|boolean|date|json)(\?)?/.exec(field);
    if (!match || match[0] !== field) throw new Error("Invalid model field spec. Use name:string|text|integer|number|boolean|date|json with an optional trailing ?.");
    const key = match[1]!;
    const canonical = canonicalField(key);
    if (reservedFields.has(canonical) || seen.has(canonical)) throw new Error("Reserved or duplicate model field name (including equivalent database column names).");
    seen.add(canonical);
    return { key, type: match[2]! as keyof typeof modelTypes, optional: !!match[3] };
  });
  const optional = ["createdAt", "updatedAt", ...parsed.filter(field => field.optional).map(field => field.key)];
  const properties = parsed.map(({ key, type, optional }) => `  ${key}${optional ? "?" : "!"}: ${modelTypes[type].ts}${optional ? " | null" : ""};\n`).join("");
  const mappings = parsed.map(({ key, type, optional }) => `    ${key}: { type: ${modelTypes[type].orm}${optional ? ", nullable: true" : ""} },\n`).join("");
  const json = parsed.some(field => field.type === "json")
    ? "type _BundleJsonValue = string | number | boolean | (_BundleJsonValue | null)[] | { [key: string]: _BundleJsonValue | null };\n\n" : "";
  return `import { EntitySchema as _BundleEntitySchema, OptionalProps as _BundleOptionalProps } from "@mikro-orm/core";

${json}export class ${name} {
  [_BundleOptionalProps]?: ${optional.map(key => JSON.stringify(key)).join(" | ")};
  id!: number;
  createdAt = new globalThis.Date();
  updatedAt = new globalThis.Date();
${properties}}

export default new _BundleEntitySchema<${name}>({
  class: ${name},
  properties: {
    id: { type: "number", primary: true },
    createdAt: { type: globalThis.Date },
    updatedAt: { type: globalThis.Date, onUpdate: () => new globalThis.Date() },
${mappings}  },
});
`;
}

export function generateModel(directory: string, name: string, fields: string[] = []) {
  return createFile(directory, name, modelSource(name, fields));
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
