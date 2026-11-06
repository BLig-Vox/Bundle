#!/usr/bin/env bun
import { CommanderError } from "commander";
import { createCli, safeError } from "./src/cli/program.ts";

try {
  const args = process.argv.slice(2);
  await createCli().parseAsync(args.length ? args : ["list"], { from: "user" });
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode;
  } else {
    console.error(`Error: ${safeError(error)}`);
    process.exitCode = 1;
  }
}
