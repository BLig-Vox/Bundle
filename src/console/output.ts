export type ConsoleOutputOptions = Readonly<{
  write: (text: string) => void;
  isTTY?: boolean;
  color?: boolean;
  columns?: number;
  env?: Readonly<Record<string, string | undefined>>;
}>;

type Progress = Readonly<{ update: (current: number) => void; complete: (message?: string) => void }>;
type Spinner = Readonly<{ tick: () => boolean; stop: (message?: string) => void; fail: (message?: string) => void }>;
export type ConsoleOutput = Readonly<{
  info: (message: unknown) => void;
  warn: (message: unknown) => void;
  error: (message: unknown) => void;
  success: (message: unknown) => void;
  line: (message: unknown) => void;
  table: (rows: readonly (readonly unknown[])[]) => void;
  progress: (label: unknown, total: number) => Progress;
  /** Spinner animation is caller-driven through tick(); no timer or background animation is started. */
  spinner: (label: unknown) => Spinner;
  close: () => void;
}>;

const sanitize = (value: unknown): string => String(value ?? "")
  .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
  .replace(/[\u001b\u009b](?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
  .replace(/\s+/g, " ").trim();

function width(text: string): number {
  let count = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    count += cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe10 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1faff)) ? 2 : 1;
  }
  return count;
}

export function createConsoleOutput(options: ConsoleOutputOptions): ConsoleOutput {
  if (!options || typeof options.write !== "function") throw new TypeError("write must be a function");
  const tty = options.isTTY ?? false;
  const color = (options.env ?? process.env).NO_COLOR === undefined && (options.color ?? tty);
  const columns = Math.max(20, Math.min(240, Math.floor(Number.isFinite(options.columns) ? options.columns! : 80)));
  let closed = false;
  const write = (text: string) => { if (!closed) options.write(text); };
  const render = (symbol: string, message: unknown, code: number) => {
    const text = `${symbol} ${sanitize(message)}`;
    write(`${color && tty ? `\u001b[${code}m${text}\u001b[0m` : text}\n`);
  };
  const progress = (label: unknown, total: number): Progress => {
    const safeLabel = sanitize(label);
    const validTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
    let done = false;
    const draw = (current: number) => {
      const value = validTotal ? Math.max(0, Math.min(validTotal, Number.isFinite(current) ? Math.floor(current) : 0)) : 0;
      const ratio = validTotal ? value / validTotal : 0;
      const filled = Math.round(ratio * 10);
      write(`${safeLabel}: [${"#".repeat(filled)}${"-".repeat(10 - filled)}] ${value}/${validTotal}\n`);
    };
    draw(0);
    return Object.freeze({
      update(current: number) { if (!done) draw(current); },
      complete(message?: string) { if (done) return; done = true; if (validTotal) draw(validTotal); if (message !== undefined) write(`${sanitize(message)}\n`); },
    });
  };
  const spinner = (label: unknown): Spinner => {
    const safeLabel = sanitize(label);
    const frames = ["|", "/", "-", "\\"];
    let index = 0, stopped = false;
    const finish = (marker: string, message?: string) => { if (stopped) return; stopped = true; write(`${marker} ${sanitize(message ?? safeLabel)}\n`); };
    return Object.freeze({
      tick() { if (stopped || closed) return false; write(`${frames[index++ % frames.length]} ${safeLabel}\n`); return true; },
      stop(message?: string) { finish("✓", message); },
      fail(message?: string) { finish("✖", message); },
    });
  };
  const table = (rows: readonly (readonly unknown[])[]) => {
    if (!rows.length) { write("\n"); return; }
    const sanitized = rows.map(row => Array.from(row, sanitize));
    const count = Math.min(Math.floor((columns + 2) / 3), Math.max(1, ...sanitized.map(row => row.length)));
    // Fold excessive columns into the last cell rather than exceeding the terminal.
    const data = sanitized.map(row => row.length > count ? [...row.slice(0, count - 1), row.slice(count - 1).join(" | ")] : row);
    const budget = columns - 2 * (count - 1);
    const widths = Array.from({ length: count }, (_, col) => Math.min(columns, Math.max(1, ...data.map(row => width(row[col] ?? "")))));
    let allocated = widths.reduce((sum, value) => sum + value, 0);
    while (allocated > budget) {
      const largest = widths.indexOf(Math.max(...widths));
      widths[largest]!--;
      allocated--;
    }
    const format = (row: string[]) => Array.from({ length: count }, (_, col) => {
      let cell = row[col] ?? "";
      if (width(cell) > widths[col]!) {
        let clipped = "";
        for (const char of cell) { if (width(clipped + char) > widths[col]! - 1) break; clipped += char; }
        cell = `${clipped}…`;
      }
      return cell + (col < count - 1 ? " ".repeat(Math.max(0, widths[col]! - width(cell))) : "");
    }).join("  ").trimEnd();
    const separator = "-".repeat(Math.min(columns, widths.reduce((sum, width) => sum + width, 0) + 2 * (count - 1)));
    write(`${format(data[0]!)}\n${separator}\n`);
    for (const row of data.slice(1)) write(`${format(row)}\n`);
  };
  return Object.freeze({
    info: message => render("ℹ", message, 36),
    warn: message => render("!", message, 33),
    error: message => render("✖", message, 31),
    success: message => render("✓", message, 32),
    line: message => write(`${sanitize(message)}\n`),
    table,
    progress,
    spinner,
    close() { closed = true; },
  });
}
