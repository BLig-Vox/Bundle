import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCli } from "./program.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bundle-job-test-")); roots.push(root);
  const output: string[] = [];
  const run = (args: string[]) => createCli({ root, env: { DB_CONNECTION: "invalid" }, output: value => output.push(value) })
    .parseAsync(["make:job", ...args], { from: "user" });
  return { root, output, run };
}

test("make:job generates an editable typed handler and explicit static registration without DB access", async () => {
  const { root, output, run } = await fixture();
  await run(["SendWelcome", "--type", "mail.welcome", "--field", "email:string", "--field", "retries:integer?"]);
  const result = JSON.parse(output[0]!);
  expect(result).toMatchObject({ created: "src/jobs/SendWelcome.ts", type: "mail.welcome" });
  expect(result.registration.import).toBe('import { sendWelcomeJob } from "./SendWelcome.ts";');
  expect(result.registration.entry).toBe('"mail.welcome": sendWelcomeJob,');
  expect(result.next).toBe("Implement handler, then add both registration lines to src/jobs/registry.ts.");
  const source = await readFile(join(root, "src/jobs/SendWelcome.ts"), "utf8");
  expect(source).toContain("defineJob");
  expect(source).toContain("jobSchema.string({ trim: true, min: 1, max: 255 })");
  expect(source).toContain("jobSchema.optional(jobSchema.number({ finite: true, integer: true }))");
  expect(source).toContain("throw new Error(\"TODO: Implement SendWelcome before processing this job.\")");
  expect(await readdir(join(root, "src/jobs"))).toEqual(["SendWelcome.ts"]);
});

test("make:job accepts empty payloads and emits a deterministic type registration", async () => {
  const { root, output, run } = await fixture();
  await run(["CacheWarmup", "--type", "cache.warmup"]);
  expect(JSON.parse(output[0]!)).toMatchObject({
    created: "src/jobs/CacheWarmup.ts",
    registration: { import: 'import { cacheWarmupJob } from "./CacheWarmup.ts";', entry: '"cache.warmup": cacheWarmupJob,' },
  });
  expect(await readFile(join(root, "src/jobs/CacheWarmup.ts"), "utf8")).toContain("jobSchema.object({");
});

test("make:job validates every field and job type before creating files or printing success", async () => {
  const { root, output, run } = await fixture();
  await expect(run(["A".repeat(65), "--type", "mail.send"])).rejects.toThrow("64 characters");
  await expect(run(["Unsafe", "--type", "../escape"])).rejects.toThrow("job type");
  await expect(run(["Unsafe", "--type", "mail.send", "--field", "__proto__:string"])).rejects.toThrow("field");
  await expect(run(["Unsafe", "--type", "mail.send", "--field", "when:date"])).rejects.toThrow("field");
  await expect(run(["Unsafe", "--type", "mail.send", "--field", "bad name:string"])).rejects.toThrow("field");
  expect(await readdir(root)).toEqual([]);
  expect(output).toEqual([]);
});

test("make:job refuses collisions without overwriting existing source", async () => {
  const { root, output, run } = await fixture();
  await run(["SendWelcome", "--type", "mail.welcome"]);
  const existing = await readFile(join(root, "src/jobs/SendWelcome.ts"), "utf8");
  output.length = 0;
  await expect(run(["SendWelcome", "--type", "mail.other"])).rejects.toThrow("already exists");
  expect(await readFile(join(root, "src/jobs/SendWelcome.ts"), "utf8")).toBe(existing);
  expect(output).toEqual([]);
});
