import { mkdir } from "node:fs/promises";
import { buildCorpus } from "../src/graph/corpus.ts";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--check")) {
  console.error("Usage: bun run scripts/build-graph.ts [--check]");
  process.exit(1);
}

// Resolve against this script, not the invoking shell's working directory.
const root = new URL("../", import.meta.url);
const output = new URL("graph/", root);
const markdown = await Bun.file(new URL("PROGRESS.md", root)).text();
const data = buildCorpus(markdown);
const check = args.includes("--check");
const stale: string[] = [];

if (!check) await mkdir(output, { recursive: true });
for (const [name, content] of Object.entries(data)) {
  const file = Bun.file(new URL(`${name}.json`, output));
  const expected = `${JSON.stringify(content, null, 2)}\n`;
  const existing = await file.exists() ? await file.text() : null;
  if (existing === expected) continue;
  if (check) stale.push(`graph/${name}.json`);
  else await Bun.write(file, expected);
}

if (stale.length) {
  console.error(`Missing or stale graph files:\n${stale.join("\n")}\nRun bun run graph:build.`);
  process.exit(1);
}
console.log(`${check ? "Verified" : "Generated"} graph corpus: ${JSON.stringify(data.manifest.counts)}`);
