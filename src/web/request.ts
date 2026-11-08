import type { Schema } from "../validation/schema.ts";
import { HttpError } from "./http-error.ts";

/** Parse untrusted UTF-8 JSON; callers must validate the returned value's shape. */
export async function readJson(
  request: Request,
  { maxBytes = 64 * 1024 }: { maxBytes?: number } = {},
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)) {
    throw new HttpError(415, "Unsupported Media Type");
  }
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^[0-9]+$/.test(length)) throw new HttpError(400, "Invalid Content-Length");
    if (Number(length) > maxBytes) {
      // Cancellation must not delay or replace the safe error if the producer fails.
      if (request.body) void request.body.cancel().catch(() => {});
      throw new HttpError(413, "Payload Too Large");
    }
  }
  if (!request.body) throw new HttpError(400, "Empty JSON body");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new HttpError(413, "Payload Too Large");
      }
      try {
        text += decoder.decode(value, { stream: true });
      } catch {
        void reader.cancel().catch(() => {});
        throw new HttpError(400, "Invalid JSON");
      }
    }
    try {
      text += decoder.decode();
    } catch {
      throw new HttpError(400, "Invalid JSON");
    }
  } finally {
    reader.releaseLock();
  }
  if (text.trim() === "") throw new HttpError(400, "Empty JSON body");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

/** Parse bounded JSON and validate its shape without exposing schema diagnostics. */
export async function readValidatedJson<T>(
  request: Request,
  schema: Schema<T>,
  options: { maxBytes?: number } = {},
): Promise<T> {
  const result = schema.safeParse(await readJson(request, options));
  if (!result.success) throw new HttpError(400, "Invalid request body");
  return result.data;
}
