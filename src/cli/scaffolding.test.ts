import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  generateTypeScript,
  generateDeliveryScaffold,
  generateHttpScaffold,
  renderTypeScriptTemplate,
  typeScriptTemplates,
  type GenerateTypeScriptOptions,
  type TypeScriptScaffoldKind,
} from "./scaffolding.ts";

const projectRoot = resolve(import.meta.dir, "../..");
const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await rm(cleanups.pop()!, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const directory = join(projectRoot, ".data");
  await mkdir(directory, { recursive: true });
  const root = await mkdtemp(join(directory, "scaffolding-test-"));
  cleanups.push(root);
  return realpath(root);
}

async function entries(root: string) {
  return (await readdir(root, { recursive: true })).sort();
}

describe("standalone TypeScript scaffolding", () => {
  test("creates all four named, import-free scaffold types at their documented destinations", async () => {
    const root = await fixture();
    const cases = [
      ["class", "Invoice", "classes"],
      ["interface", "InvoiceContract", "contracts"],
      ["enum", "InvoiceState", "enums"],
      ["trait", "TracksInvoices", "traits"],
    ] as const;
    for (const [kind, name, directory] of cases) {
      const file = await generateTypeScript(root, kind, name);
      expect(file).toBe(join(root, "src", directory, `${name}.ts`));
      const content = await readFile(file, "utf8");
      expect(content).toBe(renderTypeScriptTemplate(kind, name));
      expect(content).not.toContain("{{name}}");
      expect(content).not.toContain("import ");
      expect(content).not.toContain("namespace ");
    }
    expect(await readFile(join(root, "src/traits/TracksInvoices.ts"), "utf8")).toContain("not PHP trait composition");
  });

  test("generated declarations compile under the project's strict options and work in Bun", async () => {
    const root = await fixture();
    await generateTypeScript(root, "class", "Billing/Invoice");
    await generateTypeScript(root, "interface", "Billing/InvoiceContract");
    await generateTypeScript(root, "enum", "Billing/InvoiceState");
    await generateTypeScript(root, "trait", "Billing/TracksInvoices");
    const usage = join(root, "usage.ts");
    await writeFile(usage, `import { Invoice } from "./src/classes/Billing/Invoice.ts";
import type { InvoiceContract } from "./src/contracts/Billing/InvoiceContract.ts";
import { InvoiceState } from "./src/enums/Billing/InvoiceState.ts";
import { TracksInvoices } from "./src/traits/Billing/TracksInvoices.ts";

const invoice: Invoice = new Invoice();
const contract: InvoiceContract = invoice;
const enumObject: typeof InvoiceState = InvoiceState;
// @ts-expect-error This scaffold is a type-only interface, not a runtime constructor.
new InvoiceContract();
// @ts-expect-error Arbitrary strings are not members of the generated enum.
const invalidState: InvoiceState = "missing";
// @ts-expect-error Empty scaffolds do not invent application properties.
invoice.missing;

class BaseInvoice {
  static readonly category = "billing";
  constructor(readonly number: string, readonly amount: number) {}
  total(): number { return this.amount; }
}
class TrackedInvoice extends TracksInvoices(BaseInvoice) {}
const tracked = new TrackedInvoice("INV-001", 42);
const number: string = tracked.number;
const amount: number = tracked.total();
const category: string = TrackedInvoice.category;
// @ts-expect-error The mixin preserves the constructor argument types.
new TrackedInvoice(123, "invalid");
export const result = { invoice, contract, enumObject, tracked, number, amount, category };
`);
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({
      extends: join(projectRoot, "tsconfig.json"),
      include: ["src/**/*.ts", "usage.ts"],
    }));
    const compiler = Bun.spawn([process.execPath, "check", "--project", join(root, "tsconfig.json")], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, status] = await Promise.all([
      new Response(compiler.stdout).text(),
      new Response(compiler.stderr).text(),
      compiler.exited,
    ]);
    expect(status, stdout + stderr).toBe(0);
    // Execute only valid usage; expected compile-time errors are deliberately not executed.
    const runnable = (await readFile(usage, "utf8"))
      .replace("new InvoiceContract();", "")
      .replace('new TrackedInvoice(123, "invalid");', "");
    const runtimeFile = join(root, "runtime.ts");
    await writeFile(runtimeFile, runnable);
    const { result } = await import(pathToFileURL(runtimeFile).href);
    expect(result.number).toBe("INV-001");
    expect(result.amount).toBe(42);
    expect(result.category).toBe("billing");
    expect(result.tracked).toBeInstanceOf(Object);
    expect(result.enumObject).toEqual({});
  }, 30000);

  test("supports nested directory namespaces and a canonical symlinked root", async () => {
    const root = await fixture();
    const holder = await fixture();
    const linkedRoot = join(holder, "linked-root");
    await symlink(root, linkedRoot);
    const file = await generateTypeScript(linkedRoot, "interface", "Accounts/Billing/Invoice2");
    expect(file).toBe(join(root, "src/contracts/Accounts/Billing/Invoice2.ts"));
    expect(await readFile(file, "utf8")).toContain("export interface Invoice2");
    await expect(generateTypeScript(root, "class", "Accounts/Invoice", { namespaces: false })).rejects.toThrow("PascalCase");
    expect(await generateTypeScript(root, "class", "Invoice", { namespaces: false })).toBe(join(root, "src/classes/Invoice.ts"));
  });

  test("rejects traversal, absolute paths, invalid identifiers, extensions, reserved types, and import-like names before creating directories", async () => {
    const root = await fixture();
    const invalid = [
      "", "invoice", "1Invoice", "Invoice.ts", "Invoice-Item", "Invoice_Item", "Invoice Item",
      "../Invoice", "Accounts/../Invoice", "./Invoice", "/Invoice", "//Invoice", "Accounts//Invoice",
      "Accounts/", "Accounts/./Invoice", "Accounts\\Invoice", "C:/Invoice", "C:\\Invoice",
      "Invoice\n", "Invoice\0", "Invóice", "__proto__", "constructor", "import", "default", "class",
      "Date", "String", "Number", "Boolean", "BigInt", "Buffer", "Object", "Array", "Promise", "Record",
      "ImportMeta", "Map", "Set", "Date/Invoice", "Accounts/Date", "Con", "Nul", "COM1", "Lpt9",
    ];
    for (const name of invalid) {
      await expect(generateTypeScript(root, "class", name)).rejects.toThrow();
    }
    expect(await entries(root)).toEqual([]);
  });

  test("refuses unsupported kinds and options, especially force, without touching the filesystem", async () => {
    const root = await fixture();
    for (const kind of ["model", "controller", "__proto__", "toString"]) {
      await expect(generateTypeScript(root, kind as TypeScriptScaffoldKind, "Invoice")).rejects.toThrow("kind");
    }
    for (const options of [{ force: true }, { force: false }, { template: "anything" }, { namespaces: "true" }, null]) {
      await expect(generateTypeScript(root, "class", "Invoice", options as GenerateTypeScriptOptions)).rejects.toThrow("overwriting is never allowed");
    }
    expect(await entries(root)).toEqual([]);
  });

  test("never replaces an existing file, directory, or file symlink including dangling links", async () => {
    const root = await fixture();
    const outside = await fixture();
    const parent = join(root, "src/classes");
    await mkdir(parent, { recursive: true });
    const existing = join(parent, "Invoice.ts");
    await writeFile(existing, "user-owned content\n");
    await mkdir(join(parent, "Directory.ts"));
    const target = join(outside, "outside.ts");
    await writeFile(target, "outside content\n");
    await symlink(target, join(parent, "Linked.ts"));
    await symlink(join(outside, "missing.ts"), join(parent, "Dangling.ts"));
    const before = await entries(root);
    for (const name of ["Invoice", "Directory", "Linked", "Dangling"]) {
      await expect(generateTypeScript(root, "class", name)).rejects.toThrow();
    }
    expect(await entries(root)).toEqual(before);
    expect(await readFile(existing, "utf8")).toBe("user-owned content\n");
    expect(await readFile(target, "utf8")).toBe("outside content\n");
    expect((await lstat(join(parent, "Linked.ts"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(parent, "Dangling.ts"))).isSymbolicLink()).toBe(true);
    expect(await entries(outside)).toEqual(["outside.ts"]);
  });

  // These fixtures check existing symlink escapes in a stable project tree. They do not
  // claim protection against a hostile process concurrently renaming ancestor directories.
  test("rejects every symlinked parent level, including dangling links and links to internal directories", async () => {
    for (const level of ["src", "src/classes", "src/classes/Accounts"]) {
      const root = await fixture();
      const outside = await fixture();
      const parts = level.split("/");
      await mkdir(join(root, ...parts.slice(0, -1)), { recursive: true });
      const link = join(root, level);
      await symlink(outside, link);
      const before = await entries(root);
      await expect(generateTypeScript(root, "class", "Accounts/Invoice")).rejects.toThrow("symlink");
      expect(await entries(outside)).toEqual([]);
      expect(await entries(root)).toEqual(before);
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
    }
    const root = await fixture();
    await symlink(join(root, "missing"), join(root, "src"));
    await expect(generateTypeScript(root, "class", "Invoice")).rejects.toThrow("symlink");
    expect(await entries(root)).toEqual(["src"]);
    const internal = await fixture();
    await mkdir(join(internal, "internal"));
    await symlink(join(internal, "internal"), join(internal, "src"));
    await expect(generateTypeScript(internal, "class", "Invoice")).rejects.toThrow("symlink");
    expect(await readdir(join(internal, "internal"))).toEqual([]);
  });

  test("refuses non-directory ancestors and missing project roots", async () => {
    const root = await fixture();
    await writeFile(join(root, "src"), "not a directory");
    await expect(generateTypeScript(root, "class", "Invoice")).rejects.toThrow("directory");
    await expect(generateTypeScript(join(root, "nonexistent"), "class", "Invoice")).rejects.toThrow();
    await expect(generateTypeScript(join(root, "src"), "class", "Invoice")).rejects.toThrow("directory");
    expect(await readFile(join(root, "src"), "utf8")).toBe("not a directory");
    expect(await entries(root)).toEqual(["src"]);
  });

  test("exclusive creation allows exactly one concurrent winner and preserves unrelated files", async () => {
    const root = await fixture();
    await mkdir(join(root, "src/classes"), { recursive: true });
    await writeFile(join(root, "keep.txt"), "root marker\n");
    await writeFile(join(root, "src/classes/Keep.ts"), "export const keep = true;\n");
    const results = await Promise.allSettled([
      generateTypeScript(root, "class", "Invoice"),
      generateTypeScript(root, "class", "Invoice"),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(await readFile(join(root, "src/classes/Invoice.ts"), "utf8")).toBe(renderTypeScriptTemplate("class", "Invoice"));
    expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("root marker\n");
    expect(await readFile(join(root, "src/classes/Keep.ts"), "utf8")).toBe("export const keep = true;\n");
  });

  test("exposes immutable templates and validates renderer input without publishing stubs", () => {
    expect(Object.isFrozen(typeScriptTemplates)).toBe(true);
    expect(Object.keys(typeScriptTemplates).sort()).toEqual(["class", "enum", "interface", "trait"]);
    expect(typeScriptTemplates.class).toContain("{{name}}");
    expect(() => renderTypeScriptTemplate("class", "Billing/Invoice")).toThrow();
    expect(() => renderTypeScriptTemplate("interface", "Date")).toThrow();
    expect(() => renderTypeScriptTemplate("bad" as TypeScriptScaffoldKind, "Invoice")).toThrow("kind");
  });
});

test("delivery scaffold rejects unsupported kinds before writing", async () => {
  const root = await fixture();
  for (const kind of ["other", "__proto__", "toString"]) {
    await expect(generateDeliveryScaffold(root, kind as never, "Example")).rejects.toThrow("kind");
  }
  expect(await entries(root)).toEqual([]);
});

test("policy scaffold generates a nested default-deny class", async () => {
  const root = await fixture();
  const file = await generateHttpScaffold(root, "policy" as never, "Nested/InvoicePolicy");
  expect(file).toBe(join(root, "src/http/policies/Nested/InvoicePolicy.ts"));
  expect(await readFile(file, "utf8")).toContain("return false");
  await expect(generateHttpScaffold(root, "policy" as never, "Nested/InvoicePolicy")).rejects.toThrow();
});
