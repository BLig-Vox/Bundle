/** Syntactic preflight only: it does not execute or validate an ORM model/schema. */
export function hasExportedModelClass(source: string, model: string): boolean {
  // Bun validates TypeScript and removes TS-only declarations before this scan.
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const code = transpiler.transformSync(source);
  const exports = transpiler.scan(source).exports;
  if (!exports.includes(model) || !exports.includes("default")) return false;
  const tokens = tokenize(code);
  const classes = new Set<string>();
  const bindings: Array<[string, string]> = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (depth === 0 && token === "class" && /^[A-Za-z_$][\w$]*$/.test(tokens[i + 1] ?? "")) {
      const previous = tokens[i - 1];
      if (previous === undefined || previous === ";" || previous === "}" || previous === "export" || (previous === "default" && tokens[i - 2] === "export")) {
        const name = tokens[i + 1]!;
        classes.add(name);
        if (previous === "export") bindings.push([name, name]);
      }
    }
    if (depth === 0 && token === "export" && tokens[i + 1] === "{") {
      let j = i + 2;
      const entries: Array<[string, string]> = [];
      while (j < tokens.length && tokens[j] !== "}") {
        const local = tokens[j++];
        if (!local || !/^[A-Za-z_$][\w$]*$/.test(local)) return false;
        let exported = local;
        if (tokens[j] === "as") { j++; exported = tokens[j++] ?? ""; }
        entries.push([local, exported]);
        if (tokens[j] === ",") j++;
        else if (tokens[j] !== "}") return false;
      }
      if (tokens[j] !== "}") return false;
      if (tokens[j + 1] !== "from") bindings.push(...entries);
      i = j;
      continue;
    }
    if (token === "{") depth++;
    else if (token === "}") depth--;
  }
  return bindings.some(([local, exported]) => exported === model && classes.has(local));
}

/** Tokenize JavaScript while hiding strings, comments, templates and regexp bodies. */
function tokenize(code: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const quoted = (quote: string) => {
    i++;
    while (i < code.length) {
      if (code[i] === "\\") { i += 2; continue; }
      if (code[i++] === quote) return;
    }
  };
  const regex = () => {
    i++;
    let characterClass = false;
    while (i < code.length) {
      const c = code[i++]!;
      if (c === "\\") { i++; continue; }
      if (c === "[") characterClass = true;
      else if (c === "]") characterClass = false;
      else if (c === "/" && !characterClass) break;
    }
    while (/[A-Za-z]/.test(code[i] ?? "")) i++;
  };
  const regexAllowed = (previous: string | undefined) => previous === undefined || /^(?:[({[=,:;!?&|+*%~<>-]|return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|else|do)$/.test(previous);
  // Interpolations are skipped as a whole; a class within one is not top-level.
  const template = () => {
    i++;
    while (i < code.length) {
      const c = code[i]!;
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { i++; return; }
      if (c === "$" && code[i + 1] === "{") { i += 2; interpolation(); continue; }
      i++;
    }
  };
  const interpolation = () => {
    let depth = 1;
    let previous: string | undefined;
    while (i < code.length && depth > 0) {
      const c = code[i]!;
      if (/\s/.test(c)) { i++; continue; }
      if (c === "'" || c === '"') { quoted(c); previous = "value"; continue; }
      if (c === "`") { template(); previous = "value"; continue; }
      if (c === "/" && code[i + 1] === "/") { i += 2; while (i < code.length && code[i] !== "\n") i++; continue; }
      if (c === "/" && code[i + 1] === "*") { i += 2; while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++; i += 2; continue; }
      if (c === "/" && regexAllowed(previous)) { regex(); previous = "value"; continue; }
      if ((c === "+" || c === "-") && code[i + 1] === c) { previous = c + c; i += 2; continue; }
      if (/[A-Za-z_$]/.test(c)) {
        const start = i++; while (/[\w$]/.test(code[i] ?? "")) i++;
        previous = code.slice(start, i); continue;
      }
      if (c === "{") depth++;
      if (c === "}") depth--;
      previous = c; i++;
    }
  };
  const parens: boolean[] = [];
  const braces: boolean[] = [];
  let afterControl = false;
  let lastClass = -1;
  let lastBoundary = -1;
  while (i < code.length) {
    const c = code[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') { quoted(c); tokens.push("#literal"); afterControl = false; continue; }
    if (c === "`") { template(); tokens.push("#literal"); afterControl = false; continue; }
    if (c === "/" && code[i + 1] === "/") { i += 2; while (i < code.length && code[i] !== "\n") i++; continue; }
    if (c === "/" && code[i + 1] === "*") { i += 2; while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++; i += 2; continue; }
    if (c === "/" && (afterControl || regexAllowed(tokens.at(-1)))) { regex(); tokens.push("#literal"); afterControl = false; continue; }
    if ((c === "+" || c === "-") && code[i + 1] === c) { tokens.push(c + c); afterControl = false; i += 2; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      const start = i++; while (/[\w$]/.test(code[i] ?? "")) i++;
      const word = code.slice(start, i);
      if (word === "class") lastClass = tokens.length;
      tokens.push(word); afterControl = false; continue;
    }
    const previous = tokens.at(-1);
    if (c === "(") parens.push(["if", "while", "for", "with", "switch", "catch"].includes(previous ?? ""));
    if (c === "{") {
      braces.push(afterControl || lastClass > lastBoundary || previous === ")" || previous === ";" || previous === "}" || previous === undefined || ["else", "try", "finally", "do"].includes(previous ?? ""));
    }
    afterControl = c === ")" ? (parens.pop() ?? false) : c === "}" ? (braces.pop() ?? false) : false;
    if (c === ";" || c === "{" || c === "}") lastBoundary = tokens.length;
    tokens.push(c); i++;
  }
  return tokens;
}
