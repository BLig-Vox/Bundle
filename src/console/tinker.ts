import { AsyncLocalStorage } from "node:async_hooks";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { PassThrough, Readable, Writable } from "node:stream";
import * as repl from "node:repl";
import type { ServiceScope } from "./services.ts";

export type TinkerInput = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown };
export type TinkerDatabase = { close(force?: boolean): unknown };
export type TinkerOptions = {
  root: string;
  input?: TinkerInput;
  output?: Writable;
  services?: ServiceScope;
  signal?: AbortSignal;
  execute?: string;
  openDatabase?: () => Promise<TinkerDatabase>;
};
export type TinkerReceipt = Readonly<{ evaluations: number; failures: number; interrupted: boolean; aborted: boolean }>;
const activeInputs = new WeakSet<object>();
type Evaluation = { settled: boolean; finish: (error?: unknown) => void };
type NativeServer = repl.REPLServer & { _userErrorHandler?: (error: Error) => "print" | "ignore" | "unhandled" };

/** Runs trusted developer JavaScript, not a security sandbox. */
export async function runTinker(options: TinkerOptions): Promise<TinkerReceipt> {
  if (!options || typeof options !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new TypeError("Invalid tinker options.");
  const keys = new Set(["root", "input", "output", "services", "signal", "execute", "openDatabase"]);
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !keys.has(key) || !("value" in Object.getOwnPropertyDescriptor(options, key)!)) throw new TypeError("Invalid tinker options.");
  }
  const { root, input: suppliedInput, output = process.stdout, services, signal, execute, openDatabase } = options;
  if (typeof root !== "string" || !isAbsolute(root) || root.includes("\0")) throw new TypeError("An absolute root is required.");
  if (execute !== undefined && (typeof execute !== "string" || !execute.trim() || Buffer.byteLength(execute) > 65536 || execute.includes("\0"))) throw new TypeError("Invalid execute source.");
  if (execute !== undefined && suppliedInput !== undefined) throw new TypeError("Execute cannot use external input.");
  if (openDatabase !== undefined && typeof openDatabase !== "function") throw new TypeError("Invalid database opener.");
  if (!(output instanceof Writable) || output.destroyed || output.writableEnded) throw new TypeError("Invalid tinker output.");
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError("Invalid tinker signal.");
  const canonicalRoot = await realpath(root);
  if (!(await stat(canonicalRoot)).isDirectory()) throw new TypeError("Root must be a directory.");
  const source: TinkerInput | undefined = execute === undefined ? suppliedInput ?? process.stdin : undefined;
  if (source && (!(source instanceof Readable) || source.isTTY !== true || source.destroyed || source.readableEnded)) throw new Error("Interactive tinker requires an available TTY.");
  if (source && activeInputs.has(source)) throw new Error("Tinker input is already in use.");
  const input = new PassThrough() as PassThrough & TinkerInput;
  const flowing = source?.readableFlowing;
  const raw = source?.isRaw;
  input.isTTY = source?.isTTY ?? false;
  input.setRawMode = mode => { source?.setRawMode?.(mode); input.isRaw = source?.isRaw ?? mode; };
  const require = createRequire(join(canonicalRoot, "__bundle_tinker__.js"));
  let databasePromise: Promise<TinkerDatabase> | undefined;
  let evaluations = 0, failures = 0, interrupted = false, aborted = false;
  let server: NativeServer | undefined;
  let failure: unknown;
  let closing = false, busy = false, ended = false, scheduled = false;
  let queued = Buffer.alloc(0);
  const active = new Set<Promise<void>>();
  const evaluationContext = new AsyncLocalStorage<Evaluation>();
  const database = () => {
    if (!openDatabase) throw new Error("Database access was not enabled.");
    databasePromise ??= Promise.resolve().then(openDatabase).then(db => {
      if (!db || typeof db.close !== "function") throw new TypeError("Invalid owned database.");
      return db;
    });
    return databasePromise;
  };
  const bindings = Object.freeze({ root: canonicalRoot, services, import: (modulePath: string) => {
    if (typeof modulePath !== "string" || !modulePath || modulePath.includes("\0")) throw new TypeError("Invalid module path.");
    const resolved = require.resolve(modulePath);
    return import(isAbsolute(resolved) ? pathToFileURL(resolved).href : resolved);
  }, database });
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const close = () => { closing = true; server?.close(); finish(); };
  const onError = (error: unknown) => { failure ??= error; close(); };
  const onAbort = () => { aborted = true; close(); };
  const onInterrupt = () => { interrupted = true; close(); };
  // Forward writes with callbacks so finalization drains only our output, never ends the caller stream.
  const sink = new Writable({ write(chunk, encoding, callback) {
    try { output.write(typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk, callback); } catch (error) { callback(error as Error); }
  } });
  Object.defineProperties(sink, {
    isTTY: { get: () => (output as Writable & { isTTY?: boolean }).isTTY },
    columns: { get: () => (output as Writable & { columns?: number }).columns },
  });
  const onResize = () => sink.emit("resize");
  const onOutputClose = () => { onError(new Error("Tinker output closed.")); sink.destroy(); };
  const pump = () => {
    scheduled = false;
    if (closing || busy) return;
    if (!queued.length) { if (ended) input.end(); return; }
    let length = queued.findIndex(byte => byte === 10 || byte === 13);
    length = length < 0 ? queued.length : length + 1;
    if (queued[length - 1] === 13 && queued[length] === 10) length++;
    const chunk = queued.subarray(0, length);
    queued = queued.subarray(length);
    input.write(chunk);
    schedule();
  };
  const schedule = () => { if (!scheduled && !closing) { scheduled = true; setImmediate(pump); } };
  const onData = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.includes(3)) { onInterrupt(); return; }
    if (queued.length + bytes.length > 65536) { onError(new Error("Tinker pending input exceeds 64 KiB.")); return; }
    queued = Buffer.concat([queued, bytes]); schedule();
  };
  const onEnd = () => { ended = true; schedule(); };
  if (source) activeInputs.add(source);
  try {
    source?.on("error", onError);
    output.on("error", onError);
    output.on("close", onOutputClose);
    output.on("resize", onResize);
    sink.on("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { aborted = true; }
    else {
      server = repl.start({ prompt: execute === undefined ? "bundle> " : "", input, output: sink, terminal: execute === undefined, useGlobal: false, ignoreUndefined: false }) as NativeServer;
      // Bun's default evaluator reports thrown errors here without invoking its callback.
      // Fail closed if that native contract changes, rather than guessing from lastError.
      if (!("_userErrorHandler" in server)) throw new Error("Unsupported native REPL error lifecycle.");
      Object.defineProperty(server.context, "bundle", { value: bindings, writable: false, configurable: false, enumerable: true });
      Object.defineProperty(server.context, "require", { value: require, writable: false, configurable: false, enumerable: true });
      const originalEval = server.eval;
      server._userErrorHandler = () => {
        const evaluation = evaluationContext.getStore();
        if (evaluation && !evaluation.settled) evaluation.finish(new Error("Native evaluation failed."));
        return "print";
      };
      (server as unknown as { eval: typeof originalEval }).eval = function (cmd, context, filename, callback) {
        busy = true;
        let resolve!: () => void;
        const pending = new Promise<void>(done => { resolve = done; });
        active.add(pending);
        const evaluation: Evaluation = { settled: false, finish(error) {
          if (evaluation.settled) return;
          evaluation.settled = true;
          if (!(error instanceof repl.Recoverable) || execute !== undefined) { evaluations++; if (error) failures++; }
          active.delete(pending); busy = false; resolve();
          if (execute !== undefined) queueMicrotask(close); else schedule();
        } };
        evaluationContext.run(evaluation, () => {
          try {
            originalEval.call(this, cmd, context, filename, (error, result) => {
              try { callback(error, result); } finally { evaluation.finish(error); }
            });
          } catch (error) { evaluation.finish(error); onError(error); }
        });
      };
      server.on("exit", () => { closing = true; finish(); });
      server.on("SIGINT", onInterrupt);
      if (execute !== undefined) {
        // One complete program, not multiple racing readline evaluations.
        server.eval(execute, server.context, "REPL", (error, result) => {
          sink.write(`${server!.writer(error instanceof repl.Recoverable ? error.err : error ?? result)}\n`);
        });
      } else {
        source!.on("data", onData);
        source!.on("end", onEnd);
        source!.on("close", onEnd);
        source!.resume();
      }
      await done;
    }
  } catch (error) { failure ??= error; }
  finally {
    closing = true;
    server?.close();
    while (active.size) await Promise.all([...active]);
    if (databasePromise) {
      // A caught opening failure is a JavaScript result, not a second cleanup failure.
      const db = await databasePromise.catch(() => undefined);
      if (db) try { await db.close(true); } catch { failure ??= new Error("Owned tinker database cleanup failed."); }
    }
    await new Promise<void>(resolve => {
      if (sink.destroyed || sink.writableFinished) resolve();
      else { sink.once("finish", resolve); sink.once("close", resolve); sink.end(); }
    });
    signal?.removeEventListener("abort", onAbort);
    source?.removeListener("error", onError);
    source?.removeListener("data", onData);
    source?.removeListener("end", onEnd);
    source?.removeListener("close", onEnd);
    output.removeListener("error", onError);
    output.removeListener("close", onOutputClose);
    output.removeListener("resize", onResize);
    input.destroy();
    sink.destroy();
    try {
      if (source) {
        if (raw !== undefined && source.isRaw !== raw) source.setRawMode?.(raw);
        if (flowing === true) source.resume(); else source.pause();
      }
    } finally { if (source) activeInputs.delete(source); }
  }
  if (failure !== undefined) throw failure;
  return Object.freeze({ evaluations, failures, interrupted, aborted });
}
