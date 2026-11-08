import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "./components/ui/button.tsx";

const fieldClass = "block w-full rounded-md border border-input bg-background px-3 py-2 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
export type Field = { key: string; type: "string" | "text" | "number" | "integer" | "boolean"; nullable: boolean };
export type PageProps = { onExpired: () => void };
export function validRecord(value: unknown, fields: readonly Field[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === fields.length + 1 && Object.hasOwn(row, "id") && typeof row.id === "number" && Number.isSafeInteger(row.id) && row.id > 0 && fields.every(f => {
    if (!Object.hasOwn(row, f.key)) return false;
    const v = row[f.key];
    if (v === null) return f.nullable;
    if (f.type === "boolean") return typeof v === "boolean";
    if (f.type === "number" || f.type === "integer") return typeof v === "number" && Number.isFinite(v) && (f.type !== "integer" || Number.isSafeInteger(v));
    return typeof v === "string" && v.trim() === v && v.length >= 1 && v.length <= (f.type === "text" ? 10000 : 255);
  });
}
class HttpError extends Error { constructor(readonly status: number) { super("Request failed"); } }
export function ResourcePage<Row extends { id: number }>({ name, path, fields, validate, onExpired }: PageProps & {
  name: string; path: string; fields: readonly Field[]; validate: (value: unknown) => value is Row;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  // Each entry is the exclusive boundary used to fetch that page; 0 means no cursor.
  const [cursors, setCursors] = useState<number[]>([0]);
  const [hasMore, setHasMore] = useState(false);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<number | null>(null);
  const initial = () => Object.fromEntries(fields.map(f => [f.key, f.nullable ? null : f.type === "boolean" ? false : ""])) as Record<string, string | boolean | null>;
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const version = useRef(0), lock = useRef(false);
  const controller = useRef(new AbortController());
  useEffect(() => {
    controller.current = new AbortController();
    const current = ++version.current;
    lock.current = false; void load(current);
    return () => { version.current++; controller.current.abort(); };
  }, []);
  async function request(url: string, method = "GET", body?: unknown) {
    const response = await fetch(url, { method, credentials: "same-origin", cache: "no-store",
      signal: AbortSignal.any([controller.current.signal, AbortSignal.timeout(15000)]),
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    const expected = method === "POST" ? 201 : method === "DELETE" ? 204 : 200;
    if (response.status !== expected) throw new HttpError(response.status);
    if (expected === 204) { if (await response.text() !== "") throw new Error("Invalid response"); return null; }
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") throw new Error("Invalid response");
    return response;
  }
  function failed(reason: unknown, current: number) {
    if (current !== version.current) return;
    if (reason instanceof HttpError && reason.status === 401) { setRows([]); setDraft(initial()); onExpired(); }
    else setError("Request failed. Refresh before retrying; a change may already have been saved.");
  }
  async function load(current = version.current, target = cursors) {
    if (lock.current) return;
    lock.current = true; setState("loading"); setRows([]); setHasMore(false); setError("");
    try {
      const after = target.at(-1)!;
      const response = (await request(after === 0 ? path : `${path}?after=${after}`))!;
      const more = response.headers.get("X-Has-More");
      const data: unknown = await response.json();
      if ((more !== "true" && more !== "false") || !Array.isArray(data) || data.length > 100
        || (more === "true" && data.length !== 100)
        || !data.every((row, i) => validate(row) && row.id > (i === 0 ? after : data[i - 1].id))) throw new Error("Invalid response");
      if (current === version.current) {
        setRows(data); setHasMore(more === "true"); setCursors(target); setState("ready");
        if (target !== cursors) { setEditing(null); setDraft(initial()); setNotice(""); }
      }
    } catch (reason) { if (current === version.current) { setState("error"); failed(reason, current); } }
    finally { if (current === version.current) lock.current = false; }
  }
  async function mutate(method: "POST" | "PATCH" | "DELETE", rowId?: number, body?: Record<string, unknown>) {
    if (lock.current) return;
    const current = version.current;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await request(rowId === undefined ? path : `${path}/${rowId}`, method, body);
      const data: unknown = response === null ? null : await response.json();
      if (method !== "DELETE" && (!validate(data) || (rowId !== undefined && data.id !== rowId)
        || !Object.entries(body!).every(([key, value]) => (data as Record<string, unknown>)[key] === value))) throw new Error("Invalid response");
      if (current !== version.current) return;
      setDraft(initial()); setEditing(null); setNotice(`${name} ${method === "DELETE" ? "deleted" : "saved"}.`);
      lock.current = false; await load(current);
    } catch (reason) { failed(reason, current); }
    finally { if (current === version.current) { lock.current = false; setBusy(false); } }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const body: Record<string, unknown> = {};
    for (const f of fields) {
      const raw = draft[f.key];
      if (raw === null && f.nullable) body[f.key] = null;
      else if (f.type === "boolean") body[f.key] = raw;
      else if (f.type === "number" || f.type === "integer") {
        if (typeof raw !== "string" || !raw.trim()) { setError("Enter valid values for all fields."); return; }
        body[f.key] = Number(raw);
      } else body[f.key] = typeof raw === "string" ? raw.trim() : raw;
    }
    if (!validRecord({ id: 1, ...body }, fields) || new TextEncoder().encode(JSON.stringify(body)).length > 16384) { setError("Enter valid values for all fields (maximum 16 KiB JSON)."); return; }
    void mutate(editing === null ? "POST" : "PATCH", editing ?? undefined, body);
  }
  return <section aria-label={name} className="space-y-4 rounded-lg border p-6">
    <h2>{name}</h2><p>Up to 100 records per page, oldest first.</p>
    <form aria-label={`${name} editor`} onSubmit={submit} aria-busy={busy}>
      <fieldset disabled={busy || state === "loading"} className="space-y-3">
        <legend>{editing === null ? `Create ${name}` : `Edit ${name} ${editing}`}</legend>
        {fields.map(f => { const inputId = `${name}-${f.key}`; return <div key={f.key}>
          <label htmlFor={inputId}>{f.key}</label>{" "}
          {f.type === "boolean" ? <input id={inputId} type="checkbox" disabled={draft[f.key] === null} checked={draft[f.key] === true} onChange={e => setDraft({ ...draft, [f.key]: e.target.checked })} />
            : f.type === "text" ? <textarea className={fieldClass} id={inputId} disabled={draft[f.key] === null} required maxLength={10000} value={String(draft[f.key] ?? "")} onChange={e => setDraft({ ...draft, [f.key]: e.target.value })} />
            : <input className={fieldClass} id={inputId} type={f.type === "string" ? "text" : "number"} step={f.type === "integer" ? "1" : "any"} required maxLength={f.type === "string" ? 255 : undefined} disabled={draft[f.key] === null} value={String(draft[f.key] ?? "")} onChange={e => setDraft({ ...draft, [f.key]: e.target.value })} />}
          {f.nullable && <label htmlFor={`${inputId}-null`}><input id={`${inputId}-null`} type="checkbox" checked={draft[f.key] === null} onChange={e => setDraft({ ...draft, [f.key]: e.target.checked ? null : f.type === "boolean" ? false : "" })} /> Set {f.key} to null</label>}
        </div>; })}
        <Button type="submit">{editing === null ? `Create ${name}` : `Save ${name}`}</Button>
        {editing !== null && <Button type="button" onClick={() => { setEditing(null); setDraft(initial()); }}>Cancel edit</Button>}
      </fieldset>
    </form>
    {error && <p role="alert">{error}</p>}<p role="status">{state === "loading" ? `Loading ${name}…` : notice}</p>
    <Button disabled={busy || state === "loading"} onClick={() => void load()}>Refresh {name}</Button>
    <nav aria-label={`${name} pagination`} className="flex items-center gap-3">
      <Button type="button" disabled={busy || state === "loading" || cursors.length === 1} onClick={() => void load(version.current, cursors.slice(0, -1))}>Previous</Button>
      <span aria-live="polite" aria-atomic="true">Page {cursors.length}</span>
      <Button type="button" disabled={busy || state !== "ready" || !hasMore} onClick={() => void load(version.current, [...cursors, rows.at(-1)!.id])}>Next</Button>
    </nav>
    {state === "ready" && (rows.length === 0 ? <p>No {name} yet.</p> : <ul aria-label={`Your ${name}`}>{rows.map(row => <li key={row.id}>
      <dl>{fields.map(f => <div key={f.key}><dt>{f.key}</dt><dd>{String((row as Record<string, unknown>)[f.key])}</dd></div>)}</dl>
      <Button disabled={busy} aria-label={`Edit ${name} ${row.id}`} onClick={() => { setEditing(row.id); setDraft(Object.fromEntries(fields.map(f => { const value = (row as Record<string, unknown>)[f.key]; return [f.key, value === null || typeof value === "boolean" ? value : String(value)]; }))); }}>Edit {name} {row.id}</Button>
      <Button disabled={busy} aria-label={`Delete ${name} ${row.id}`} onClick={() => void mutate("DELETE", row.id)}>Delete {name} {row.id}</Button>
    </li>)}</ul>)}
  </section>;
}
