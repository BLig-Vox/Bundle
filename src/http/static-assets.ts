import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { extname } from "node:path";

const contentTypes: Readonly<Record<string, string>> = Object.freeze({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json; charset=utf-8" });
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW;

async function closeQuietly(handle: FileHandle): Promise<void> { try { await handle.close(); } catch { /* Closing an already-closed descriptor is harmless. */ } }
function descriptorPath(directory: FileHandle, child: string): string { return `/proc/self/fd/${directory.fd}/${child}`; }

async function openAsset(root: FileHandle, parts: readonly string[]): Promise<{ handle: FileHandle; name: string } | undefined> {
  let directory: FileHandle | undefined;
  try {
    directory = await open(descriptorPath(root, "dist"), directoryFlags);
    if (!(await directory.stat()).isDirectory()) return undefined;
    const pathParts = parts.length ? parts : ["index.html"];
    for (const part of pathParts.slice(0, -1)) {
      const next = await open(descriptorPath(directory, part), directoryFlags);
      await closeQuietly(directory);
      directory = next;
    }
    const name = pathParts.at(-1)!;
    const handle = await open(descriptorPath(directory, name), fileFlags);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) { await closeQuietly(handle); return undefined; }
    return { handle, name };
  } catch { return undefined; }
  finally { if (directory) await closeQuietly(directory); }
}

async function fileResponse(request: Request, handle: FileHandle, name: string): Promise<Response> {
  const info = await handle.stat();
  const headers = new Headers({ "content-type": contentTypes[extname(name).toLowerCase()] ?? "application/octet-stream", "x-content-type-options": "nosniff", "content-length": String(info.size) });
  headers.set("cache-control", name === "index.html" ? "no-cache" : "public, max-age=31536000, immutable");
  if (request.method === "HEAD") {
    await closeQuietly(handle);
    return new Response(null, { status: 200, headers });
  }
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await closeQuietly(handle); };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      const buffer = new Uint8Array(64 * 1024);
      try {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) { controller.close(); await close(); }
        else controller.enqueue(buffer.slice(0, bytesRead));
      } catch (error) { controller.error(error); await close(); }
    },
    cancel: close,
  });
  return new Response(body, { status: 200, headers });
}

/** Serve only descriptor-opened files rooted beneath an already-open application directory. */
export async function publicAssetResponse(root: FileHandle, request: Request): Promise<Response | undefined> {
  if (process.platform !== "linux" || (request.method !== "GET" && request.method !== "HEAD")) return undefined;
  let pathname: string;
  try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return undefined; }
  const parts = pathname.split("/").filter(Boolean);
  if (parts.some(part => part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) return undefined;
  const rootInfo = await root.stat();
  if (!rootInfo.isDirectory()) return undefined;
  const acceptHtml = request.headers.get("accept")?.includes("text/html") === true;
  let asset = await openAsset(root, parts);
  if (!asset && acceptHtml && parts.length) asset = await openAsset(root, ["index.html"]);
  return asset ? fileResponse(request, asset.handle, asset.name) : undefined;
}
