import { CommanderError, InvalidArgumentError, type Command } from "commander";
import { loadApplicationRouter, startApplicationServer, type ApplicationServer } from "../http/application.ts";
import { cacheRoutes, clearRouteCache } from "../http/route-cache.ts";

function port(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value) || Number(value) > 65535) throw new InvalidArgumentError("HTTP port must be an integer from 0 to 65535.");
  return Number(value);
}
function timeout(value: string): number {
  const duration = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(duration) || duration > 2147483647) throw new InvalidArgumentError("HTTP timeout must be a positive bounded integer.");
  return duration;
}

export function registerHttp(program: Command, context: { root: string; output: (text: string) => void; signal?: AbortSignal }): void {
  program.command("route:cache").description("Cache executable module-reference route definitions; replacement requires --force")
    .action(async () => context.output(JSON.stringify({ cached: await cacheRoutes(context.root, { overwrite: program.opts().force === true }) })));
  program.command("route:clear").description("Remove only the route-definition cache")
    .action(async () => context.output(JSON.stringify({ cleared: await clearRouteCache(context.root) })));
  program.command("route:list").description("Inspect trusted code-first routes from root routes.ts without serving")
    .option("--path <substring>", "Filter route paths")
    .option("--method <method>", "Filter one HTTP method")
    .option("--name <substring>", "Filter named routes")
    .option("--json", "Print structured route metadata")
    .option("-v, --verbose", "Include middleware names")
    .action(async (options: { path?: string; method?: string; name?: string; json?: boolean; verbose?: boolean }) => {
      const router = await loadApplicationRouter(context.root);
      const routes = router.describe().filter(route =>
        (options.path === undefined || route.path.includes(options.path)) &&
        (options.method === undefined || route.method === options.method.toUpperCase()) &&
        (options.name === undefined || (route.name ?? "").includes(options.name)));
      if (options.json) context.output(JSON.stringify({ routes }, null, 2));
      else context.output(routes.length ? routes.map(route => `${route.method} ${JSON.stringify(route.path)}${route.name ? ` ${JSON.stringify(route.name)}` : ""}${options.verbose ? ` middleware=${JSON.stringify(route.middleware)}` : ""}`).join("\n") : "No matching routes.");
    });
  program.command("serve").description("Serve trusted code-first routes with Bun (loopback by default)")
    .option("--host <host>", "Bind hostname or IP address", "127.0.0.1")
    .option("--port <port>", "Bind port; 0 selects an ephemeral port", port, 8000)
    .option("--timeout <milliseconds>", "Stop successfully after this duration", timeout)
    .action(async (options: { host: string; port: number; timeout?: number }) => {
      const controller = new AbortController();
      let status = 0;
      const abort = () => controller.abort(context.signal?.reason);
      if (context.signal?.aborted) abort();
      else context.signal?.addEventListener("abort", abort, { once: true });
      const interrupt = () => { status ||= 130; controller.abort(); };
      const terminate = () => { status ||= 143; controller.abort(); };
      process.on("SIGINT", interrupt);
      process.on("SIGTERM", terminate);
      let server: ApplicationServer | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        server = await startApplicationServer({ root: context.root, host: options.host, port: options.port, signal: controller.signal });
        context.output(JSON.stringify({ listening: server.url.toString() }));
        if (options.timeout !== undefined) timer = setTimeout(() => controller.abort(), options.timeout);
        let onAbort!: () => void;
        try {
          const cancelled = new Promise<void>(resolve => {
            onAbort = resolve;
            if (controller.signal.aborted) resolve();
            else controller.signal.addEventListener("abort", onAbort, { once: true });
          });
          await Promise.race([cancelled, server.closed]);
        } finally { controller.signal.removeEventListener("abort", onAbort); }
        if (status) throw new CommanderError(status, "bundle.httpExit", "HTTP server was stopped by a signal.");
        if (!controller.signal.aborted) throw new Error("HTTP server stopped unexpectedly.");
      } finally {
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", abort);
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
        await server?.stop();
      }
    });
}
