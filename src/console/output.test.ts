import { describe, expect, test } from "bun:test";
import { createConsoleOutput } from "./output.ts";

describe("createConsoleOutput", () => {
  test("renders semantic and plain messages deterministically without a TTY", () => {
    const lines: string[] = [];
    const output = createConsoleOutput({ write: text => lines.push(text) });
    output.info("ready");
    output.warn("careful");
    output.error("failed");
    output.success("done");
    output.line("plain");
    expect(lines).toEqual(["ℹ ready\n", "! careful\n", "✖ failed\n", "✓ done\n", "plain\n"]);
    output.close();
  });

  test("renders a bounded table with empty and ragged rows", () => {
    const lines: string[] = [];
    const output = createConsoleOutput({ write: text => lines.push(text), columns: 40 });
    output.table([]);
    output.table([["Name", "Value"], ["long column label", "x"], ["a", "two\nlines"]]);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("\n");
    expect(lines[1]).toContain("Name");
    expect(lines[1]).toContain("Value\n");
    expect(lines[2]).toContain("long column label");
    expect(lines[3]).toContain("two lines");
    output.close();
  });

  test("keeps multi-column tables within the total terminal width", () => {
    const chunks: string[] = [];
    const output = createConsoleOutput({ write: text => chunks.push(text), columns: 40 });
    output.table([["first".repeat(10), "second".repeat(10), "third".repeat(10)], ["one", "two", "three"]]);
    for (const line of chunks.join("").trimEnd().split("\n")) expect(line.length).toBeLessThanOrEqual(40);
    output.close();
  });

  test("completing valid progress renders the final total exactly once", () => {
    const chunks: string[] = [];
    const output = createConsoleOutput({ write: text => chunks.push(text) });
    const progress = output.progress("Import", 3);
    progress.update(1);
    progress.complete();
    progress.complete();
    expect(chunks.at(-1)).toBe("Import: [##########] 3/3\n");
    expect(chunks.filter(chunk => chunk.includes("3/3"))).toHaveLength(1);
    output.close();
  });

  test("emits color only on supported TTY output and suppresses writes after close", () => {
    for (const isTTY of [true, false]) {
      const chunks: string[] = [];
      const output = createConsoleOutput({ write: text => chunks.push(text), isTTY, color: true, env: {} });
      output.success("done");
      expect(chunks.join("").includes("\u001b[32m")).toBe(isTTY);
      output.close();
      output.close();
      output.line("must not print");
      expect(chunks.join("")).not.toContain("must not print");
    }
  });

  test("honors NO_COLOR for TTY semantic output", () => {
    const chunks: string[] = [];
    const output = createConsoleOutput({ write: text => chunks.push(text), isTTY: true, color: true, env: { NO_COLOR: "" } });
    output.error("plain diagnostic");
    expect(chunks.join("")).toBe("✖ plain diagnostic\n");
    output.close();
  });

  test("strips terminal controls from untrusted messages and table cells", () => {
    const lines: string[] = [];
    const output = createConsoleOutput({ write: text => lines.push(text), isTTY: true, color: false });
    output.info("bad\u001b[31mred\u001b[0m\u0007\nnext");
    output.table([["\u001b]0;title\u0007cell", "ok"]]);
    expect(lines.join("")).not.toMatch(/[\u001b\u0007]/);
    expect(lines.join("")).toContain("badred next");
    output.close();
  });

  test("renders progress safely for invalid totals and updates, then completes once", () => {
    const lines: string[] = [];
    const output = createConsoleOutput({ write: text => lines.push(text) });
    const progress = output.progress("Work", 0);
    progress.update(-1);
    progress.update(Number.NaN);
    progress.complete("finished");
    progress.complete("ignored");
    expect(lines).toEqual(["Work: [----------] 0/0\n", "Work: [----------] 0/0\n", "Work: [----------] 0/0\n", "finished\n"]);
    output.close();
  });

  test("supports explicit spinner ticks and idempotent stop, including error", () => {
    const lines: string[] = [];
    const output = createConsoleOutput({ write: text => lines.push(text), isTTY: true });
    const spinner = output.spinner("Loading");
    expect(spinner.tick()).toBe(true);
    spinner.stop("done");
    spinner.stop("ignored");
    const failed = output.spinner("Saving");
    failed.fail("nope");
    failed.tick();
    output.close();
    expect(lines.some(line => line.includes("Loading"))).toBe(true);
    expect(lines.some(line => line.includes("done"))).toBe(true);
    expect(lines.some(line => line.includes("nope"))).toBe(true);
    expect(lines.join("")).not.toMatch(/[\u001b\u0007]/);
  });
});
