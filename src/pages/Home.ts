// Editable plain TypeScript page, using the same contract as make:page.
export type PageProps = { title?: string; heading?: string };

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function render({ title = "Home", heading = "Home" }: PageProps = {}): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>' + escapeHtml(title) + '</title></head><body><main><h1>'
    + escapeHtml(heading) + '</h1></main></body></html>';
}
