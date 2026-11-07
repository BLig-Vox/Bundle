import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { loadApplicationRouter } from "./application.ts";
import { publicAssetResponse } from "./static-assets.ts";
import { maintenanceResponse } from "../maintenance/maintenance.ts";

declare const self: {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown): void;
  close(): void;
};

// Only the owning thread sends these messages. Application modules remain trusted
// code and may have side effects outside this worker's lifetime.
self.addEventListener("message", async (event: MessageEvent) => {
  if (event.data?.type !== "start") return;
  let rootDirectory: FileHandle | undefined;
  try {
    const { root: sourceRoot, host, port } = event.data as { root: string; host: string; port: number };
    const root = await realpath(sourceRoot);
    rootDirectory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const router = await loadApplicationRouter(root);
    const server = Bun.serve({
      hostname: host,
      port,
      reusePort: false,
      development: false,
      fetch: async request => {
        // Read on every request so CLI down/up reaches an already-running worker.
        // Unsafe/corrupt state fails closed without exposing filesystem/module text.
        let maintenance: Response | undefined;
        try { maintenance = await maintenanceResponse(root, request); }
        catch { return new Response(request.method === "HEAD" ? null : JSON.stringify({ error: "Service unavailable" }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } }); }
        if (maintenance) return maintenance;
        const response = await router.fetch(request);
        if (response.status !== 404 || new URL(request.url).pathname === "/api" || new URL(request.url).pathname.startsWith("/api/")) return response;
        return await publicAssetResponse(rootDirectory!, request) ?? response;
      },
      error: () => Response.json({ error: "Internal server error" }, { status: 500 }),
    });
    self.addEventListener("message", async (message: MessageEvent) => {
      if (message.data?.type !== "stop") return;
      try { await server.stop(true); } finally { await rootDirectory?.close(); rootDirectory = undefined; self.close(); }
    });
    self.postMessage({ type: "ready", url: server.url.toString() });
  } catch {
    try { await rootDirectory?.close(); } catch { /* Worker exit still releases its descriptors. */ }
    self.postMessage({ type: "failed" });
    self.close();
  }
});
