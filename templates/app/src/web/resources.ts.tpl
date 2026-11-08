// Bundle static resource manifest v1. Automatic edits require this exact format.
import type { Route } from "./router.ts";
import type { Environment } from "bundle/src/database/config.ts";
import { createRequireAuth } from "../auth.ts";

export function createResourceRoutes(env: Environment = process.env): readonly Route[] {
  const requireAuth = createRequireAuth(env);
  return [
  ];
}
