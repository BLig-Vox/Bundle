import { compileRoutePattern } from "../web/route-pattern.ts";
import { generateSource, validateSourceName } from "./scaffold.ts";

export function generateRoute(root: string, name: string): Promise<string> {
  return generateSource(root, name, "route", routeSource);
}

export function routeSource(name: string): string {
  return `// Register this handler explicitly in src/web/routes.ts.
// Keep user data out of HTML unless escaped for its specific output context.
export function handler(_request: Request): Response {
  return new Response('<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<title>${name}</title></head><body><main><h1>${name}</h1></main></body></html>', {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
`;
}

/** Convert validated handler names to stable lower-kebab URLs. */
export function defaultRoutePath(name: string): string {
  validateSourceName(name);
  return "/" + name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function validateRoutePath(path: string): void {
  compileRoutePattern(path);
}

export function routeRegistration(name: string, path = defaultRoutePath(name)) {
  validateSourceName(name);
  validateRoutePath(path);
  return {
    manifest: "src/web/routes.ts",
    import: `import { handler as ${name}Handler } from "../routes/${name}.ts";`,
    entry: `{ path: "${path}", handler: ${name}Handler },`,
  };
}
