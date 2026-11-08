import { types } from "node:util";

/** Dependency-free validation of data, with bounded, value-free diagnostics. */
export const MAX_ISSUES = 20;
export type IssueCode = "invalid_type" | "too_small" | "too_big" | "invalid_pattern"
  | "not_finite" | "not_integer" | "invalid_literal" | "invalid_enum" | "unknown_key";
export type ValidationIssue = { path: (string | number)[]; code: IssueCode };
export type ParseResult<T> = { success: true; data: T } | { success: false; issues: ValidationIssue[] };
export interface Schema<T> { safeParse(input: unknown): ParseResult<T> }
export interface OptionalSchema<T> extends Schema<T | undefined> { readonly optional: true }
export type Infer<S extends Schema<unknown>> = S extends Schema<infer T> ? T : never;
type Shape = Record<string, Schema<unknown>>;
type ObjectOutput<S extends Shape> = {
  [K in keyof S as S[K] extends OptionalSchema<unknown> ? never : K]: Infer<S[K]>
} & {
  [K in keyof S as S[K] extends OptionalSchema<unknown> ? K : never]?: Infer<S[K]>
};
type Path = (string | number)[];
type Parser = (input: unknown, path: Path, issues: ValidationIssue[]) => unknown;
const parsers = new WeakMap<object, Parser>();
const optionals = new WeakSet<object>();
const invalid = () => new Error("Invalid schema configuration");
function issue(issues: ValidationIssue[], path: Path, code: IssueCode) {
  if (issues.length < MAX_ISSUES) issues.push({ path: [...path], code });
}
function make<T>(parse: Parser): Schema<T> {
  const value: Schema<T> = Object.freeze({
    safeParse(input: unknown): ParseResult<T> {
      const issues: ValidationIssue[] = [];
      let data: unknown;
      try { data = parse(input, [], issues); }
      catch { issue(issues, [], "invalid_type"); }
      return issues.length ? { success: false, issues } : { success: true, data: data as T };
    },
  });
  parsers.set(value, parse);
  return value;
}
function parser(value: Schema<unknown>): Parser {
  const parse = value && parsers.get(value);
  if (!parse) throw invalid();
  return parse;
}
function plain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
/** Descriptors avoid executing accessors, including on sparse arrays. */
function own(value: object, key: PropertyKey): { present: boolean; accessor: boolean; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return { present: !!descriptor, accessor: !!descriptor && !("value" in descriptor), value: descriptor?.value };
}
function options(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!plain(value)) throw invalid();
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) throw invalid();
    const entry = own(value, key);
    if (entry.accessor) throw invalid();
    result[key] = entry.value;
  }
  return result;
}
function bounds(value: Record<string, unknown>, length: boolean) {
  for (const key of ["min", "max"]) {
    const limit = value[key];
    if (limit !== undefined && (typeof limit !== "number" || !Number.isFinite(limit)
      || (length && (!Number.isSafeInteger(limit) || limit < 0)))) throw invalid();
  }
  if (typeof value.min === "number" && typeof value.max === "number" && value.min > value.max) throw invalid();
}
function flag(value: Record<string, unknown>, key: string) {
  if (value[key] !== undefined && typeof value[key] !== "boolean") throw invalid();
}
function checkBounds(size: number, min: number | undefined, max: number | undefined, path: Path, issues: ValidationIssue[]) {
  if (min !== undefined && size < min) issue(issues, path, "too_small");
  if (max !== undefined && size > max) issue(issues, path, "too_big");
}
export interface StringOptions { min?: number; max?: number; trim?: boolean; pattern?: RegExp }
export interface NumberOptions { min?: number; max?: number; integer?: boolean; finite?: true }
export interface ArrayOptions { min?: number; max?: number }

function string(config: StringOptions = {}): Schema<string> {
  const opts = options(config, ["min", "max", "trim", "pattern"]);
  bounds(opts, true); flag(opts, "trim");
  let pattern: RegExp | undefined;
  if (opts.pattern !== undefined) {
    if (types.isProxy(opts.pattern) || !types.isRegExp(opts.pattern)) throw invalid();
    // Clone at construction; never call an overridden exec or share caller state.
    const source = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")!.get!.call(opts.pattern) as string;
    const flags = ["hasIndices", "global", "ignoreCase", "multiline", "dotAll", "unicode", "unicodeSets", "sticky"]
      .map((name, index) => Object.getOwnPropertyDescriptor(RegExp.prototype, name)?.get?.call(opts.pattern) ? ["d", "g", "i", "m", "s", "u", "v", "y"][index] : "").join("");
    pattern = new RegExp(source, flags);
  }
  const { min, max, trim } = opts as StringOptions;
  return make((input, path, issues) => {
    if (typeof input !== "string") { issue(issues, path, "invalid_type"); return; }
    const output = trim ? input.trim() : input;
    checkBounds(output.length, min, max, path, issues);
    if (pattern) {
      pattern.lastIndex = 0;
      if (RegExp.prototype.exec.call(pattern, output) === null) issue(issues, path, "invalid_pattern");
    }
    return output;
  });
}
function number(config: NumberOptions = {}): Schema<number> {
  const opts = options(config, ["min", "max", "integer", "finite"]);
  bounds(opts, false); flag(opts, "integer");
  if (opts.finite !== undefined && opts.finite !== true) throw invalid();
  const { min, max, integer } = opts as NumberOptions;
  return make((input, path, issues) => {
    if (typeof input !== "number") { issue(issues, path, "invalid_type"); return; }
    if (!Number.isFinite(input)) { issue(issues, path, "not_finite"); return; }
    if (integer && !Number.isInteger(input)) issue(issues, path, "not_integer");
    checkBounds(input, min, max, path, issues);
    return input;
  });
}
function boolean(): Schema<boolean> {
  return make((input, path, issues) => {
    if (typeof input !== "boolean") issue(issues, path, "invalid_type");
    return input;
  });
}
type Literal = string | number | boolean | null;
function literal<const T extends Literal>(value: T): Schema<T> {
  if (value !== null && !["string", "number", "boolean"].includes(typeof value)
    || typeof value === "number" && !Number.isFinite(value)) throw invalid();
  return make((input, path, issues) => {
    if (input !== value) issue(issues, path, "invalid_literal");
    return input;
  });
}
function enumeration<const T extends readonly [string, ...string[]]>(values: T): Schema<T[number]> {
  if (types.isProxy(values) || !Array.isArray(values) || !values.length) throw invalid();
  const entries: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const entry = own(values, String(index));
    if (entry.accessor || typeof entry.value !== "string" || entries.includes(entry.value)) throw invalid();
    entries.push(entry.value);
  }
  const allowed = new Set(entries);
  return make((input, path, issues) => {
    if (typeof input !== "string" || !allowed.has(input)) issue(issues, path, "invalid_enum");
    return input;
  });
}
/** Accept explicit null; snapshot and delegate every other input to the child parser. */
function nullable<T>(value: Schema<T>): Schema<T | null> {
  const parse = parser(value);
  return make<T | null>((input, path, issues) => input === null ? null : parse(input, path, issues));
}
function optional<T>(value: Schema<T>): OptionalSchema<T> {
  const parse = parser(value);
  const base = make<T | undefined>((input, path, issues) => input === undefined ? undefined : parse(input, path, issues));
  const output = Object.freeze({ ...base, optional: true as const });
  parsers.set(output, parsers.get(base)!);
  optionals.add(output);
  return output;
}
function array<T>(value: Schema<T>, config: ArrayOptions = {}): Schema<T[]> {
  const parse = parser(value);
  const opts = options(config, ["min", "max"]);
  bounds(opts, true);
  const { min, max } = opts as ArrayOptions;
  return make((input, path, issues) => {
    if (types.isProxy(input) || !Array.isArray(input)) { issue(issues, path, "invalid_type"); return; }
    checkBounds(input.length, min, max, path, issues);
    const output: unknown[] = [];
    for (let index = 0; index < input.length && issues.length < MAX_ISSUES; index++) {
      const entry = own(input, String(index));
      const next = [...path, index];
      if (entry.accessor) issue(issues, next, "invalid_type");
      else output.push(parse(entry.value, next, issues));
    }
    return output;
  });
}
function object<const S extends Shape>(shape: S): Schema<ObjectOutput<S>> {
  if (!plain(shape)) throw invalid();
  const fields = Reflect.ownKeys(shape).map(key => {
    if (typeof key !== "string") throw invalid();
    const entry = own(shape, key);
    if (entry.accessor) throw invalid();
    const value = entry.value as Schema<unknown>;
    return { key, parse: parser(value), optional: optionals.has(value) };
  });
  const keys = new Set(fields.map(field => field.key));
  return make((input, path, issues) => {
    if (!plain(input)) { issue(issues, path, "invalid_type"); return; }
    const output: Record<string, unknown> = {};
    for (const field of fields) {
      if (issues.length >= MAX_ISSUES) break;
      const entry = own(input, field.key);
      const next = [...path, field.key];
      if (entry.accessor) { issue(issues, next, "invalid_type"); continue; }
      const data = field.parse(entry.value, next, issues);
      if (entry.present || !field.optional) Object.defineProperty(output, field.key, { value: data, enumerable: true, writable: true, configurable: true });
    }
    // One parent-level issue avoids exposing attacker-controlled property names.
    if (issues.length < MAX_ISSUES && Reflect.ownKeys(input).some(key => typeof key !== "string" || !keys.has(key))) issue(issues, path, "unknown_key");
    return output;
  });
}
export const schema = Object.freeze({ string, number, boolean, literal, enum: enumeration, array, object, optional, nullable });
