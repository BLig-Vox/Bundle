import { appRoot, authenticatedUserId, failure } from "../auth.ts";
export { appRoot } from "../auth.ts";
import { withDatabase } from "bundle/src/database/connection.ts";
import type { Environment } from "bundle/src/database/config.ts";
import { readValidatedJson } from "bundle/src/web/request.ts";
import { schema } from "bundle/src/validation/schema.ts";
import type { RouteContext } from "../web/router.ts";
import { User } from "../models/User.ts";
import { Note } from "../models/Note.ts";

const noteSchema = schema.object({ body: schema.string({ trim: true, min: 1, max: 1000 }) });

export function createNotesHandler(env: Environment = process.env) {
  return async (request: Request, context?: RouteContext): Promise<Response> => {
    const ownerId = context?.get(authenticatedUserId);
    if (ownerId === undefined) return failure(401, "Unauthorized");
    let body: string | undefined;
    if (request.method === "POST") {
      body = (await readValidatedJson(request, noteSchema, { maxBytes: 16 * 1024 })).body;
    }
    // The router sanitizes unexpected errors, including connection/query/close failures.
    return withDatabase(async orm => {
      const em = orm.em.fork();
      const owner = em.getReference(User, ownerId);
      if (body !== undefined) {
        const note = em.create(Note, { body, owner });
        em.persist(note);
        await em.flush();
        return Response.json({ id: note.id, body: note.body }, { status: 201 });
      }
      const notes = await em.find(Note, { owner }, { fields: ["id", "body"], orderBy: { id: "asc" }, limit: 100 });
      return Response.json(notes.map(note => ({ id: note.id, body: note.body })));
    }, { root: appRoot, env });
  };
}

export const handler = createNotesHandler();
