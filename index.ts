#!/usr/bin/env bun
import { runCli } from "./src/cli/runner.ts";

process.exitCode = await runCli(process.argv.slice(2));
