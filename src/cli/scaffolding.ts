import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { Command } from "commander";
import { defineProviders } from "../console/providers.ts";
import { loadApplicationCommands } from "../console/loader.ts";
import { encodeJob } from "../queue/store.ts";
import { validateJobMiddlewareReferences } from "../queue/middleware-definitions.ts";
import { hasExportedModelClass } from "./model-preflight.ts";
import { defineEvents, type EventDefinitions } from "../events/definitions.ts";
import { checkedRouteFile } from "../http/route-definitions.ts";
import { renderModel, renderSeeder } from "../database/generators.ts";
import { validateHttpTestPath } from "../http/testing.ts";

export type TypeScriptScaffoldKind = "class" | "interface" | "enum" | "trait";

export interface GenerateTypeScriptOptions {
  /** Allow slash-separated directory namespaces, not TypeScript namespace declarations. Defaults to true. */
  namespaces?: boolean;
}

const directories: Readonly<Record<TypeScriptScaffoldKind, string>> = Object.freeze({
  class: "classes",
  interface: "contracts",
  enum: "enums",
  trait: "traits",
});

/**
 * Built-in, import-free templates. {{name}} is the only substitution token.
 * Published templates may be overridden by trusted project code under stubs/.
 * A trait scaffold is explicitly a TypeScript mixin factory, not a PHP trait.
 */
export const typeScriptTemplates: Readonly<Record<TypeScriptScaffoldKind, string>> = Object.freeze({
  class: `export class {{name}} {
  // Add class members here.
}
`,
  interface: `export interface {{name}} {
  // Add the contract's properties and methods here.
}
`,
  enum: `export enum {{name}} {
  // Add named enum members here.
}
`,
  trait: `// TypeScript has no PHP traits. This mixin factory returns a subclass of Base.
// Apply it explicitly: class Example extends {{name}}(BaseClass) {}.
// It uses single inheritance, not PHP trait composition or conflict-resolution rules.
type _BundleConstructor = new (...args: any[]) => object;

export function {{name}}<TBase extends _BundleConstructor>(Base: TBase) {
  return class extends Base {
    // Add shared instance members here.
  };
}
`,
});

// Avoid shadowing common standard-library types, including helpers often needed in generated code.
// Templates deliberately use no imports, and private helpers begin with an underscore so they
// cannot collide with the accepted public PascalCase identifier.
const reservedNames = new Set([
  "AbortSignal", "Array", "ArrayBuffer", "ArrayBufferLike", "ArrayLike", "AsyncDisposable", "AsyncGenerator",
  "AsyncGeneratorFunction", "AsyncIterable", "AsyncIterableIterator", "AsyncIterator", "Awaited",
  "BigInt", "BigInt64Array", "BigUint64Array", "Boolean", "Buffer", "CallableFunction", "Capitalize",
  "ClassDecorator", "Console", "ConstructorParameters", "DataView", "Date", "DecoratorContext",
  "Disposable", "Error", "ErrorConstructor", "ErrorOptions", "EvalError", "Exclude", "Extract",
  "Float16Array", "Float32Array", "Float64Array", "Function", "FunctionConstructor", "Generator",
  "GeneratorFunction", "IArguments", "ImportAttributes", "ImportCallOptions", "ImportMeta",
  "InstanceType", "Int8Array", "Int16Array", "Int32Array", "Intl", "Iterable", "IterableIterator",
  "Iterator", "IteratorObject", "IteratorResult", "JSON", "Lowercase", "Map", "Math",
  "MethodDecorator", "NewableFunction", "NoInfer", "NonNullable", "Number", "Object",
  "Omit", "OmitThisParameter", "Parameters", "Partial", "Pick", "Promise", "PromiseLike",
  "PropertyDecorator", "PropertyDescriptor", "PropertyKey", "Proxy", "RangeError", "Readonly",
  "ReadonlyArray", "ReadonlyMap", "ReadonlySet", "Record", "Reflect", "RegExp", "Required",
  "ReturnType", "Set", "SharedArrayBuffer", "String", "Symbol", "SyntaxError", "TemplateStringsArray",
  "ThisParameterType", "ThisType", "TypeError", "URIError", "Uint8Array", "Uint8ClampedArray",
  "Uint16Array", "Uint32Array", "Uncapitalize", "Uppercase", "WeakKey", "WeakMap", "WeakRef", "WeakSet",
]);

function assertKind(kind: TypeScriptScaffoldKind): void {
  if (!Object.hasOwn(directories, kind)) {
    throw new Error("Scaffold kind must be class, interface, enum, or trait.");
  }
}

function nameSegments(name: string, namespaces: boolean): string[] {
  if (typeof name !== "string" || isAbsolute(name) || (!namespaces && name.includes("/"))) {
    throw new Error("Use a PascalCase identifier or allowed slash-separated PascalCase namespaces.");
  }
  const segments = name.split("/");
  for (const segment of segments) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(segment)) {
      throw new Error("Use PascalCase identifiers containing only ASCII letters and numbers; empty segments, extensions, and traversal are not allowed.");
    }
    if (reservedNames.has(segment) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(segment)) {
      throw new Error(`Reserved or built-in type name: ${segment}. Choose a domain-specific name.`);
    }
  }
  return segments;
}

/** Render one built-in template using an unqualified, validated public identifier. */
export function renderTypeScriptTemplate(kind: TypeScriptScaffoldKind, name: string): string {
  assertKind(kind);
  nameSegments(name, false);
  return typeScriptTemplates[kind].replaceAll("{{name}}", name);
}

function assertWithinRoot(root: string, target: string): void {
  const path = relative(root, target);
  if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new Error("Scaffold destination escapes the canonical project root.");
  }
}

async function assertDirectory(root: string, path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Scaffold parent must be a directory, not a symlink or file: ${path}`);
  }
  assertWithinRoot(root, await realpath(path));
}

/**
 * Create one import-free TypeScript scaffold without replacing any existing entry.
 * The project root must already exist; a symlinked root is resolved to its canonical path.
 * All destination directory symlinks are rejected, even if they point inside the root.
 * Existing files are never overwritten. Trusted stubs are read from the project root.
 * This does not install any runtime subsystem.
 * Like ordinary filesystem generators, the project tree must not be concurrently renamed
 * by an untrusted process while generating files.
 */
export async function generateTypeScript(
  root: string,
  kind: TypeScriptScaffoldKind,
  name: string,
  options: GenerateTypeScriptOptions = {},
): Promise<string> {
  assertKind(kind);
  if (!options || typeof options !== "object" || Object.keys(options).some(key => key !== "namespaces")
    || (options.namespaces !== undefined && typeof options.namespaces !== "boolean")) {
    throw new Error("Only the optional boolean namespaces option is supported; overwriting is never allowed.");
  }
  const segments = nameSegments(name, options.namespaces ?? true);
  const identifier = segments.at(-1)!;
  return writeScaffold(root, ["src", directories[kind]], segments, ".ts", await renderStub(root, kind, identifier));
}

export interface ExecutableScaffoldOptions {
  /** Names and aliases registered by the host program, evaluated at invocation time. */
  reservedCommandNames?: Iterable<string>;
  commandName?: string;
  unit?: boolean;
}

/** Commands and config are top-level because their respective loaders are non-recursive. */
export async function generateExecutableScaffold(root: string, kind: "command" | "test" | "exception" | "config", name: string, options: ExecutableScaffoldOptions = {}): Promise<string> {
  if (!["command", "test", "exception", "config"].includes(kind)) throw new Error("Unsupported executable scaffold kind.");
  const segments = nameSegments(name, kind !== "command" && kind !== "config");
  const identifier = segments.at(-1)!;
  const commandName = options.commandName ?? identifier.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  if (kind === "command") {
    if (!/^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)*$/.test(commandName)) throw new Error("Invalid command name.");
    if (commandName === "help" || [...(options.reservedCommandNames ?? [])].includes(commandName)) {
      throw new Error(`Application command ${commandName} conflicts with an existing or reserved command.`);
    }
    // Reject symlinked ancestors before importing any project modules. Missing directories
    // are left untouched; writeScaffold creates them only after all preflights pass.
    const canonicalRoot = await realpath(root);
    await assertDirectory(canonicalRoot, canonicalRoot);
    let directory = canonicalRoot;
    let exists = true;
    for (const part of ["src", "commands"]) {
      directory = join(directory, part);
      try {
        await assertDirectory(canonicalRoot, directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        exists = false;
        break;
      }
    }
    if (exists) {
      // The loader validates actual exported identities (not filenames) and detects
      // existing conflicts. It imports trusted modules but never invokes their handlers.
      const definitions = await loadApplicationCommands(new Command(), { root: canonicalRoot });
      if (definitions.some(definition => definition.name === commandName)) {
        throw new Error(`Application command ${commandName} conflicts with an existing or reserved command.`);
      }
    }
  }
  const content = await renderStub(root, kind, identifier, commandName);
  const directory = kind === "command" ? ["src", "commands"] : kind === "exception" ? ["src", "exceptions"] : kind === "config" ? ["config"] : options.unit ? ["tests", "Unit"] : ["tests"];
  return writeScaffold(root, directory, segments, kind === "test" ? ".test.ts" : ".ts", content);
}

/** Generate a native test that owns a real application listener only when the test runs. */
export async function generateHttpTestScaffold(root: string, name: string, path: string): Promise<string> {
  validateHttpTestPath(path);
  const segments = nameSegments(name, true);
  for (let i = 0; i < segments.length; i++) {
    if (Buffer.byteLength(segments[i]! + (i === segments.length - 1 ? ".test.ts" : "")) > 255) throw new Error("HTTP test filename exceeds 255 bytes.");
  }
  const base = ["tests", "Feature"];
  const from = join(root, ...base, ...segments.slice(0, -1));
  let runtimeImport = relative(from, join(root, "src/http/testing.ts")).split(sep).join("/");
  if (!runtimeImport.startsWith(".")) runtimeImport = `./${runtimeImport}`;
  const content = await renderStub(root, "http-test", segments.at(-1)!, "", runtimeImport, "", "", "", "", "", {
    rootUrl: "../".repeat(base.length + segments.length - 1), requestPath: JSON.stringify(path),
  });
  return writeScaffold(root, base, segments, ".test.ts", content);
}

export type HttpScaffoldKind = "controller" | "middleware" | "request" | "resource" | "rule" | "policy";
const httpDirectories: Readonly<Record<HttpScaffoldKind, string>> = {
  controller: "controllers", middleware: "middleware", request: "requests", resource: "resources", rule: "rules", policy: "policies",
};
const httpModules: Readonly<Record<HttpScaffoldKind, string>> = {
  controller: "router", middleware: "router", request: "validation", resource: "resources", rule: "validation", policy: "authorization",
};

/** Generate code that imports the runtime in this project; names denote directories, not namespaces. */
export interface HttpScaffoldOptions { resource?: boolean; model?: string }

export async function generateHttpScaffold(root: string, kind: HttpScaffoldKind, name: string, options: HttpScaffoldOptions = {}): Promise<string> {
  if (!Object.hasOwn(httpDirectories, kind)) throw new Error("Unsupported HTTP scaffold kind.");
  if (!options || typeof options !== "object" || Object.keys(options).some(key => key !== "resource" && key !== "model") || (options.resource !== undefined && typeof options.resource !== "boolean") || (options.model !== undefined && typeof options.model !== "string")) throw new Error("Invalid HTTP scaffold options.");
  if (kind !== "controller" && (options.resource !== undefined || options.model !== undefined)) throw new Error("Resource model options are only supported for controllers.");
  if (Boolean(options.resource) !== (options.model !== undefined)) throw new Error("--resource and --model must be used together.");
  const segments = nameSegments(name, true);
  if (["Request", "Response"].includes(segments.at(-1)!)) throw new Error("Reserved HTTP type name.");
  const base = ["src", "http", httpDirectories[kind]];
  const canonicalRoot = await realpath(root);
  const from = join(canonicalRoot, ...base, ...segments.slice(0, -1));
  const resource = options.resource === true;
  const modelPath = resource ? await preflightModel(canonicalRoot, options.model!) : "";
  let runtimeImport = relative(from, join(canonicalRoot, "src", "http", `${resource ? "model-resource" : httpModules[kind]}.ts`)).split(sep).join("/");
  if (!runtimeImport.startsWith(".")) runtimeImport = `./${runtimeImport}`;
  let contextImport = relative(from, join(canonicalRoot, "src", "http", "router.ts")).split(sep).join("/");
  if (!contextImport.startsWith(".")) contextImport = `./${contextImport}`;
  let modelImport = resource ? relative(from, modelPath).split(sep).join("/") : "";
  if (modelImport && !modelImport.startsWith(".")) modelImport = `./${modelImport}`;
  const content = await renderStub(root, resource ? "controller-resource" : kind, segments.at(-1)!, "", runtimeImport, "", options.model ?? "", modelImport, "", contextImport);
  return writeScaffold(root, base, segments, ".ts", content);
}

export type EventScaffoldKind = "event" | "listener";

/** Generate an event helper or class listener without registering either automatically. */
export async function generateEventScaffold(root: string, kind: EventScaffoldKind, name: string): Promise<string> {
  if (kind !== "event" && kind !== "listener") throw new Error("Unsupported event scaffold kind.");
  const segments = nameSegments(name, true);
  const identifier = segments.at(-1)!;
  const eventName = segments.map(segment => segment.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()).join(".");
  if (kind === "event" && eventName.length > 256) throw new Error("Event name exceeds 256 characters.");
  const base = kind === "event" ? ["src", "events"] : ["src", "listeners"];
  const from = join(root, ...base, ...segments.slice(0, -1));
  let runtimeImport = relative(from, join(root, "src", "events", "bus.ts")).split(sep).join("/");
  if (!runtimeImport.startsWith(".")) runtimeImport = `./${runtimeImport}`;
  const content = await renderStub(root, kind, identifier, "", runtimeImport, eventName);
  return writeScaffold(root, base, segments, ".ts", content);
}

/** Plan every registration before publishing any missing listener. */
export async function generateEventListenerScaffolds(root: string, input: EventDefinitions): Promise<{ created: string[]; existing: string[] }> {
  const definitions = defineEvents(input);
  if (definitions.length > 128 || definitions.reduce((sum, item) => sum + item.listeners.length, 0) > 256) throw new Error("Too many event registrations.");
  const canonical = await realpath(root);
  const planned = new Map<string, { segments: string[]; content: string }>();
  const existing = new Set<string>();
  for (const definition of definitions) for (const ref of definition.listeners) {
    let current = canonical;
    let absent = false;
    const parts = ref.module.split("/");
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      if (absent) continue;
      try { await assertDirectory(canonical, current); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") absent = true; else throw error; }
    }
    if (!absent) {
      try {
        await lstat(join(current, parts.at(-1)!));
        await checkedRouteFile(canonical, ref.module);
        existing.add(ref.module);
        continue;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    if (!ref.module.startsWith("src/listeners/") || ref.method !== "handle") throw new Error("Unsupported missing listener.");
    const segments = nameSegments(ref.module.slice("src/listeners/".length, -3), true);
    if (ref.export !== segments.at(-1)) throw new Error("Unsupported listener export.");
    if (!planned.has(ref.module)) {
      const from = join(canonical, "src", "listeners", ...segments.slice(0, -1));
      let runtimeImport = relative(from, join(canonical, "src", "events", "bus.ts")).split(sep).join("/");
      if (!runtimeImport.startsWith(".")) runtimeImport = `./${runtimeImport}`;
      const content = await renderStub(canonical, "listener", ref.export, "", runtimeImport);
      planned.set(ref.module, { segments, content });
    }
  }
  const created: string[] = [];
  for (const [path, plan] of planned) {
    await writeScaffold(canonical, ["src", "listeners"], plan.segments, ".ts", plan.content);
    created.push(path);
  }
  return { created, existing: [...existing] };
}

async function preflightModel(root: string, model: string): Promise<string> {
  nameSegments(model, false);
  const canonicalRoot = await realpath(root);
  await assertDirectory(canonicalRoot, join(canonicalRoot, "src"));
  await assertDirectory(canonicalRoot, join(canonicalRoot, "src", "models"));
  const path = join(canonicalRoot, "src", "models", `${model}.ts`);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) throw new Error("Model must be a bounded regular single-link source file.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let source: string;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > 1024 * 1024 || opened.ino !== info.ino || opened.dev !== info.dev) throw new Error("Unsafe model source.");
    source = await handle.readFile("utf8");
  } finally { await handle.close(); }
  if (!hasExportedModelClass(source, model)) throw new Error("Model must export its named class and a default schema.");
  return path;
}

/** Plan all selected code outputs before any exclusive creation; never imports a model. */
export async function generateModelScaffolds(root: string, name: string, options: { factory?: boolean; seed?: boolean } = {}): Promise<{ created: string; factory?: string; seeder?: string }> {
  if (!options || typeof options !== "object" || Object.keys(options).some(key => key !== "factory" && key !== "seed")
    || (options.factory !== undefined && typeof options.factory !== "boolean") || (options.seed !== undefined && typeof options.seed !== "boolean")) {
    throw new Error("Only boolean factory/seed options are supported.");
  }
  const factory = options.factory === true;
  const seed = options.seed === true;
  const modelContent = renderModel(name);
  // Preserve the model generator's existing name contract rather than the broader
  // generic-scaffold reserved list. Validate every selected filename even when
  // its parent is absent, before rendering stubs or publishing any code.
  const names = [name, ...(seed ? [`${name}Seeder`] : []), ...(factory ? [`${name}Factory`] : [])];
  if (names.some(value => Buffer.byteLength(`${value}.ts`, "utf8") > 255)) throw new Error("Selected model generation filenames must fit 255 bytes.");
  const segments = [name];
  const canonical = await realpath(root);
  await assertDirectory(canonical, canonical);
  const plans: Array<{ key: "created" | "factory" | "seeder"; base: string[]; segments: string[]; content: string }> = [
    { key: "created", base: ["src", "models"], segments, content: modelContent },
  ];
  if (seed) plans.push({ key: "seeder", base: ["database", "seeders"], segments: [`${name}Seeder`], content: renderSeeder(`${name}Seeder`) });
  if (factory) {
    const factoryName = `${name}Factory`;
    const content = await renderStub(canonical, "factory", factoryName, "", "", "", name, `../../src/models/${name}.ts`);
    plans.push({ key: "factory", base: ["database", "factories"], segments: [factoryName], content });
  }
  for (const plan of plans) {
    let parent = canonical;
    let missing = false;
    for (const part of plan.base) {
      parent = join(parent, part);
      try { await assertDirectory(canonical, parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; missing = true; break; }
    }
    if (!missing) {
      try {
        await lstat(join(parent, `${plan.segments[0]}.ts`));
        throw new Error("Model generation destination already exists.");
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  const result: { created: string; factory?: string; seeder?: string } = { created: "" };
  for (const plan of plans) result[plan.key] = await writeScaffold(canonical, plan.base, plan.segments, ".ts", plan.content);
  return result;
}

export type OrmScaffoldKind = "factory" | "cast" | "scope" | "observer";

/** Generate explicit native ORM examples without importing application models. */
export async function generateOrmScaffold(root: string, kind: OrmScaffoldKind, name: string, model?: string): Promise<string> {
  if (!["factory", "cast", "scope", "observer"].includes(kind)) throw new Error("Unsupported ORM scaffold kind.");
  const segments = nameSegments(name, true);
  const base = kind === "factory" ? ["database", "factories"] : ["src", "database", kind === "cast" ? "types" : kind === "scope" ? "scopes" : "observers"];
  let modelImport = "";
  if (kind === "factory") {
    if (typeof model !== "string") throw new Error("Factory requires --model.");
    const path = await preflightModel(root, model);
    const from = join(await realpath(root), ...base, ...segments.slice(0, -1));
    modelImport = relative(from, path).split(sep).join("/");
    if (!modelImport.startsWith(".")) modelImport = `./${modelImport}`;
  } else if (model !== undefined) throw new Error("--model is only supported for factories.");
  const content = await renderStub(root, kind, segments.at(-1)!, "", "", "", model ?? "", modelImport);
  return writeScaffold(root, base, segments, ".ts", content);
}

/** Generate an explicitly registered provider consumed by the runner lifecycle. */
export async function generateProviderScaffold(root: string, name: string): Promise<string> {
  const segments = nameSegments(name, true);
  const base = ["src", "providers"];
  const module = `${base.join("/")}/${segments.join("/")}.ts`;
  const serviceKey = `provider:${segments.join(".")}`;
  defineProviders([{module,export:segments.at(-1)!}]);
  const from = join(root, ...base, ...segments.slice(0, -1));
  let runtimeImport = relative(from, join(root, "src", "console", "providers.ts")).split(sep).join("/");
  if (!runtimeImport.startsWith(".")) runtimeImport = `./${runtimeImport}`;
  const content = await renderStub(root, "provider", segments.at(-1)!, "", runtimeImport, "", "", "", serviceKey);
  return writeScaffold(root, base, segments, ".ts", content);
}

export type DeliveryScaffoldKind = "mail" | "notification";

/** Generate an explicit text-delivery example without sending it. */
export async function generateDeliveryScaffold(root: string, kind: DeliveryScaffoldKind, name: string): Promise<string> {
  if (kind !== "mail" && kind !== "notification") throw new Error("Unsupported delivery scaffold kind.");
  const segments = nameSegments(name, true);
  const base = ["src", kind === "mail" ? "mail" : "notifications"];
  const from = join(root, ...base, ...segments.slice(0, -1));
  const target = kind === "mail" ? ["src", "mail", "mail.ts"] : ["src", "notifications", "notification.ts"];
  let runtimeImport = relative(from, join(root, ...target)).split(sep).join("/");
  if (!runtimeImport.startsWith(".")) runtimeImport = `./${runtimeImport}`;
  const content = await renderStub(root, kind, segments.at(-1)!, "", runtimeImport);
  return writeScaffold(root, base, segments, ".ts", content);
}

/** Generate an example job class without registering or dispatching it. */
export async function generateJobScaffold(root: string, name: string): Promise<string> {
  const segments = nameSegments(name, true);
  // Validate the eventual descriptor before touching files; share the consumer's limits.
  encodeJob({module:`src/jobs/${segments.join("/")}.ts`,export:segments.at(-1)!,method:"handle",payload:null});
  const content = await renderStub(root, "job", segments.at(-1)!);
  return writeScaffold(root, ["src", "jobs"], segments, ".ts", content);
}

/** Generate a pass-through queue middleware function without registering it. */
export async function generateJobMiddlewareScaffold(root: string, name: string): Promise<string> {
  const segments = nameSegments(name, true);
  const base = ["src", "queue", "middleware"];
  validateJobMiddlewareReferences([{module: `${base.join("/")}/${segments.join("/")}.ts`, export: segments.at(-1)!}]);
  const from = join(root, ...base, ...segments.slice(0, -1));
  let runtimeImport = relative(from, join(root, "src", "queue", "middleware.ts")).split(sep).join("/");
  if (!runtimeImport.startsWith(".")) runtimeImport = `./${runtimeImport}`;
  const content = await renderStub(root, "job-middleware", segments.at(-1)!, "", runtimeImport);
  return writeScaffold(root, base, segments, ".ts", content);
}

/** Fixed code-only inventory. Overrides in stubs/<kind>.ts.stub are trusted project code. */
export const scaffoldStubs = Object.freeze({
  ...typeScriptTemplates,
  "http-test": `import { expect, test } from "bun:test";
import { fileURLToPath as _fileURLToPath } from "node:url";
import { withHttpApplication as _withHttpApplication } from "{{runtimeImport}}";

test("{{name}}", async () => {
  const root = _fileURLToPath(new URL("{{rootUrl}}", import.meta.url));
  await _withHttpApplication({ root }, async client => {
    // Select a real application endpoint and customize assertions explicitly.
    const response = await client.request({{requestPath}});
    expect(response.status).toBe(200);
    await response.body?.cancel();
  });
});
`,
  provider: `import type { ApplicationProvider as _ApplicationProvider, ProviderContext as _ProviderContext } from "{{runtimeImport}}";

// Register this class explicitly in root providers.ts. No import-time registration.
export class {{name}} implements _ApplicationProvider {
  private message = "registered";
  register(context: _ProviderContext): void {
    context.container.register("{{serviceKey}}", "singleton", () => this.message);
  }
  boot(context: _ProviderContext): void {
    context.signal.throwIfAborted();
    this.message = "booted";
  }
}
`,
  factory: `import { Factory as _Factory } from "@mikro-orm/seeder";
import type { EntityData as _EntityData } from "@mikro-orm/core";
import { {{modelName}} as _Model } from "{{modelImport}}";

// Supply model-specific attributes explicitly or customize this definition.
export class {{name}} extends _Factory<_Model> {
  readonly model = _Model;
  protected definition(input?: _EntityData<_Model>): _EntityData<_Model> {
    if (!input) throw new Error("Factory attributes are required.");
    return { ...input };
  }
}
`,
  cast: `import { Type as _Type } from "@mikro-orm/core";
import type { EntityProperty as _EntityProperty, Platform as _Platform } from "@mikro-orm/core";

export class {{name}} extends _Type<string, string> {
  override convertToDatabaseValue(value: string): string {
    if (typeof value !== "string") throw new TypeError("Expected a string.");
    return value.trim();
  }
  override convertToJSValue(value: string): string {
    if (typeof value !== "string") throw new TypeError("Expected a string.");
    return value;
  }
  override getColumnType(prop: _EntityProperty, platform: _Platform): string {
    return platform.getTextTypeDeclarationSQL(prop);
  }
}
`,
  scope: `import type { EntityManager as _EntityManager, EntityName as _EntityName, FilterQuery as _FilterQuery } from "@mikro-orm/core";

// Explicit query helper, not an automatically applied global scope.
export async function {{name}}<T extends object>(em: _EntityManager, entity: _EntityName<T>, where: _FilterQuery<NoInfer<T>>): Promise<T[]> {
  return em.find(entity, where, { limit: 100 });
}
`,
  observer: `import type { EventSubscriber as _EventSubscriber, EventArgs as _EventArgs } from "@mikro-orm/core";

// Register an instance explicitly with an EventManager.
export class {{name}} implements _EventSubscriber {
  createdCount = 0;
  afterCreate(args: _EventArgs<object>): void {
    void args;
    this.createdCount++;
  }
}
`,
  mail: `import type { Mailable as _Mailable, MailMessage as _MailMessage } from "{{runtimeImport}}";

// Example only; replace with application-specific content.
export class {{name}} implements _Mailable {
  build(): _MailMessage {
    return { to: ["recipient@example.invalid"], subject: "Example message", text: "Example text" };
  }
}
`,
  notification: `import type { Notification as _Notification } from "{{runtimeImport}}";

type _MailMessage = Awaited<ReturnType<_Notification["toMail"]>>;

// Example only; replace with application-specific content.
export class {{name}} implements _Notification {
  toMail(recipient: string): _MailMessage {
    return { to: [recipient], subject: "Example notification", text: "Example text" };
  }
}
`,
  event: `import type { EventBus as _EventBus } from "{{runtimeImport}}";

export class {{name}} {
  static readonly eventName = "{{eventName}}";

  static async dispatch(bus: _EventBus, payload: unknown, signal?: AbortSignal): Promise<void> {
    await bus.dispatch(this.eventName, payload, signal);
  }
}
`,
  "job-middleware": `import type { JobMiddleware as _JobMiddleware } from "{{runtimeImport}}";

// Pass-through only; add application-specific behavior here.
export const {{name}}: _JobMiddleware = async (context, next) => {
  void context;
  await next();
};
`,
  job: `export class {{name}} {
  // Example only: replace with application-specific behavior.
  handle(payload: unknown, signal: AbortSignal): void {
    void payload;
    void signal;
  }
}
`,
  listener: `export class {{name}} {
  // Example only: replace with application-specific behavior.
  handle(payload: unknown, signal: AbortSignal): void {
    void payload;
    void signal;
  }
}
`,
  policy: `import type { AuthorizationPolicy as _AuthorizationPolicy, PolicyContext as _PolicyContext } from "{{runtimeImport}}";

// Replace this deny-all example with an application-specific policy.
export class {{name}} implements _AuthorizationPolicy {
  can(context: _PolicyContext): boolean {
    void context;
    return false;
  }
}
`,
  "controller-resource": `import { modelResourceFor as _modelResourceFor } from "{{runtimeImport}}";
import type { HttpContext as _HttpContext } from "{{contextImport}}";
import { {{modelName}} as _Model } from "{{modelImport}}";

export class {{name}} {
  async index(context: _HttpContext): Promise<Response> { return _modelResourceFor(context, _Model).index(context); }
  async show(context: _HttpContext): Promise<Response> { return _modelResourceFor(context, _Model).show(context); }
  async store(context: _HttpContext): Promise<Response> { return _modelResourceFor(context, _Model).store(context); }
  async update(context: _HttpContext): Promise<Response> { return _modelResourceFor(context, _Model).update(context); }
  async destroy(context: _HttpContext): Promise<Response> { return _modelResourceFor(context, _Model).destroy(context); }
}
`,
  controller: `import type { HttpContext as _HttpContext } from "{{runtimeImport}}";

export class {{name}} {
  handle(context: _HttpContext): Response {
    void context;
    return new Response("OK");
  }
}
`,
  middleware: `import type { HttpMiddleware as _HttpMiddleware } from "{{runtimeImport}}";

// Pass-through only; add application-specific behavior here.
export const {{name}}: _HttpMiddleware = async (context, next) => {
  void context;
  return next();
};
`,
  request: `import { rules as _rules, validateRequest as _validateRequest } from "{{runtimeImport}}";

// Adjust the schema and byte limit to your endpoint.
const _schema = _rules.object({ name: _rules.string({ min: 1, max: 100 }) });
export function {{name}}(request: Request) {
  return _validateRequest(request, _schema, { maxBytes: 16384 });
}
`,
  resource: `import { resource as _resource } from "{{runtimeImport}}";

// Explicitly select output fields; adapt this example to your domain.
export function {{name}}(item: { name: string }) {
  return _resource(item, value => ({ name: value.name }));
}
`,
  rule: `import { rules as _rules } from "{{runtimeImport}}";

// Replace this example predicate with a domain-specific rule.
export const {{name}} = _rules.custom(_rules.string({ max: 100 }), value => value.length > 0);
`,
  command: `export default {
  name: "{{commandName}}",
  description: "Run {{name}}",
  handle(_input: unknown, context: { output: (text: string) => void }) {
    context.output("{{name}} executed.");
  },
};
`,
  exception: `export class {{name}} extends Error {
  constructor(message: string) {
    super(message);
    this.name = "{{name}}";
  }
}
`,
  test: `import { expect, test } from "bun:test";

test("{{name}}", () => {
  expect(true).toBe(true);
});
`,
  config: `// Configuration for {{name}}.
export default {};
`,
});
type StubKind = keyof typeof scaffoldStubs;

async function renderStub(root: string, kind: StubKind, name: string, commandName = "", runtimeImport = "", eventName = "", modelName = "", modelImport = "", serviceKey = "", contextImport = "", extra: Readonly<Record<string, string>> = {}): Promise<string> {
  const canonicalRoot = await realpath(root);
  const directory = join(canonicalRoot, "stubs");
  let template = scaffoldStubs[kind] as string;
  try {
    await assertDirectory(canonicalRoot, directory);
    const path = join(directory, `${kind}.ts.stub`);
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("Stub must be a regular file, not a symlink.");
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { template = await handle.readFile("utf8"); } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const tokens: string[] = template.match(/\{\{[^{}]*\}\}/g) ?? [];
  const required = kind === "http-test" ? ["{{name}}", "{{runtimeImport}}", "{{rootUrl}}", "{{requestPath}}"] : kind === "controller-resource" ? ["{{name}}", "{{runtimeImport}}", "{{contextImport}}", "{{modelName}}", "{{modelImport}}"] : kind === "provider" ? ["{{name}}", "{{runtimeImport}}", "{{serviceKey}}"] : kind === "factory" ? ["{{name}}", "{{modelName}}", "{{modelImport}}"] : kind === "command" ? ["{{name}}", "{{commandName}}"] : kind === "event" ? ["{{name}}", "{{runtimeImport}}", "{{eventName}}"] : (Object.hasOwn(httpDirectories, kind) || kind === "job-middleware" || kind === "mail" || kind === "notification") ? ["{{name}}", "{{runtimeImport}}"] : ["{{name}}"];
  if (required.some(token => !tokens.includes(token)) || tokens.some(token => !required.includes(token))) {
    throw new Error(`Invalid tokens in ${kind} stub.`);
  }
  if (kind === "command" && (!/\bname\s*:\s*["']\{\{commandName\}\}["']/.test(template) || (template.match(/\bexport\s+default\b/g) ?? []).length !== 1)) {
    throw new Error("Command stub must export a default definition with name: \"{{commandName}}\".");
  }
  let content = template.replaceAll("{{name}}", name).replaceAll("{{commandName}}", commandName).replaceAll("{{runtimeImport}}", runtimeImport).replaceAll("{{eventName}}", eventName).replaceAll("{{modelName}}", modelName).replaceAll("{{modelImport}}", modelImport).replaceAll("{{serviceKey}}", serviceKey).replaceAll("{{contextImport}}", contextImport);
  for (const [key, value] of Object.entries(extra)) content = content.replaceAll(`{{${key}}}`, () => value);
  if (kind === "command") {
    content = content.replace(/\bexport\s+default\b/, "const _bundleCommand =") + `\nexport default { ..._bundleCommand, name: ${JSON.stringify(commandName)} };\n`;
  }
  try { new Bun.Transpiler({ loader: "ts" }).transformSync(content); }
  catch (cause) { throw new Error(`Invalid TypeScript in ${kind} stub.`, { cause }); }
  return content;
}

/** Publish the fixed inventory exclusively; never replace existing files. */
export async function publishScaffoldStubs(root: string): Promise<string[]> {
  const canonicalRoot = await realpath(root);
  const directory = join(canonicalRoot, "stubs");
  try {
    await assertDirectory(canonicalRoot, directory);
    for (const kind of Object.keys(scaffoldStubs)) {
      try { await lstat(join(directory, `${kind}.ts.stub`)); throw new Error(`Stub already exists: ${kind}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const paths: string[] = [];
  for (const [kind, content] of Object.entries(scaffoldStubs)) {
    paths.push(await writeScaffold(canonicalRoot, ["stubs"], [kind], ".ts.stub", content));
  }
  return paths;
}

async function writeScaffold(root: string, base: string[], segments: string[], extension: string, content: string): Promise<string> {
  const identifier = segments.at(-1)!;
  const canonicalRoot = await realpath(root);
  await assertDirectory(canonicalRoot, canonicalRoot);
  let directory = canonicalRoot;
  for (const segment of [...base, ...segments.slice(0, -1)]) {
    await assertDirectory(canonicalRoot, directory);
    directory = join(directory, segment);
    try {
      // Do not use recursive mkdir: every existing ancestor must be checked first.
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await assertDirectory(canonicalRoot, directory);
  }
  await assertDirectory(canonicalRoot, directory);
  const filename = join(directory, `${identifier}${extension}`);
  assertWithinRoot(canonicalRoot, filename);
  // O_EXCL refuses regular files, symlinks (including dangling ones), and directories alike.
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  // Never unlink files on failure: another process may have replaced a path in the meantime.
  return filename;
}
