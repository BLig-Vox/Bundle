import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Router } from "./router.ts";
import { hydrateRoutes, isDefinedRoutes } from "./route-definitions.ts";
import { loadCachedRoutes } from "./route-cache.ts";

/** A trusted, default-exported root routes.ts router. Imports retain normal Bun ESM caching. */
export async function loadApplicationRouter(root: string): Promise<Pick<Router, "fetch" | "describe">> {
  const cached = await loadCachedRoutes(root);
  if (cached !== undefined) return hydrateRoutes(root, cached);
  const canonical = await realpath(root);
  const source = join(canonical, "routes.ts");
  let info;
  try { info = await lstat(source); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Application routes.ts does not exist; define code-first routes before serving.");
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("Application routes.ts must be a regular file without symlinks or hard links.");
  const router: unknown = (await import(pathToFileURL(source).href)).default;
  if (isDefinedRoutes(router)) return hydrateRoutes(root, router);
  if (!router || typeof router !== "object" || typeof (router as Router).fetch !== "function" || typeof (router as Router).describe !== "function") {
    throw new Error("Application routes.ts must default-export a Bundle router or defineRoutes([...]).");
  }
  return router as Pick<Router, "fetch" | "describe">;
}

export interface ApplicationServer {
  readonly url: URL;
  /** Resolves when the owned worker closes, including an unexpected exit. */
  readonly closed: Promise<void>;
  /** Stop accepting and close active connections; this never exits the embedding host. */
  stop(): Promise<void>;
}

/** Loopback by default; binding another interface is always an explicit caller choice. */
export async function startApplicationServer(options: { root: string; host?: string; port?: number; signal?: AbortSignal }): Promise<ApplicationServer> {
  const checkCancellation = () => { if (options.signal?.aborted) throw new Error("HTTP server startup cancelled."); };
  checkCancellation();
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8000;
  if (typeof host !== "string" || !host || host.length > 253 || !/^(?:[A-Za-z0-9.-]+|[A-Fa-f0-9:]+)$/.test(host)) throw new Error("Invalid HTTP bind host; provide a hostname or an IP address, not a URL.");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid HTTP bind port; use an integer from 0 to 65535.");
  // Import and serve in an owned worker so cancellation can interrupt even a
  // never-settling top-level await without terminating the embedding process.
  const worker = new Worker(new URL("./server-worker.ts", import.meta.url).href);
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>(resolve => { resolveClosed = resolve; });
  worker.addEventListener("close", () => { closed = true; resolveClosed(); });
  // Worker errors can contain application secrets; never forward their details.
  worker.addEventListener("error", event => { event.preventDefault(); worker.terminate(); });
  let stopped: Promise<void> | undefined;
  const stop = () => stopped ??= (async () => {
    if (closed) return;
    // Give normal connection shutdown a chance, but do not let application code
    // stuck in the worker prevent the embedding host from stopping the server.
    const timer = setTimeout(() => worker.terminate(), 250);
    try {
      worker.postMessage({ type: "stop" });
      await closedPromise;
    } finally { clearTimeout(timer); }
  })();
  try {
    const url = await new Promise<URL>((resolve, reject) => {
      const cleanup = () => {
        options.signal?.removeEventListener("abort", abort);
        worker.removeEventListener("message", message);
        worker.removeEventListener("error", failed);
        worker.removeEventListener("close", failed);
      };
      const abort = () => { cleanup(); worker.terminate(); void closedPromise.then(() => reject(new Error("HTTP server startup cancelled."))); };
      const failed = () => { cleanup(); worker.terminate(); void closedPromise.then(() => reject(new Error("HTTP server startup failed."))); };
      const message = (event: MessageEvent) => {
        if (event.data?.type === "failed") return failed();
        if (event.data?.type !== "ready") return;
        if (options.signal?.aborted) return abort();
        try { const value = new URL(event.data.url); cleanup(); resolve(value); }
        catch { failed(); }
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      worker.addEventListener("message", message);
      worker.addEventListener("error", failed);
      worker.addEventListener("close", failed);
      if (options.signal?.aborted) abort();
      else worker.postMessage({ type: "start", root: options.root, host, port });
    });
    // The signal applies to startup only; after readiness the caller owns stop().
    return Object.freeze({ url, closed: closedPromise, stop });
  } catch (error) {
    worker.terminate();
    throw error;
  }
}
