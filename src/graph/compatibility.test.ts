import { expect, test } from "bun:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const inventory = await Bun.file(resolve(root, "docs/cli-compatibility.json")).json();
const corpus = await Bun.file(resolve(root, "graph/corpus.json")).json();
const manifest = await Bun.file(resolve(root, "graph/manifest.json")).json();

test("compatibility inventory retains every original reference ID and honest status totals", () => {
  expect(inventory.items).toHaveLength(180);
  const ids = inventory.items.map((item: {id: string}) => item.id);
  expect(new Set(ids).size).toBe(180);
  expect([...ids].sort()).toEqual(corpus.items.map((item: {id: string}) => item.id).sort());
  for (const status of Object.keys(inventory.statusDefinitions)) {
    expect(inventory.counts[status]).toBe(inventory.items.filter((item: {status: string}) => item.status === status).length);
  }
  for (const item of inventory.items) {
    expect(Object.hasOwn(inventory.statusDefinitions, item.status)).toBe(true);
    expect(item.reason.length).toBeGreaterThan(0);
    expect(item.remainingWork.length).toBeGreaterThan(0);
    expect(item.evidence.length).toBeGreaterThan(0);
  }
});

test("compatibility provenance matches regenerated source and all evidence paths exist", async () => {
  expect(inventory.baseline.source).toEqual(manifest.source);
  for (const item of inventory.items) {
    const source = corpus.items.find((source: {id: string}) => source.id === item.id);
    expect(item.originalTitle).toBe(source.title);
    expect(item.referenceCompleted).toBe(source.completed);
    expect(item.sourceLocation).toEqual(source.location);
    const category = corpus.sections.find((section: {id: string}) => section.id === item.category.id);
    expect(item.category.title).toBe(category.title);
    expect(item.category.location).toEqual(category.location);
    for (const evidence of item.evidence) {
      expect(await Bun.file(resolve(root, evidence.path)).exists()).toBe(true);
      if (evidence.kind === "reference-only" && evidence.path === "PROGRESS.md") {
        expect(evidence.startLine).toBe(source.location.startLine);
        expect(evidence.endLine).toBe(source.location.endLine);
      }
    }
  }
});
