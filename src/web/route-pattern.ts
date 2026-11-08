/** Code-owned grammar shared by startup routing and the exact manifest editor. */
export type RoutePattern = { readonly segments: readonly string[]; readonly shape: string; readonly specificity: number };

export function compileRoutePattern(path: string): RoutePattern {
  if (typeof path !== "string" || (path !== "/" && path.match(/^\/(?:[A-Za-z0-9_-]+|:[A-Za-z_][A-Za-z0-9_]*)(?:\/(?:[A-Za-z0-9_-]+|:[A-Za-z_][A-Za-z0-9_]*))*/)?.[0] !== path)) {
    throw new Error("Use a canonical safe absolute route path: / or ASCII letters, digits, _ and - in slash-separated segments, with :name parameters; no trailing slash, encoding, query or traversal.");
  }
  const segments = path === "/" ? [] : path.slice(1).split("/");
  const names = segments.filter(segment => segment.startsWith(":"));
  if (new Set(names).size !== names.length) throw new Error("Use a canonical route path with unique parameter names.");
  return {
    segments,
    shape: "/" + segments.map(segment => segment.startsWith(":") ? ":" : segment).join("/"),
    specificity: segments.length - names.length,
  };
}

/** Overlaps require one pattern to be strictly more specific in all differing positions. */
export function assertCompatiblePatterns(a: RoutePattern, b: RoutePattern): void {
  if (a.shape === b.shape) throw new Error("Duplicate route structural pattern.");
  if (a.segments.length !== b.segments.length) return;
  let aWins = false;
  let bWins = false;
  for (let i = 0; i < a.segments.length; i++) {
    const left = a.segments[i]!;
    const right = b.segments[i]!;
    const leftParam = left.startsWith(":");
    const rightParam = right.startsWith(":");
    if (!leftParam && !rightParam && left !== right) return;
    if (!leftParam && rightParam) aWins = true;
    if (leftParam && !rightParam) bWins = true;
  }
  if (aWins && bWins) throw new Error("Route pattern conflict: overlapping routes have ambiguous static precedence.");
}
