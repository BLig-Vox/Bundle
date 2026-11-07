import { CommanderError, type Command } from "commander";
import { projectRoot } from "../database/config.ts";
import { loadApplicationCommands } from "../console/loader.ts";
import { resolveCommandContext, type ApplicationCommandContext } from "../console/command.ts";
import { createCli, safeError } from "./program.ts";
import { ServiceContainer } from "../console/services.ts";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { bootProviders, loadProviderDefinitions } from "../console/providers.ts";

/** Build the normal CLI and register trusted project-local command modules. */
export async function createApplicationCli(context: ApplicationCommandContext = {}): Promise<Command> {
  const resolved = resolveCommandContext({ ...context, root: context.root ?? projectRoot });
  const error = (text: string) => resolved.error(safeError(text, resolved.env));
  // Preserve absent I/O overrides: subprocess streams need raw writes by default,
  // not console.log/error, which insert a newline at every arbitrary chunk boundary.
  const program = createCli({ root: resolved.root, env: resolved.env, output: context.output, error: context.error, signal: resolved.signal, handleSignals: context.handleSignals, prompts: resolved.prompts, services: resolved.services });
  // Existing child commands share this configuration object from their creation.
  // Updating it in place also redirects their parser diagnostics, without globals.
  program.configureOutput().writeErr = error;
  await loadApplicationCommands(program, { ...resolved, error });
  return program;
}

/** Recognize the outer installer command without importing an application's registry. */
function projectCreationInvocation(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--database" || value === "--path") { index++; continue; }
    if (value === "--") return args[index + 1] === "new";
    if (value.startsWith("-")) continue;
    return value === "new";
  }
  return false;
}

function interactiveDatabaseInvocation(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--database" || value === "--path") { index++; continue; }
    if (value === "--") return args[index + 1] === "db";
    if (value.startsWith("-")) continue;
    return value === "db";
  }
  return false;
}

/** Run user arguments without changing process.exitCode or exiting the process. */
export async function runCli(args: readonly string[], context: ApplicationCommandContext = {}): Promise<number> {
  const invocationArgs = Object.freeze([...args]);
  const independentProjectCreation = projectCreationInvocation(invocationArgs);
  const resolved = resolveCommandContext({ ...context, root: context.root ?? projectRoot });
  const container = context.container ?? new ServiceContainer();
  const controller = new AbortController();
  const abort = () => controller.abort(context.signal?.reason);
  if (context.signal?.aborted) abort();
  else context.signal?.addEventListener("abort", abort, { once: true });
  let signalStatus = 0;
  // This native foreground shell shares the terminal process group; let sqlite3
  // interrupt its current query and remain interactive on terminal Ctrl+C.
  const deferTerminalInterrupt = interactiveDatabaseInvocation(invocationArgs);
  const interrupt = () => {
    if (deferTerminalInterrupt) return;
    signalStatus ||= 130;
    controller.abort(new Error("SIGINT"));
  };
  const terminate = () => { signalStatus ||= 143; controller.abort(new Error("SIGTERM")); };
  const lifecycle = async (event: Parameters<NonNullable<ApplicationCommandContext["onLifecycle"]>>[0]) => {
    const errors: unknown[] = [];
    try { await context.onLifecycle?.(event); } catch (error) { errors.push(error); }
    try { await context.lifecycle?.emit(event); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, errors.map(String).join("; "));
  };
  if (context.handleSignals !== false) {
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
  }
  const limit = context.maxCallDepth ?? 16;
  const invoke = async (argv: readonly string[], depth: number): Promise<number> => {
    if (!Number.isInteger(limit) || limit < 1 || depth > limit) {
      resolved.error("Error: maximum command call depth exceeded or invalid.");
      return 1;
    }
    const scope = container.createScope();
    const eventArgs = Object.freeze([...argv]);
    let status = 0;
    const failures: unknown[] = [];
    try {
      await lifecycle({ phase: "start", args: eventArgs });
      if (signalStatus) throw new Error("Command interrupted.");
      const installer = independentProjectCreation && depth === 1;
      const program = installer
        ? createCli({ root: resolved.root, env: resolved.env, output: context.output, error: context.error, signal: controller.signal, handleSignals: context.handleSignals, prompts: resolved.prompts })
        : await createApplicationCli({ ...context, root: resolved.root, env: resolved.env, services: scope, signal: controller.signal, call: next => invoke(next, depth + 1) });
      if (installer) program.configureOutput().writeErr = text => resolved.error(safeError(text, resolved.env));
      if (signalStatus) throw new Error("Command interrupted.");
      await program.parseAsync(argv.length ? [...argv] : ["list"], { from: "user" });
    } catch (error) {
      if (error instanceof CommanderError) status = error.exitCode;
      else { failures.push(error); status = 1; }
    } finally {
      // User I/O must not interrupt ownership cleanup or the finish lifecycle.
      try { await scope.dispose(); } catch (error) { failures.push(error); status = 1; }
      status = signalStatus || status;
      try { await lifecycle({ phase: "finish", args: eventArgs, status }); }
      catch (error) { failures.push(error); status = 1; }
    }
    for (const error of failures) resolved.error(`Error: ${safeError(error, resolved.env)}`);
    return signalStatus || status;
  };
  let status = 1;
  let providers: { dispose(): Promise<void> } | undefined;
  try {
    // Keep the established already-aborted-handler behavior when no provider
    // manifest exists. Configured bootstrap instead checks cancellation before
    // importing trusted provider source. This probe is not a filesystem lock.
    if (!independentProjectCreation) {
      let configured = false;
      try { await lstat(join(resolved.root, "providers.ts")); configured = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Unable to load application providers."); }
      if (!configured) {
        try { await lstat(join(resolved.root, "bootstrap", "cache", "packages.json")); configured = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Unable to load application providers."); }
      }
      if (configured) {
        const definitions = await loadProviderDefinitions(resolved.root, controller.signal);
        if (definitions.length) {
          if (context.container) throw new Error("Automatic application providers require a runner-owned container; compose provider lifecycle explicitly when embedding.");
          providers = await bootProviders({root:resolved.root,container,signal:controller.signal,definitions});
          controller.signal.throwIfAborted();
        }
      }
    }
    status = await invoke(invocationArgs, 1);
  }
  catch (error) { resolved.error(`Error: ${safeError(error, resolved.env)}`); }
  finally {
    try {
      const cleanupErrors: string[] = [];
      try { await providers?.dispose(); } catch { cleanupErrors.push("Error: Application provider disposal failed."); status = 1; }
      if (!context.container) {
        try { await container.dispose(); } catch (error) { cleanupErrors.push(`Error: ${safeError(error, resolved.env)}`); status = 1; }
      }
      // Settle every owned resource before invoking a potentially throwing sink.
      for (const error of cleanupErrors) resolved.error(error);
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
      context.signal?.removeEventListener("abort", abort);
    }
  }
  return signalStatus || status;
}
