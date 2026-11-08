import { UnderscoreNamingStrategy } from "@mikro-orm/core";
import { modelSource } from "../database/generators.ts";

export const resourcePath = (name: string) => "/api/" + name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase() + "s";
const naming = new UnderscoreNamingStrategy();
export const resourceTable = (name: string) => naming.classToTableName(name);
const starterTables = new Set(["users", "sessions", "notes"]);
export function validateResourceName(name: string) {
  modelSource(name);
  if (starterTables.has(resourceTable(name))) throw new Error("Resource table collision with a starter model.");
  if (["User", "Session", "Note", "Auth", "Health", "EntitySchema", "ReferenceKind", "OptionalProps", "Infer", "Schema"].includes(name)) throw new Error("Reserved resource name.");
}
export function resourceManifest(names: string[]): string {
  return `// Bundle static resource manifest v1. Automatic edits require this exact format.
import type { Route } from "./router.ts";
import type { Environment } from "bundle/src/database/config.ts";
import { createRequireAuth } from "../auth.ts";
${names.map(name => `import { create${name}Handler } from "../routes/${name}.ts";\n`).join("")}
export function createResourceRoutes(env: Environment = process.env): readonly Route[] {
  const requireAuth = createRequireAuth(env);
  return [
${names.map(name => `    { path: "${resourcePath(name)}", methods: ["GET", "POST"], middleware: [requireAuth], handler: create${name}Handler(env) },
    { path: "${resourcePath(name)}/:id", methods: ["GET", "PATCH", "DELETE"], middleware: [requireAuth], handler: create${name}Handler(env) },\n`).join("")}  ];
}
`;
}
/** Complete byte-for-byte grammar recognition. Never import project code. */
export function resourceManifestNames(source: string): string[] | null {
  const names = [...source.matchAll(/^import \{ create([A-Z][A-Za-z0-9]*)Handler \} from "\.\.\/routes\/\1\.ts";$/gm)].map(match => match[1]!);
  try {
    const tables = new Set(starterTables);
    const paths = new Set(["/api/notes", "/api/health", "/api/auth"]);
    for (const name of names) {
      validateResourceName(name);
      const table = resourceTable(name);
      if (tables.has(table)) return null;
      tables.add(table);
      const path = resourcePath(name);
      if (paths.has(path)) return null;
      paths.add(path);
    }
    return source === resourceManifest(names) ? names : null;
  } catch { return null; }
}
