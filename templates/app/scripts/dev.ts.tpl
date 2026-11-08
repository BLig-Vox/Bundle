import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const children: ChildProcess[] = [];
const exits: Promise<void>[] = [];
let finish!: (code: number) => void;
const finished = new Promise<number>(resolve => { finish = resolve; });
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  finish(code);
}
const interrupt = () => stop(130);
const terminate = () => stop(143);
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);

function start(args: string[]) {
  const child = spawn(process.execPath, args, {
    cwd: root, stdio: "inherit", detached: process.platform !== "win32",
  });
  children.push(child);
  exits.push(new Promise(resolve => {
    child.once("error", error => { console.error(error.message); stop(1); resolve(); });
    child.once("exit", code => { stop(code || 1); resolve(); });
  }));
}
function signalChildren(signal: NodeJS.Signals) {
  for (const child of children) {
    if (!child.pid) continue;
    try {
      // Each child owns a process group so Vite workers are also cleaned up.
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") console.error(error);
    }
  }
}

try {
  for (const name of ["BUNDLE_PORT", "VITE_PORT"]) {
    const value = process.env[name];
    if (value !== undefined && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) {
      throw new Error(`${name} must be a TCP port from 1 to 65535.`);
    }
  }
  start(["run", "scripts/bundle.ts", "serve", "--mode", "routes", "--host", "127.0.0.1", "--port", process.env.BUNDLE_PORT ?? "3000"]);
  start(["--bun", "node_modules/vite/bin/vite.js", ...process.argv.slice(2)]);
  process.exitCode = await finished;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  stopping = true;
  signalChildren("SIGTERM");
  // Bound shutdown even if a child or one of its descendants ignores SIGTERM.
  await new Promise(resolve => setTimeout(resolve, 500));
  signalChildren("SIGKILL");
  await Promise.all(exits);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
}
