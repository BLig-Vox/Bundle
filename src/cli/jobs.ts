import { generateSource, validateSourceName } from "./scaffold.ts";

export const MAX_JOB_FIELDS = 64;
export const MAX_JOB_SOURCE_BYTES = 8192;
const expressions = {
  string: "jobSchema.string({ trim: true, min: 1, max: 255 })",
  text: "jobSchema.string({ trim: true, min: 1, max: 10000 })",
  integer: "jobSchema.number({ finite: true, integer: true })",
  number: "jobSchema.number({ finite: true })",
  boolean: "jobSchema.boolean()",
};

function validateJobName(name: string) {
  validateSourceName(name);
  if (name.length > 64) throw new Error("Job names must be at most 64 characters.");
}

function validateJobType(type: string) {
  if (typeof type !== "string" || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(type)) {
    throw new Error("Invalid job type. Use 1–128 ASCII letters, numbers, dots, hyphens or underscores, starting with a letter.");
  }
}

function lowerCamel(name: string) {
  return name.replace(/^[A-Z]+(?=[A-Z][a-z]|[0-9]|$)|^[A-Z]/, value => value.toLowerCase());
}

/** Validate the complete payload contract before publishing an editable job file. */
export function jobSource(name: string, type: string, fields: string[]) {
  validateJobName(name);
  validateJobType(type);
  if (!Array.isArray(fields) || fields.length > MAX_JOB_FIELDS) {
    throw new Error(`Provide at most ${MAX_JOB_FIELDS} fields using repeated --field name:type options.`);
  }
  const seen = new Set<string>();
  const lines = fields.map(field => {
    const match = /^([a-zA-Z][a-zA-Z0-9_]{0,63}):(string|text|integer|number|boolean)([?])?/.exec(field);
    if (!match || match[0] !== field) throw new Error("Invalid job field. Use name:string|text|integer|number|boolean with an optional trailing ?.");
    const key = match[1]!;
    if (["__proto__", "constructor", "prototype"].includes(key) || seen.has(key)) throw new Error("Unsafe or duplicate job field name.");
    seen.add(key);
    const expression = expressions[match[2]! as keyof typeof expressions];
    return `  ${key}: ${match[3] ? `jobSchema.optional(${expression})` : expression},`;
  });
  const identifier = lowerCamel(name);
  const exportName = `${identifier}Job`;
  const source = `import { defineJob, type JobContext } from "bundle/src/queue/worker.ts";
import { schema as jobSchema, type Infer as InferJob } from "bundle/src/validation/schema.ts";

const payloadSchema = jobSchema.object({
${lines.join(String.fromCharCode(10))}
});

export type ${name}Payload = InferJob<typeof payloadSchema>;

// Fail closed until the application supplies the real idempotent behavior.
export const ${exportName} = defineJob(payloadSchema, async (payload: ${name}Payload, context: JobContext) => {
  void payload;
  void context;
  throw new Error("TODO: Implement ${name} before processing this job.");
});
`;
  if (Buffer.byteLength(source, "utf8") > MAX_JOB_SOURCE_BYTES) throw new Error(`Generated job source exceeds ${MAX_JOB_SOURCE_BYTES} bytes; use fewer or shorter fields.`);
  return { source, exportName };
}

export function jobRegistration(name: string, type: string) {
  validateJobName(name);
  validateJobType(type);
  const exportName = `${lowerCamel(name)}Job`;
  return {
    import: `import { ${exportName} } from "./${name}.ts";`,
    entry: `"${type}": ${exportName},`,
  };
}

export async function generateJob(root: string, name: string, type: string, fields: string[]) {
  const { source } = jobSource(name, type, fields);
  const registration = jobRegistration(name, type);
  const created = await generateSource(root, name, "job", () => source);
  return {
    created,
    type,
    registration,
    next: "Implement handler, then add both registration lines to src/jobs/registry.ts.",
  };
}
