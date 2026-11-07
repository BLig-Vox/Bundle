import { pathToFileURL } from "node:url";
import { checkedRouteFile } from "../http/route-definitions.ts";
import { validateJobMiddlewareReferences, type JobMiddlewareReference } from "./middleware-definitions.ts";

export interface JobMiddlewareContext { job: unknown; signal: AbortSignal }
/** Plain next always propagates failure to the pipeline, even if locally caught.
 * Use recover to explicitly handle downstream failure; both forms consume next once. */
export interface JobMiddlewareNext {
  (): Promise<void>;
  recover(handler: (error: unknown) => void | Promise<void>): Promise<void>;
}
export type JobMiddleware = (context: JobMiddlewareContext, next: JobMiddlewareNext) => void | Promise<void>;

const isClass = (value: unknown): boolean => typeof value === "function" && /^\s*class\b/.test(Function.prototype.toString.call(value));

/** Run trusted application middleware inside the caller's execution boundary; not a sandbox. */
export async function runJobMiddleware(options: {root: string; references: readonly JobMiddlewareReference[]; context: JobMiddlewareContext; run: () => Promise<void>}): Promise<void> {
  const references = validateJobMiddlewareReferences(options.references);
  const {root, context, run} = options;
  context.signal.throwIfAborted();
  const handlers: JobMiddleware[] = [];
  for (const ref of references) {
    const file = await checkedRouteFile(root, ref.module);
    context.signal.throwIfAborted();
    const module = await import(pathToFileURL(file).href);
    context.signal.throwIfAborted();
    if (!Object.hasOwn(module, ref.export)) throw new Error("Missing job middleware export");
    const target: unknown = module[ref.export];
    if (ref.method !== undefined) {
      if (!isClass(target)) throw new Error("Job middleware class required");
      const Class = target as new () => object;
      const method: unknown = Object.getOwnPropertyDescriptor(Class.prototype, ref.method)?.value;
      if (typeof method !== "function") throw new Error("Job middleware own method required");
      handlers.push((ctx, next) => method.call(new Class(), ctx, next));
    } else {
      if (typeof target !== "function" || isClass(target)) throw new Error("Job middleware function required");
      handlers.push(target as JobMiddleware);
    }
  }
  async function dispatch(index: number): Promise<void> {
    context.signal.throwIfAborted();
    if (index === handlers.length) { await run(); context.signal.throwIfAborted(); return; }
    let called = false;
    let closed = false;
    let duplicate: Error | undefined;
    let downstream: Promise<void> | undefined;
    const start = (recover?: (error: unknown) => void | Promise<void>): Promise<void> => {
      if (called || closed) {
        duplicate = new Error("next() called more than once or after middleware completion");
        const rejected = Promise.reject(duplicate);
        void rejected.catch(() => {});
        return rejected;
      }
      called = true;
      const work = dispatch(index + 1);
      downstream = recover ? work.catch(recover) : work;
      void downstream.catch(() => {});
      return downstream;
    };
    const next: JobMiddlewareNext = Object.assign(() => start(), {
      recover: (handler: (error: unknown) => void | Promise<void>) => {
        if (typeof handler !== "function") throw new TypeError("Recovery handler must be a function");
        return start(handler);
      },
    });
    let failed = false; let failure: unknown;
    try { await handlers[index]!(context, next); } catch (error) { failed = true; failure = error; }
    closed = true;
    if (downstream) {
      try { await downstream; } catch (error) { if (!failed) { failed = true; failure = error; } }
    }
    if (duplicate) throw duplicate;
    if (failed) throw failure;
    context.signal.throwIfAborted();
  }
  await dispatch(0);
}
