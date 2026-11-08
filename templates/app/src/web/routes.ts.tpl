import { createResourceRoutes } from "./resources.ts";
import { createRequireAuth } from "../auth.ts";
import { createAuthHandlers, type AuthAttemptLimiter } from "../routes/Auth.ts";
import { createNotesHandler } from "../routes/Notes.ts";
import { handler as healthHandler, createReadinessHandler } from "../routes/Health.ts";
import { createDatabaseAuthAttemptLimiter } from "../auth-attempt-limiter.ts";
import type { Route } from "./router.ts";
import type { Environment } from "bundle/src/database/config.ts";

export function createRoutes(env: Environment = process.env, limiter?: AuthAttemptLimiter): readonly Route[] {
  const auth = createAuthHandlers(env, limiter);
  const requireAuth = createRequireAuth(env);
  const notesHandler = createNotesHandler(env);
  return [
    ...createResourceRoutes(env),
    { path: "/api/auth/register", methods: ["POST"], handler: auth.register },
    { path: "/api/auth/login", methods: ["POST"], handler: auth.login },
    { path: "/api/auth/logout", methods: ["POST"], handler: auth.logout },
    { path: "/api/auth/password", methods: ["POST"], handler: auth.password },
    { path: "/api/auth/me", methods: ["GET"], handler: auth.me },
    { path: "/api/auth/sessions", methods: ["GET"], middleware: [requireAuth], handler: auth.sessions },
    { path: "/api/auth/sessions/:id", methods: ["DELETE"], middleware: [requireAuth], handler: auth.revokeSession },
    { path: "/api/health", handler: healthHandler },
    { path: "/api/ready", handler: createReadinessHandler(env) },
    { path: "/api/notes", methods: ["GET", "POST"], middleware: [requireAuth], handler: notesHandler },
  ];
}
const production = process.env.NODE_ENV === "production" || process.env.APP_ENV === "production";
export const routes = production
  ? createRoutes(process.env, createDatabaseAuthAttemptLimiter())
  : createRoutes();
