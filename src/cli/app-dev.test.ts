import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateApp } from "./apps.ts";

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for dev children");
    await Bun.sleep(20);
  }
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

for (const scenario of ["SIGINT", "SIGTERM", "vite failure", "server failure", "clean exit", "startup failure"] as const) {
  test(`generated dev supervisor cleans up on ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "bundle-dev-test-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    const pids: number[] = [];
    try {
      const app = join(root, await generateApp(root, "Demo"));
      await mkdir(join(app, "node_modules/vite/bin"), { recursive: true });
      for (const name of ["vite", "server"]) {
        const source = `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(root, name))}, String(process.pid));
process.on('SIGTERM', () => {});
const worker = Bun.spawn([process.execPath, '-e', ${JSON.stringify(`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(root, name + '-worker'))}, String(process.pid)); setInterval(() => {}, 1000);`)}], {stdout: 'ignore', stderr: 'ignore'});
${scenario === `${name} failure` || (scenario === "clean exit" && name === "vite")
  ? `setTimeout(() => process.exit(${scenario === "clean exit" ? 0 : 7}), 200);` : ""}
setInterval(() => {}, 1000);`;
        await writeFile(join(app, name === "vite" ? "node_modules/vite/bin/vite.js" : "scripts/bundle.ts"), source);
      }
      if (scenario === "startup failure") await rm(join(app, "node_modules/vite/bin/vite.js"));
      child = Bun.spawn([process.execPath, "run", join(app, "scripts/dev.ts")], { cwd: root, stdout: "pipe", stderr: "pipe" });
      const watchdog = setTimeout(() => child?.kill("SIGKILL"), 6000);
      try {
        if (scenario !== "startup failure") {
          await until(async () => {
            for (const name of ["vite", "server", "vite-worker", "server-worker"]) {
              const pid = Number(await readFile(join(root, name), "utf8").catch(() => "0"));
              if (!pid) return false;
              if (!pids.includes(pid)) pids.push(pid);
            }
            return true;
          });
          if (scenario === "SIGINT" || scenario === "SIGTERM") child.kill(scenario);
        }
        const code = await child.exited;
        expect(code).toBe(scenario === "SIGINT" ? 130 : scenario === "SIGTERM" ? 143 : scenario === "clean exit" ? 1 : scenario === "startup failure" ? 1 : 7);
        for (const pid of pids) expect(alive(pid)).toBe(false);
      } finally { clearTimeout(watchdog); }
    } finally {
      child?.kill("SIGKILL");
      if (child) await child.exited;
      for (const name of ["vite", "server", "vite-worker", "server-worker"]) {
        const pid = Number(await readFile(join(root, name), "utf8").catch(() => "0"));
        if (pid && alive(pid)) process.kill(pid, "SIGKILL");
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
}

test("generated dev rejects invalid ports before starting children", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-dev-ports-"));
  try {
    const app = join(root, await generateApp(root, "Ports"));
    for (const [name, value] of [["BUNDLE_PORT", "0"], ["BUNDLE_PORT", "65536"], ["VITE_PORT", "abc"], ["VITE_PORT", "1e3"]]) {
      const child = Bun.spawn([process.execPath, "run", "scripts/dev.ts"], {
        cwd: app, env: { ...process.env, [name!]: value! }, stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      try {
        expect(await child.exited).toBe(1);
        expect(await new Response(child.stderr).text()).toContain(`${name} must be a TCP port`);
      } finally { clearTimeout(timer); child.kill("SIGKILL"); await child.exited; }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 10_000);

// Reuse an explicitly supplied dependency tree for runtime validation only.
// This does not claim to validate installation of the generated package.
const dependencies = process.env.BUNDLE_DEV_NODE_MODULES;
test.skipIf(!dependencies)("generated dev serves frontend and proxied health on free ports, then releases both ports", async () => {
  const root = await mkdtemp(join(tmpdir(), "bundle-dev-integration-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const reservations: ReturnType<typeof Bun.serve>[] = [];
  let ports: number[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      try { reservations.push(Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") })); }
      catch (error) { console.error("Socket bind unavailable:", error); throw error; }
    }
    ports = reservations.map(server => server.port!);
    const app = join(root, await generateApp(root, "Integration"));
    await symlink(dependencies!, join(app, "node_modules"));
    for (const server of reservations) await server.stop(true);
    child = Bun.spawn([process.execPath, "run", "dev"], {
      cwd: app, env: { ...process.env, VITE_PORT: String(ports[0]), BUNDLE_PORT: String(ports[1]) },
      stdout: "pipe", stderr: "pipe", detached: true,
    });
    const output = new Response(child.stdout as ReadableStream<Uint8Array>).text();
    const errors = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    const stop = () => { try { process.kill(-child!.pid, "SIGTERM"); } catch {} };
    const watchdog = setTimeout(stop, 12_000);
    try {
      await until(async () => {
        try {
          const frontend = await fetch(`http://127.0.0.1:${ports[0]}/`, { signal: AbortSignal.timeout(300) });
          const health = await fetch(`http://127.0.0.1:${ports[0]}/api/health`, { signal: AbortSignal.timeout(300) });
          return frontend.ok && (await frontend.text()).includes("/src/main.tsx") && health.ok && ((await health.json()) as { status?: string }).status === "ok";
        } catch { return false; }
      });
      stop();
      expect(await child.exited).toBe(143);
    } catch (error) {
      stop();
      await child.exited;
      console.error(await output, await errors);
      throw error;
    } finally { clearTimeout(watchdog); }
    for (const port of ports) {
      const probe = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("released") });
      await probe.stop(true);
    }
    console.log(`Generated dev integration passed on ports ${ports.join(" and ")}; both ports released.`);
  } finally {
    if (child) { try { process.kill(-child.pid, "SIGTERM"); } catch {} await child.exited; }
    for (const server of reservations) await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
