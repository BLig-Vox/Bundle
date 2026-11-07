import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { startApplicationServer, type ApplicationServer } from "./application.ts";

export interface HttpTestOptions { readonly root: string; readonly signal?: AbortSignal }
export interface HttpTestClient {
  request(path: string, init?: RequestInit): Promise<Response>;
}

/** Validate a test target without resolving/importing any application module. */
export function validateHttpTestPath(path: string): void {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || /[\\#\x00-\x1f\x7f]/.test(path) || Buffer.byteLength(path) > 8192) throw new TypeError("HTTP test path must be a bounded root-relative path without authority, fragment or control characters.");
}

/** Exercise the actual application worker over an owned loopback listener, not a mock router. */
export async function withHttpApplication<T>(options: HttpTestOptions, callback: (client: HttpTestClient) => T | Promise<T>): Promise<T> {
  if (!options || typeof options !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new TypeError("Invalid HTTP test options.");
  for (const key of Reflect.ownKeys(options)) {
    if ((key !== "root" && key !== "signal") || !("value" in Object.getOwnPropertyDescriptor(options, key)!)) throw new TypeError("Invalid HTTP test options.");
  }
  const { root, signal } = options;
  if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0")) throw new TypeError("HTTP test root must be absolute.");
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("Invalid HTTP test signal.");
  if (typeof callback !== "function") throw new TypeError("HTTP test callback is required.");
  const check = () => { if (signal?.aborted) throw new Error("HTTP test cancelled."); };
  check();
  const canonical = await realpath(root);
  if (!(await stat(canonical)).isDirectory()) throw new TypeError("HTTP test root must be a directory.");
  check();
  let server: ApplicationServer | undefined;
  const requests = new AbortController();
  const abort = () => { requests.abort(); if (server) void server.stop().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    check();
    server = await startApplicationServer({ root: canonical, host: "127.0.0.1", port: 0, ...(signal ? { signal } : {}) });
    check();
    const base = server.url.toString();
    let accepting = true;
    const client: HttpTestClient = Object.freeze({ async request(path: string, init?: RequestInit) {
      if (!accepting) throw new Error("HTTP test client is closed.");
      check(); validateHttpTestPath(path);
      const url = new URL(path, base);
      if (url.origin !== new URL(base).origin) throw new TypeError("HTTP test path must retain the owned origin.");
      const native = new Request(url.toString(), init);
      const request = new Request(native, { redirect: "manual", signal: AbortSignal.any([native.signal, requests.signal]) });
      return fetch(request);
    } });
    try { const result = await callback(client); check(); return result; }
    finally { accepting = false; }
  } finally {
    requests.abort();
    try { await server?.stop(); check(); }
    finally { signal?.removeEventListener("abort", abort); }
  }
}
