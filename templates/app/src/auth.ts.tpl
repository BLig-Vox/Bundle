import { createContextKey, type Middleware } from "./web/router.ts";
import { withDatabase } from "bundle/src/database/connection.ts";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { EntityManager } from "@mikro-orm/core";
import type { Environment } from "bundle/src/database/config.ts";
import { Session } from "./models/Session.ts";

export const appRoot = fileURLToPath(new URL("../", import.meta.url));
export const sessionSeconds = 7 * 24 * 60 * 60;
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
export const failure = (status: number, message: string) => new Response(message, { status, headers: { "Cache-Control": "no-store" } });

export function authPolicy(env: Environment) {
  const production = env.NODE_ENV === "production" || env.APP_ENV === "production";
  // Never derive trust from request Host, URL or forwarded headers. This fallback
  // matches the loopback Vite dev server, including its explicitly configured port.
  const configured = env.APP_PUBLIC_ORIGIN ?? (production ? undefined : `http://127.0.0.1:${env.VITE_PORT ?? "5173"}`);
  if (!configured) throw new Error("APP_PUBLIC_ORIGIN is required in production.");
  const url = new URL(configured);
  if (url.origin !== configured || !["http:", "https:"].includes(url.protocol) || (production && url.protocol !== "https:")) {
    throw new Error("APP_PUBLIC_ORIGIN must be an exact origin (HTTPS in production).");
  }
  return {
    accepts: (request: Request) => request.headers.get("origin") === configured,
    cookie: (token: string, clear = false) => `bundle_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${clear ? 0 : sessionSeconds}${production ? "; Secure" : ""}`,
  };
}

export function presentedToken(request: Request): string | undefined {
  const values = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.split("=", 1)[0] === "bundle_session");
  if (values.length !== 1) return;
  const token = values[0]!.slice("bundle_session=".length);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : undefined;
}
export async function sessionUser(em: EntityManager, request: Request) {
  const token = presentedToken(request);
  if (!token) return null;
  const session = await em.findOne(Session, { tokenHash: hashToken(token), expiresAt: { $gt: new Date() } }, { populate: ["user"] });
  return session?.user ?? null;
}
export async function revokePresented(em: EntityManager, request: Request) {
  const token = presentedToken(request);
  if (token) await em.nativeDelete(Session, { tokenHash: hashToken(token) });
}

// Only the user ID crosses the auth/handler boundary; never store tokens or sessions.
export const authenticatedUserId = createContextKey<number>(Symbol("authenticatedUserId"));
export function createRequireAuth(env: Environment = process.env): Middleware {
  const policy = authPolicy(env);
  return async (request, next, context) => {
    // Reject mutations before token parsing, database initialization or session lookup.
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && !policy.accepts(request)) return failure(403, "Forbidden");
    if (!presentedToken(request)) return failure(401, "Unauthorized");
    const id = await withDatabase(async orm => (await sessionUser(orm.em.fork(), request))?.id, { root: appRoot, env });
    if (id === undefined || !context) return failure(401, "Unauthorized");
    context.set(authenticatedUserId, id);
    return next();
  };
}
