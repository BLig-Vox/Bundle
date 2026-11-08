import { appRoot } from "../auth.ts";
import { withDatabase } from "bundle/src/database/connection.ts";
import type { Environment } from "bundle/src/database/config.ts";

export function handler(_request: Request): Response {
  return Response.json({ status: "ok" });
}

export function createReadinessHandler(env: Environment = process.env) {
  return async (): Promise<Response> => {
    try {
      await withDatabase(async orm => { await orm.em.fork().getConnection().execute("select 1"); }, { root: appRoot, env });
      return Response.json({ status: "ready" });
    } catch {
      return Response.json({ status: "unavailable" }, { status: 503 });
    }
  };
}
