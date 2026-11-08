import { generateSource } from "./scaffold.ts";

/** Generate owned, editable code without database access or route registration. */
export function generatePage(root: string, name: string): Promise<string> {
  return generateSource(root, name, "page", pageSource);
}

function pageSource(name: string): string {
  return `// Server-renderable page. Use render in a handler and register it in src/web/routes.ts; absent manifest previews Home.ts at /.
export type PageProps = { title?: string; heading?: string };

// Escape text and quoted HTML attributes. Do not use for scripts, styles, or URLs.
function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function render({ title = "${name}", heading = "${name}" }: PageProps = {}): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>' + escapeHtml(title) + '</title></head><body><main><h1>'
    + escapeHtml(heading) + '</h1></main></body></html>';
}
`;
}
