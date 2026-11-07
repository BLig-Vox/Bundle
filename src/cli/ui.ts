import type { Command } from "commander";

export interface UiCommandContext { root: string; output: (text: string) => void; signal?: AbortSignal }

/** Run Vite through its native API so Bundle owns startup, HMR and shutdown. */
export function registerUi(program: Command, context: UiCommandContext): void {
  program.command("ui:dev").description("Run the Vite React frontend with HMR").action(async () => {
    if (context.signal?.aborted) throw new Error("Vite startup cancelled.");
    context.output("Starting Vite frontend...");
    const { createServer } = await import("vite");
    const server = await createServer({ configFile: `${context.root}/vite.config.ts`, root: context.root, logLevel: "info" });
    let onAbort!: () => void;
    const aborted = new Promise<void>(resolve => {
      onAbort = resolve;
      if (context.signal?.aborted) resolve();
      else context.signal?.addEventListener("abort", onAbort, { once: true });
    });
    let closed!: () => void;
    const stopped = new Promise<void>(resolve => { closed = resolve; server.httpServer?.once("close", resolve); });
    try {
      if (context.signal?.aborted) throw new Error("Vite startup cancelled.");
      await server.listen();
      const address = server.httpServer?.address();
      if (!server.httpServer?.listening || !address || typeof address === "string") throw new Error("Vite did not bind a listening TCP address.");
      const boundHost = address.address === "0.0.0.0" || address.address === "::" ? "127.0.0.1" : address.address;
      const boundUrl = `http://${boundHost.includes(":") ? `[${boundHost}]` : boundHost}:${address.port}/`;
      context.output(`Vite frontend listening at ${server.resolvedUrls?.local?.[0] ?? boundUrl}`);
      await Promise.race([aborted, stopped]);
      if (!context.signal?.aborted) throw new Error("Vite server closed unexpectedly.");
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
      await server.close();
      if (!server.httpServer?.listening) closed();
      await stopped;
    }
  });
  program.command("ui:build").description("Build the React frontend into the backend's dist/ public directory").action(async () => {
    const { build } = await import("vite");
    await build({ configFile: `${context.root}/vite.config.ts`, root: context.root, logLevel: "info" });
    context.output("Built frontend assets in dist/");
  });
}
