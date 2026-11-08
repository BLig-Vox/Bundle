import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createCli } from "./program.ts";
import { projectRoot } from "../database/config.ts";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });
async function fixture() {
  await mkdir(join(projectRoot, ".data"), { recursive: true });
  const root = await mkdtemp(join(projectRoot, ".data/page-test-"));
  roots.push(root);
  const output: string[] = [];
  const run = async (name: string) => {
    await createCli({ root, env: { DB_CONNECTION: "invalid" }, output: text => output.push(text) })
      .parseAsync(["make:page", name], { from: "user" });
    return JSON.parse(output.at(-1)!);
  };
  return { root, output, run };
}

describe("make:page", () => {
  test("generates an independent server-renderable TypeScript module with safe defaults", async () => {
    const { root, run } = await fixture();
    expect(await run("Dashboard")).toEqual({ created: "src/pages/Dashboard.ts" });
    const file = join(root, "src/pages/Dashboard.ts");
    const source = await readFile(file, "utf8");
    expect(source).not.toMatch(/import |jsx|tsx/i);
    const page = await import(pathToFileURL(file).href);
    expect(page.render()).toContain("<title>Dashboard</title>");
    expect(page.render()).toContain("<h1>Dashboard</h1>");
    const hostile = `&<>"' <script>alert("x")</script> &lt;`;
    const escaped = "&amp;&lt;&gt;&quot;&#39; &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp;lt;";
    const html = page.render({ title: hostile, heading: hostile });
    expect(html).toContain(`<title>${escaped}</title>`);
    expect(html).toContain(`<h1>${escaped}</h1>`);
    expect(html).not.toContain("<script>");
    expect(await readdir(join(root, "src/pages"))).toEqual(["Dashboard.ts"]);
  });

  test("rejects invalid names and traversal before creating directories or printing success", async () => {
    const { root, output, run } = await fixture();
    for (const name of ["", "dashboard", "1Page", "Page.ts", "Two Words", "Page_Name", "Page-Name", "../Escape", "../../Escape", "/Escape", "..\\Escape", "Page/Child", "Page\n", "Päge", "CON", "Lpt1"]) {
      await expect(run(name)).rejects.toThrow("PascalCase");
    }
    expect(await readdir(root)).toEqual([]);
    expect(output).toEqual([]);
  });

  test("never overwrites existing files, directories, or symlinks, even with --force", async () => {
    const { root, run } = await fixture();
    await run("Dashboard");
    const directory = join(root, "src/pages");
    const file = join(directory, "Dashboard.ts");
    await writeFile(file, "// user-owned code\n");
    await expect(run("Dashboard")).rejects.toThrow("already exists");
    await expect(createCli({ root }).parseAsync(["make:page", "Dashboard", "--force"], { from: "user" })).rejects.toThrow("already exists");
    expect(await readFile(file, "utf8")).toBe("// user-owned code\n");
    await mkdir(join(directory, "Directory.ts"));
    await expect(run("Directory")).rejects.toThrow("already exists");
    await symlink(join(root, "missing.ts"), join(directory, "Linked.ts"));
    await expect(run("Linked")).rejects.toThrow("already exists");
    expect(await Bun.file(join(root, "missing.ts")).exists()).toBe(false);
    expect((await readdir(directory)).sort()).toEqual(["Dashboard.ts", "Directory.ts", "Linked.ts"]);
  });

  test("concurrent generation publishes exactly one complete file exclusively", async () => {
    const { root, output, run } = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => run("Dashboard")));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(output).toHaveLength(1);
    const page = await import(pathToFileURL(join(root, "src/pages/Dashboard.ts")).href);
    expect(page.render()).toContain("</html>");
    expect(await readdir(join(root, "src/pages"))).toEqual(["Dashboard.ts"]);
  });

  test("refuses symlinked source/page directories instead of writing outside the destination", async () => {
    for (const segment of ["src", "src/pages"]) {
      const { root, run } = await fixture();
      const outside = join(root, "outside");
      await mkdir(outside);
      if (segment === "src/pages") await mkdir(join(root, "src"));
      await symlink(outside, join(root, segment));
      await expect(run("Dashboard")).rejects.toThrow("real directory");
      expect(await readdir(outside)).toEqual([]);
    }
  });

  test("real entry point reports concise success/errors and nonzero failures", async () => {
    const { root } = await fixture();
    for (const path of ["src", "index.ts", "package.json"]) {
      await cp(join(projectRoot, path), join(root, path), { recursive: true });
    }
    const invoke = async (name: string) => {
      const child = Bun.spawn(["bun", "run", "index.ts", "make:page", name], {
        cwd: root, env: { ...process.env, DB_CONNECTION: "invalid" }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, code };
    };
    const success = await invoke("Dashboard");
    expect(success.code).toBe(0);
    expect(success.stderr).toBe("");
    expect(JSON.parse(success.stdout)).toEqual({ created: "src/pages/Dashboard.ts" });
    for (const name of ["Dashboard", "../Escape"]) {
      const result = await invoke(name);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toMatch(/^Error: .+$/);
      expect(result.stderr).not.toContain("\n    at ");
    }
  });
});
