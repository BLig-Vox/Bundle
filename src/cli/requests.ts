import { writeFile } from "node:fs/promises";
import { generateSource, validateSourceName } from "./scaffold.ts";

export const MAX_REQUEST_FIELDS = 64;
export const MAX_REQUEST_SOURCE_BYTES = 8192;
const reservedIdentifiers = new Set((
  "await break case catch class const continue debugger default delete do else enum export extends false finally for function "
  + "if import in instanceof new null return super switch this throw true try typeof var void while with yield "
  + "implements interface let package private protected public static schema eval arguments"
).split(" "));
const expressions = {
  string: "schema.string({ trim: true, min: 1, max: 255 })",
  text: "schema.string({ trim: true, min: 1, max: 10000 })",
  integer: "schema.number({ finite: true, integer: true })",
  boolean: "schema.boolean()",
};

/** Validate and render the entire request before touching the filesystem. */
export function generateRequest(root: string, name: string, fields: string[], io: { writeFile?: typeof writeFile } = {}): Promise<string> {
  validateSourceName(name);
  if (name.length > 64) throw new Error("Request names must be at most 64 characters.");
  const identifier = name.replace(/^[A-Z]+(?=[A-Z][a-z]|[0-9]|$)|^[A-Z]/, value => value.toLowerCase());
  if (reservedIdentifiers.has(identifier) || name === "Infer") throw new Error("Request name conflicts with a reserved identifier or schema import.");
  if (!fields.length || fields.length > MAX_REQUEST_FIELDS) throw new Error(`Provide 1–${MAX_REQUEST_FIELDS} fields using repeated --field name:type options.`);
  const seen = new Set<string>();
  const lines = fields.map(field => {
    // Compare the whole match: JavaScript $ also accepts a final newline.
    const match = /^([a-zA-Z][a-zA-Z0-9_]{0,63}):(string|text|integer|boolean)(\?)?/.exec(field);
    if (!match || match[0] !== field) throw new Error("Invalid field spec. Use name:string|text|integer|boolean with an optional trailing ?.");
    const key = match[1]!;
    const type = match[2]! as keyof typeof expressions;
    const optional = match[3];
    if (["__proto__", "constructor", "prototype"].includes(key) || seen.has(key)) throw new Error("Unsafe or duplicate field name.");
    seen.add(key);
    const expression = expressions[type];
    return `  ${key}: ${optional ? `schema.optional(${expression})` : expression},`;
  });
  const source = `import { schema, type Infer } from "bundle/src/validation/schema.ts";

export const ${identifier} = schema.object({
${lines.join("\n")}
});

export type ${name} = Infer<typeof ${identifier}>;
`;
  if (Buffer.byteLength(source, "utf8") > MAX_REQUEST_SOURCE_BYTES) throw new Error(`Generated request source exceeds ${MAX_REQUEST_SOURCE_BYTES} bytes; use fewer or shorter fields.`);
  return generateSource(root, name, "request", () => source, io);
}
