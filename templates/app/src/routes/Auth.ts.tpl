import { timingSafeEqual } from "node:crypto";
import type { RouteContext } from "../web/router.ts";
import { UniqueConstraintViolationException } from "@mikro-orm/core";
import type { Environment } from "bundle/src/database/config.ts";
import { withDatabase } from "bundle/src/database/connection.ts";
import { RouteConfigurationError } from "bundle/src/web/server.ts";
import { HttpError } from "bundle/src/web/http-error.ts";
import { readValidatedJson } from "bundle/src/web/request.ts";
import { schema, type Schema } from "bundle/src/validation/schema.ts";
import { User } from "../models/User.ts";
import { Session } from "../models/Session.ts";
import { appRoot, authenticatedUserId, presentedToken, authPolicy, failure, hashToken, newToken, revokePresented, sessionSeconds, sessionUser } from "../auth.ts";

const invalid = "Invalid credentials.";
const passwordSchema = schema.string({ min: 12, max: 1024 });
const credentialsSchema = schema.object({ email: schema.string({ max: 320 }), password: passwordSchema });
const passwordChangeSchema = schema.object({ currentPassword: passwordSchema, newPassword: passwordSchema });
async function readCredentials<T>(request: Request, shape: Schema<T>): Promise<T> {
  try {
    return await readValidatedJson(request, shape, { maxBytes: 4096 });
  } catch (error) {
    // Retain the generic credential response while preserving JSON/media/size errors.
    if (error instanceof HttpError && error.status === 400 && error.message === "Invalid request body") {
      throw new HttpError(400, invalid);
    }
    throw error;
  }
}
async function credentials(request: Request) {
  const { email: raw, password } = await readCredentials(request, credentialsSchema);
  if (Buffer.byteLength(password, "utf8") > 1024) throw new HttpError(400, invalid);
  // Policy: trim ASCII space/tab/CR/LF at the edges, then lowercase ASCII only.
  // No Unicode folding, plus/dot rewriting or provider-specific aliases.
  if (/[^\x00-\x7f]/.test(raw)) throw new HttpError(400, invalid);
  const email = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").toLowerCase();
  const [local, domain] = email.split("@");
  if (email.length > 254 || !local || local.length > 64 || !domain
    || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9.-]+$/.test(email)
    || local.startsWith(".") || local.endsWith(".") || local.includes("..")
    || domain.split(".").length < 2 || domain.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new HttpError(400, invalid);
  return { email, password };
}

async function passwordChange(request: Request) {
  const data = await readCredentials(request, passwordChangeSchema);
  for (const password of [data.currentPassword, data.newPassword]) {
    if (Buffer.byteLength(password, "utf8") > 1024) throw new HttpError(400, invalid);
  }
  return data;
}

/** Shared scope is an assertion by reviewed application code, not a provider implementation.
 * consume must atomically charge one register/login attempt across all workers/hosts,
 * retain the window across app restarts, and reject on storage failure. No credentials
 * or untrusted client/IP identity are passed to this application-wide limiter.
 */
export interface AuthAttemptLimiter {
  readonly scope: "process" | "shared";
  consume(): { allowed: true } | { allowed: false; retryAfterSeconds: number }
    | Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>;
}

/** Bounded development guard: one bucket per handler set, no IP/header trust or maps. */
export function createProcessAuthAttemptLimiter(): AuthAttemptLimiter {
  let attempts = 0; let resetAt = 0;
  return Object.freeze({
    scope: "process" as const,
    consume() {
      const now = Date.now();
      if (now >= resetAt) { attempts = 0; resetAt = now + 60_000; }
      // Saturate the counter: rejected attempts must not grow process state.
      if (attempts >= 20) return { allowed: false as const, retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
      attempts++;
      return { allowed: true as const };
    },
  });
}

export const productionLimiterError = "Production auth requires an explicitly injected shared AuthAttemptLimiter. Implement and review a cross-process adapter, then pass it to createRoutes(env, limiter).";

export function createAuthHandlers(env: Environment = process.env, limiter?: AuthAttemptLimiter) {
  if ((env.NODE_ENV === "production" || env.APP_ENV === "production") && limiter?.scope !== "shared") {
    throw new RouteConfigurationError(productionLimiterError);
  }
  const policy = authPolicy(env);
  const attempts = limiter ?? createProcessAuthAttemptLimiter();
  const authenticate = (register: boolean) => async (request: Request): Promise<Response> => {
    if (!policy.accepts(request)) return failure(403, "Forbidden");
    const decision = await attempts.consume();
    if (!decision.allowed) {
      if (!Number.isFinite(decision.retryAfterSeconds) || decision.retryAfterSeconds <= 0) throw new Error("Invalid auth limiter decision.");
      return new Response("Too Many Requests", { status: 429, headers: { "Retry-After": String(Math.ceil(decision.retryAfterSeconds)), "Cache-Control": "no-store" } });
    }
    const { email, password } = await credentials(request);
    return withDatabase(async orm => {
      const em = orm.em.fork();
      let user = await em.findOne(User, { email });
      if (register) {
        if (user) return failure(400, invalid);
        const passwordHash = await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 65536, timeCost: 2 });
        user = em.create(User, { email, passwordHash });
      } else {
        // Hash an unknown account too, avoiding a fast account-existence path.
        const valid = user ? await Bun.password.verify(password, user.passwordHash)
          : (await Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 65536, timeCost: 2 }), false);
        if (!user || !valid) return failure(401, invalid);
      }
      const token = newToken();
      try {
        await em.transactional(async tx => {
          await revokePresented(tx, request);
          tx.persist(user!);
          tx.persist(tx.create(Session, { user: user!, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + sessionSeconds * 1000) }));
          await tx.flush();
        });
      } catch (error) {
        if (error instanceof UniqueConstraintViolationException) return failure(400, invalid);
        throw error;
      }
      return Response.json({ id: user.id, email: user.email }, { status: register ? 201 : 200, headers: { "Set-Cookie": policy.cookie(token), "Cache-Control": "no-store" } });
    }, { root: appRoot, env });
  };
  return {
    register: authenticate(true), login: authenticate(false),
    sessions: async (request: Request, context?: RouteContext) => {
      const owner = context?.get(authenticatedUserId);
      const token = presentedToken(request);
      if (owner === undefined || !token) return failure(401, "Unauthorized");
      const currentHash = Buffer.from(hashToken(token), "hex");
      return withDatabase(async orm => {
        const sessions = await orm.em.fork().find(Session, { user: owner, expiresAt: { $gt: new Date() } }, {
          fields: ["id", "expiresAt", "tokenHash"], orderBy: { id: "desc" }, limit: 50,
        });
        return Response.json(sessions.map(session => ({
          id: session.id, expiresAt: session.expiresAt.toISOString(),
          current: /^[a-f0-9]{64}$/.test(session.tokenHash) && timingSafeEqual(Buffer.from(session.tokenHash, "hex"), currentHash),
        })), { headers: { "Cache-Control": "no-store" } });
      }, { root: appRoot, env });
    },
    revokeSession: async (request: Request, context?: RouteContext) => {
      // Also guard direct calls: Origin must precede cookie parsing or database work.
      if (!policy.accepts(request)) return failure(403, "Forbidden");
      const owner = context?.get(authenticatedUserId);
      const token = presentedToken(request);
      if (owner === undefined || !token) return failure(401, "Unauthorized");
      const raw = context?.params.id ?? "";
      const id = Number(raw);
      if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(id)) return failure(400, "Invalid session ID.");
      const currentHash = Buffer.from(hashToken(token), "hex");
      return withDatabase(async orm => {
        const em = orm.em.fork();
        const scope = { id, user: owner, expiresAt: { $gt: new Date() } };
        const target = await em.findOne(Session, scope, { fields: ["tokenHash"] });
        if (!target) return failure(404, "Not Found");
        if (/^[a-f0-9]{64}$/.test(target.tokenHash) && timingSafeEqual(Buffer.from(target.tokenHash, "hex"), currentHash)) {
          return failure(409, "Cannot revoke current session.");
        }
        const deleted = await em.nativeDelete(Session, { ...scope, expiresAt: { $gt: new Date() } });
        return deleted === 1 ? new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } }) : failure(404, "Not Found");
      }, { root: appRoot, env });
    },
    password: async (request: Request) => {
      if (!policy.accepts(request)) return failure(403, "Forbidden");
      const { currentPassword, newPassword } = await passwordChange(request);
      return withDatabase(async orm => {
        const em = orm.em.fork();
        const user = await sessionUser(em, request);
        if (!user) return failure(401, "Unauthorized");
        const previousHash = user.passwordHash;
        if (!await Bun.password.verify(currentPassword, previousHash)) return failure(401, invalid);
        const passwordHash = await Bun.password.hash(newPassword, { algorithm: "argon2id", memoryCost: 65536, timeCost: 2 });
        const token = newToken();
        const changed = await em.transactional(async tx => {
          // Recheck the session after hashing, which may overlap a revocation.
          if (!await sessionUser(tx, request)) return false;
          // Compare-and-update in the database: identity-map reads cannot protect
          // against another request changing the credential while we hash.
          if (await tx.nativeUpdate(User, { id: user.id, passwordHash: previousHash }, { passwordHash }) !== 1) return false;
          await tx.nativeDelete(Session, { user: user.id });
          tx.persist(tx.create(Session, { user: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + sessionSeconds * 1000) }));
          await tx.flush();
          return true;
        });
        return changed ? new Response(null, { status: 204, headers: { "Set-Cookie": policy.cookie(token), "Cache-Control": "no-store" } }) : failure(401, invalid);
      }, { root: appRoot, env });
    },
    me: (request: Request) => withDatabase(async orm => {
      const user = await sessionUser(orm.em.fork(), request);
      return user ? Response.json({ id: user.id, email: user.email }, { headers: { "Cache-Control": "no-store" } }) : failure(401, "Unauthorized");
    }, { root: appRoot, env }),
    logout: async (request: Request) => {
      if (!policy.accepts(request)) return failure(403, "Forbidden");
      return withDatabase(async orm => {
        await revokePresented(orm.em.fork(), request);
        return new Response(null, { status: 204, headers: { "Set-Cookie": policy.cookie("", true), "Cache-Control": "no-store" } });
      }, { root: appRoot, env });
    },
  };
}
