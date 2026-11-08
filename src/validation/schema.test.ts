import { expect, test } from "bun:test";
import { schema, MAX_ISSUES, type Infer } from "./schema.ts";

function issues(validator: { safeParse(input: unknown): unknown }, input: unknown) {
  const result = validator.safeParse(input) as { success: boolean; issues: unknown[] };
  expect(result.success).toBe(false);
  return result.issues;
}

test("strings validate after trimming without coercion or stateful regex behavior", () => {
  const value = schema.string({ trim: true, min: 2, max: 4, pattern: /^[a-z]+$/g });
  for (let i = 0; i < 3; i++) expect(value.safeParse(" ab ")).toEqual({ success: true, data: "ab" });
  for (const input of [undefined, null, 123, true, {}, []]) expect(issues(value, input)).toEqual([{ path: [], code: "invalid_type" }]);
  expect(issues(value, " ")).toEqual([{ path: [], code: "too_small" }, { path: [], code: "invalid_pattern" }]);
  expect(issues(value, "abcde")).toEqual([{ path: [], code: "too_big" }]);
  expect(issues(value, "AB")).toEqual([{ path: [], code: "invalid_pattern" }]);
  const sticky = schema.string({ pattern: /a/y });
  expect(issues(sticky, "ba")).toEqual([{ path: [], code: "invalid_pattern" }]);
  for (let i = 0; i < 3; i++) expect(sticky.safeParse("a")).toEqual({ success: true, data: "a" });
  expect(schema.string({ max: 0 }).safeParse("")).toEqual({ success: true, data: "" });
});

test("numbers are finite, optionally integral and bounded; primitives remain strict", () => {
  const value = schema.number({ integer: true, min: 1, max: 3 });
  expect(value.safeParse(2)).toEqual({ success: true, data: 2 });
  for (const input of [NaN, Infinity, -Infinity]) expect(issues(schema.number(), input)).toEqual([{ path: [], code: "not_finite" }]);
  expect(issues(value, 1.5)).toEqual([{ path: [], code: "not_integer" }]);
  expect(issues(value, 0)).toEqual([{ path: [], code: "too_small" }]);
  expect(issues(value, 4)).toEqual([{ path: [], code: "too_big" }]);
  expect(issues(value, "2")).toEqual([{ path: [], code: "invalid_type" }]);
  expect(schema.boolean().safeParse(false)).toEqual({ success: true, data: false });
  expect(issues(schema.boolean(), 0)).toEqual([{ path: [], code: "invalid_type" }]);
  for (const literal of ["yes", 3, true, null] as const) expect(schema.literal(literal).safeParse(literal)).toEqual({ success: true, data: literal });
  expect(issues(schema.literal("yes"), "no")).toEqual([{ path: [], code: "invalid_literal" }]);
  expect(schema.enum(["a", "b"]).safeParse("b")).toEqual({ success: true, data: "b" });
  expect(issues(schema.enum(["a", "b"]), "secret")).toEqual([{ path: [], code: "invalid_enum" }]);
});

test("objects infer required/optional outputs and arrays compose nested paths in schema order", () => {
  const value = schema.object({
    name: schema.string({ trim: true, min: 1 }),
    enabled: schema.optional(schema.boolean()),
    rows: schema.array(schema.object({ count: schema.number({ integer: true }) }), { min: 1, max: 2 }),
  });
  type Output = Infer<typeof value>;
  const expected: Output = { name: "Ada", rows: [{ count: 2 }] };
  // @ts-expect-error name is required
  const missing: Output = { rows: [] };
  // @ts-expect-error optional fields still have a checked type
  const wrong: Output = { ...expected, enabled: "yes" };
  expect(value.safeParse({ name: " Ada ", rows: [{ count: 2 }] })).toEqual({ success: true, data: expected });
  expect(value.safeParse({ ...expected, enabled: false })).toEqual({ success: true, data: { ...expected, enabled: false } });
  expect(value.safeParse({ ...expected, enabled: undefined })).toEqual({ success: true, data: { ...expected, enabled: undefined } });
  expect(issues(value, { rows: [{ count: "private" }, {}], name: "", extra: "secret" })).toEqual([
    { path: ["name"], code: "too_small" },
    { path: ["rows", 0, "count"], code: "invalid_type" },
    { path: ["rows", 1, "count"], code: "invalid_type" },
    { path: [], code: "unknown_key" },
  ]);
  expect(issues(value, null)).toEqual([{ path: [], code: "invalid_type" }]);
  expect(issues(schema.object({}), Object.setPrototypeOf([], null))).toEqual([{ path: [], code: "invalid_type" }]);
  expect(issues(schema.array(schema.boolean(), { min: 1 }), [])).toEqual([{ path: [], code: "too_small" }]);
  expect(issues(schema.array(schema.boolean(), { max: 0 }), [true])).toEqual([{ path: [], code: "too_big" }]);
  expect(issues(schema.array(schema.boolean()), {})).toEqual([{ path: [], code: "invalid_type" }]);
});

test("issues are bounded globally, deterministic, detached and contain only safe paths/codes", () => {
  const value = schema.object({ rows: schema.array(schema.string(), { max: 2 }) });
  const input = { rows: Array(10000).fill("secret").map(() => ({ password: "SENSITIVE" })) };
  const first = issues(value, input);
  expect(first).toHaveLength(MAX_ISSUES);
  expect(first[0]).toEqual({ path: ["rows"], code: "too_big" });
  expect(first.at(-1)).toEqual({ path: ["rows", 18], code: "invalid_type" });
  expect(issues(value, input)).toEqual(first);
  const unknown = issues(schema.object({}), JSON.parse('{"SENSITIVE":{"password":"SENSITIVE"}}'));
  expect(unknown).toEqual([{ path: [], code: "unknown_key" }]);
  for (const issue of [...first, ...unknown] as Record<string, unknown>[]) expect(Object.keys(issue)).toEqual(["path", "code"]);
  expect(JSON.stringify([...first, ...unknown])).not.toContain("SENSITIVE");
  (first[0] as { path: string[] }).path.push("tampered");
  expect(issues(value, input)[0]).toEqual({ path: ["rows"], code: "too_big" });
});

test("input accessors, coercion hooks, prototypes and overridden methods never execute", () => {
  let calls = 0;
  const hook = () => { calls++; throw new Error("SENSITIVE"); };
  const value = schema.object({ body: schema.string({ trim: true }) });
  expect(issues(value, Object.defineProperty({}, "body", { enumerable: true, get: hook }))).toEqual([{ path: ["body"], code: "invalid_type" }]);
  issues(schema.string(), { toString: hook, valueOf: hook });
  issues(value, Object.create({ body: "inherited" }));
  const array = ["ok"];
  Object.defineProperty(array, "0", { get: hook });
  issues(schema.array(schema.string()), array);
  expect(calls).toBe(0);
});

test("proxies are rejected without executing their traps, including nested proxies", () => {
  let calls = 0;
  const trap = () => { calls++; throw new Error("SENSITIVE"); };
  const traps = { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap };
  const object = new Proxy({}, traps);
  const array = new Proxy([], traps);
  expect(issues(schema.object({}), object)).toEqual([{ path: [], code: "invalid_type" }]);
  expect(issues(schema.array(schema.string()), array)).toEqual([{ path: [], code: "invalid_type" }]);
  expect(issues(schema.object({ nested: schema.object({}) }), { nested: object })).toEqual([{ path: ["nested"], code: "invalid_type" }]);
  expect(issues(schema.array(schema.array(schema.string())), [array])).toEqual([{ path: [0], code: "invalid_type" }]);
  expect(calls).toBe(0);
});

test("construction rejects invalid options and foreign schemas with safe fixed errors", () => {
  const invalid = [
    () => schema.string({ min: -1 }), () => schema.string({ max: 1.5 }),
    () => schema.string({ min: 3, max: 2 }), () => schema.string({ min: Infinity }),
    () => schema.string({ trim: "SENSITIVE" } as never), () => schema.string({ pattern: "SENSITIVE" } as never),
    () => schema.string({ pattern: Object.create(RegExp.prototype) }),
    () => schema.string({ typo: true } as never), () => schema.string(null as never),
    () => schema.number({ min: NaN }), () => schema.number({ max: Infinity }),
    () => schema.number({ min: 2, max: 1 }), () => schema.number({ integer: 1 } as never),
    () => schema.number({ finite: false } as never),
    () => schema.array(schema.string(), { max: Number.MAX_SAFE_INTEGER + 1 }),
    () => schema.array(schema.string(), { min: -1 }), () => schema.array(schema.string(), { min: 2, max: 1 }),
    () => schema.array({ safeParse() { throw new Error("SENSITIVE"); } } as never),
    () => schema.optional({} as never), () => schema.object({ body: {} } as never),
    () => schema.object(null as never), () => schema.object([] as never),
    () => schema.literal({} as never), () => schema.literal(undefined as never), () => schema.literal(Infinity),
    () => schema.enum([] as never), () => schema.enum(["a", "a"]), () => schema.enum([1] as never),
  ];
  for (const construct of invalid) expect(construct).toThrow("Invalid schema configuration");
});

test("schema definitions and options are snapshotted; outputs use safe own properties", () => {
  const options = { min: 1, pattern: /^a$/g };
  const text = schema.string(options);
  options.min = 9; options.pattern.compile("b");
  expect(text.safeParse("a")).toEqual({ success: true, data: "a" });
  const shape = { body: text };
  const value = schema.object(shape);
  shape.body = schema.string({ min: 10 });
  expect(value.safeParse({ body: "a" })).toEqual({ success: true, data: { body: "a" } });
  const special = schema.object({ ["__proto__"]: schema.string() });
  const result = special.safeParse(JSON.parse('{"__proto__":"safe"}'));
  expect(result.success).toBe(true);
  if (result.success) { expect(Object.getPrototypeOf(result.data)).toBe(Object.prototype); expect(Object.hasOwn(result.data, "__proto__")).toBe(true); }
});

test("nullable accepts only explicit null or the child output without coercion", () => {
  const value = schema.nullable(schema.string({ trim: true, min: 2 }));
  const typed: Infer<typeof value> = null;
  const text: Infer<typeof value> = "ab";
  // @ts-expect-error Nullable output retains the child type.
  const wrong: Infer<typeof value> = 2;
  // @ts-expect-error Nullable does not imply optional.
  const missing: Infer<typeof value> = undefined;
  expect(value.safeParse(typed)).toEqual({ success: true, data: null });
  expect(value.safeParse(" ab ")).toEqual({ success: true, data: text });
  expect(issues(value, " ")).toEqual([{ path: [], code: "too_small" }]);
  let calls = 0;
  const hook = () => { calls++; throw new Error("SENSITIVE"); };
  for (const input of [undefined, 2, false, [], { toString: hook, valueOf: hook }]) {
    expect(issues(value, input)).toEqual([{ path: [], code: "invalid_type" }]);
  }
  expect(calls).toBe(0);
  expect(schema.nullable(schema.number({ integer: true })).safeParse(0)).toEqual({ success: true, data: 0 });
  expect(issues(schema.nullable(schema.number({ integer: true })), 1.5)).toEqual([{ path: [], code: "not_integer" }]);
  expect(schema.nullable(schema.boolean()).safeParse(false)).toEqual({ success: true, data: false });
});

test("nested optional nullable fields infer checked outputs and preserve value-free issue paths", () => {
  const value = schema.object({ rows: schema.array(schema.object({
    required: schema.nullable(schema.string()),
    note: schema.optional(schema.nullable(schema.string({ trim: true }))),
    details: schema.optional(schema.nullable(schema.object({
      label: schema.string({ trim: true }), score: schema.optional(schema.nullable(schema.number())),
    }))),
  })) });
  type Output = Infer<typeof value>;
  const expected: Output = { rows: [{ required: null }, { required: "ok", note: null, details: null }, { required: "ok", note: "trimmed", details: { label: "label", score: null } }] };
  // @ts-expect-error Nullable fields remain required unless wrapped in optional.
  const missing: Output = { rows: [{}] };
  // @ts-expect-error Nested optional nullable fields retain the child type.
  const wrong: Output = { rows: [{ required: null, note: 1 }] };
  // @ts-expect-error Optional nullable objects retain required, typed child fields.
  const wrongNested: Output = { rows: [{ required: null, details: { label: 1 } }] };
  // @ts-expect-error Optional nullable objects still require the child's required fields.
  const missingNested: Output = { rows: [{ required: null, details: {} }] };
  // @ts-expect-error Nested child output does not degrade to any.
  const narrowed: number = expected.rows[0]!.required;
  expect(value.safeParse({ rows: [{ required: null }, { required: "ok", note: null, details: null }, { required: "ok", note: " trimmed ", details: { label: " label ", score: null } }] })).toEqual({ success: true, data: expected });
  expect(issues(value, { rows: [{ required: "ok", note: { secret: "SENSITIVE" } }, {}] })).toEqual([
    { path: ["rows", 0, "note"], code: "invalid_type" },
    { path: ["rows", 1, "required"], code: "invalid_type" },
  ]);
});

test("nullable snapshots child definitions and returns detached nested outputs", () => {
  const options = { min: 1 };
  const shape = { name: schema.string(options) };
  const value = schema.nullable(schema.object(shape));
  options.min = 10;
  shape.name = schema.string({ min: 10 });
  const input = { name: "a" };
  const result = value.safeParse(input);
  expect(result).toEqual({ success: true, data: { name: "a" } });
  if (result.success && result.data) result.data.name = "changed";
  expect(input).toEqual({ name: "a" });
  expect(value.safeParse(input)).toEqual({ success: true, data: { name: "a" } });
  expect(Object.isFrozen(value)).toBe(true);
});

test("nullable rejects foreign or invalid children before parsing, without invoking hooks", () => {
  let calls = 0;
  const trap = () => { calls++; throw new Error("SENSITIVE"); };
  const foreign = { safeParse: trap };
  for (const child of [undefined, null, 1, {}, foreign, Object.create(schema.string()), new Proxy(schema.string(), { get: trap })]) {
    expect(() => schema.nullable(child as never)).toThrow("Invalid schema configuration");
  }
  expect(calls).toBe(0);
});
