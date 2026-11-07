import { test, expect } from "bun:test";
import { Command } from "commander";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMaintenance } from "../maintenance/maintenance.ts";
import { registerMaintenance } from "./maintenance.ts";

test("down and up CLI update the actual state and reject unsupported or invalid flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-down-cli-"));
  const output: string[] = [];
  const cli = () => { const program = new Command().exitOverride(); program.configureOutput({ writeErr: () => {} }); registerMaintenance(program, { root, output: text => output.push(text) }); return program; };
  try {
    await cli().parseAsync(["down", "--retry", "0", "--refresh", "60"], { from: "user" });
    expect(await readMaintenance(root)).toEqual({ version: 1, retrySeconds: 0, refreshSeconds: 60 });
    await expect(cli().parseAsync(["down", "--retry", "1x"], { from: "user" })).rejects.toThrow();
    await expect(cli().parseAsync(["down", "--secret", "abc"], { from: "user" })).rejects.toThrow();
    await cli().parseAsync(["up"], { from: "user" });
    expect(await readMaintenance(root)).toBeUndefined();
    expect(output.length).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
