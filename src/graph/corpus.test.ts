import { describe, expect, test } from "bun:test";
import { buildCorpus, sha256 } from "./corpus.ts";

const markdown = await Bun.file(new URL("../../PROGRESS.md", import.meta.url)).text();
const data = buildCorpus(markdown);

function assertGraphIntegrity(result: ReturnType<typeof buildCorpus>) {
  const ids = new Set(result.graph.nodes.map(node => node.id));
  expect(ids.size).toBe(result.graph.nodes.length);
  for (const edge of result.graph.edges) {
    expect(ids.has(edge.from)).toBe(true);
    expect(ids.has(edge.to)).toBe(true);
  }
  for (const command of result.commands.commands) {
    for (const occurrence of command.occurrences) expect(ids.has(occurrence.ownerId)).toBe(true);
  }
}

describe("PROGRESS.md corpus", () => {
  test("preserves the entire source, all checklist items, and all categories", () => {
    expect(data.corpus.document.markdown).toBe(markdown);
    expect(data.corpus.document.sha256).toBe(sha256(markdown));
    expect(data.corpus.items.length).toBe([...markdown.matchAll(/^- \[[ xX]\] /gm)].length);
    expect(data.manifest.counts.categories).toBe(15);
    expect(data.corpus.items.map(item => item.title)).toEqual(
      [...markdown.matchAll(/^- \[[ xX]\] (.+)$/gm)].map(match => match[1]!),
    );
    for (const item of data.corpus.items) {
      const line = markdown.split(/\r?\n/)[item.location.startLine - 1]!;
      expect(item.completed).toBe(/^- \[[xX]\]/.test(line));
    }
  });

  test("preserves every fenced example and its text", () => {
    const fences = [...markdown.matchAll(/^\s*```bash\r?\n([\s\S]*?)^\s*```/gm)];
    expect(data.corpus.examples.length).toBe(fences.length);
    for (const example of data.corpus.examples) {
      const raw = markdown.split(/\r?\n/).slice(example.location.startLine, example.location.endLine - 1);
      expect(example.text.split("\n").map(line => line.trim())).toEqual(raw.map(line => line.trim()));
    }
  });

  test("retains warnings, version constraints, optional tools, and sources", () => {
    expect(data.corpus.notes.some(note => note.text.includes("**Destructive:**"))).toBe(true);
    expect(data.corpus.notes.some(note => note.text.includes("Pause/resume commands are version-dependent"))).toBe(true);
    expect(data.corpus.items.some(item => item.title.startsWith("**Sail**"))).toBe(true);
    expect(data.sources.sources.map(source => source.url)).toEqual(
      [...markdown.matchAll(/^- \[[^\]]+\]\((https?:\/\/[^\s)]+)\)/gm)].map(match => match[1]!),
    );
  });

  test("deduplicates commands without dropping invocations or Sail references", () => {
    const migrate = data.commands.commands.find(command => command.name === "migrate");
    expect(migrate?.occurrences.some(o => o.invocation === "migrate")).toBe(true);
    expect(migrate?.occurrences.some(o => o.invocation === "./vendor/bin/sail artisan migrate")).toBe(true);
    expect(data.commands.commands.filter(command => command.name === "migrate")).toHaveLength(1);
    expect(data.commands.commands.some(command => command.name === "<command>")).toBe(false);
    const scout = data.commands.commands.find(command => command.name === "scout:import");
    expect(scout?.occurrences[0]?.invocation).toBe('php artisan scout:import "App\\Models\\Post"');
  });

  test("has unique node IDs and no dangling relationships", () => assertGraphIntegrity(data));

  test("produces deterministic output", () => {
    expect(buildCorpus(markdown)).toEqual(data);
  });

  test("generated JSON artifacts match the current source and generator", async () => {
    for (const [name, content] of Object.entries(data)) {
      const file = Bun.file(new URL(`../../graph/${name}.json`, import.meta.url));
      expect(await file.text()).toBe(`${JSON.stringify(content, null, 2)}\n`);
    }
  });
});

describe("checklist parsing", () => {
  test("handles CRLF, completed items, nested sections, and code containing Markdown", () => {
    const sample = [
      "# Sample", "", "## 1. Commands", "", "### Group", "",
      "- [X] `make:test` — Generate a test.", "", "  ```bash",
      "  # Not a heading", "  php artisan make:test SampleTest", "  ```", "",
      "A version-dependent note.", "", "- [ ] Another feature.", "",
      "## 2. Other", "", "- [x] Done.",
    ].join("\r\n");
    const result = buildCorpus(sample);
    expect(result.corpus.items.map(item => item.completed)).toEqual([true, false, true]);
    expect(result.corpus.examples[0]?.parentId).toBe(result.corpus.items[0]?.id);
    expect(result.corpus.notes[0]?.parentId).toBe(result.corpus.sections[1]?.id);
    expect(result.corpus.sections).toHaveLength(3);
    expect(result.commands.commands).toHaveLength(1);
    assertGraphIntegrity(result);
  });

  test("changing completion preserves item identity", () => {
    const before = buildCorpus("# Sample\n\n## 1. Tasks\n\n- [ ] A task.\n");
    const after = buildCorpus("# Sample\n\n## 1. Tasks\n\n- [x] A task.\n");
    expect(before.corpus.items[0]?.id).toBe(after.corpus.items[0]?.id);
    expect(after.manifest.counts.completedItems).toBe(1);
  });

  test("disambiguates repeated items and examples", () => {
    const result = buildCorpus("# Sample\n\n## 1. Tasks\n\n- [ ] Duplicate\n- [ ] Duplicate\n\n```bash\nphp artisan about\n```\n\n```bash\nphp artisan about\n```\n");
    expect(result.corpus.items).toHaveLength(2);
    expect(result.corpus.examples).toHaveLength(2);
    assertGraphIntegrity(result);
  });

  test("rejects an unclosed code fence", () => {
    expect(() => buildCorpus("# Sample\n\n```bash\nphp artisan about\n")).toThrow("Unclosed code fence");
  });
});
