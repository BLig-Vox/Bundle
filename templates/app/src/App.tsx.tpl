import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";

import { ResourceNavigation } from "./ResourceNavigation.tsx";
import { resourcePages } from "./resource-pages.tsx";

type User = { id: number; email: string };
type AccountSession = { id: number; expiresAt: string; current: boolean };
type Note = { id: number; body: string };
type SessionState = "checking" | "ready" | "error" | "logging-out" | "logout-error";
const encoder = new TextEncoder();
const fieldClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-base shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function normalizeEmail(raw: string): string | null {
  if (raw.length > 320 || /[^\x00-\x7f]/.test(raw)) return null;
  const email = raw.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").toLowerCase();
  const [local, domain] = email.split("@");
  if (email.length > 254 || !local || local.length > 64 || !domain
    || !/^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-z0-9.-]+$/.test(email)
    || local.startsWith(".") || local.endsWith(".") || local.includes("..")
    || domain.split(".").length < 2 || domain.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return email;
}
const isUser = (value: unknown): value is User => exact(value, ["id", "email"]) && positiveId(value.id)
  && typeof value.email === "string" && normalizeEmail(value.email) === value.email;
const isNote = (value: unknown): value is Note => exact(value, ["id", "body"]) && positiveId(value.id)
  && typeof value.body === "string" && value.body.length >= 1 && value.body.length <= 1000 && value.body.trim() === value.body;
const isNotes = (value: unknown): value is Note[] => Array.isArray(value) && value.length <= 100
  && value.every((note, index) => isNote(note) && (index === 0 || note.id > value[index - 1].id));
const isAccountSessions = (value: unknown): value is AccountSession[] => Array.isArray(value) && value.length <= 50
  && value.every((row, index) => exact(row, ["id", "expiresAt", "current"]) && positiveId(row.id)
    && typeof row.current === "boolean" && typeof row.expiresAt === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.expiresAt)
    && Number.isFinite(Date.parse(row.expiresAt)) && new Date(row.expiresAt).toISOString() === row.expiresAt
    && Date.parse(row.expiresAt) > Date.now() && (index === 0 || row.id < value[index - 1].id))
  && value.filter(row => row.current).length <= 1;
class ApiError extends Error {
  constructor(readonly status: number) { super("Request failed"); }
}

export default function App() {
  const [session, setSession] = useState<SessionState>("checking");
  const [user, setUser] = useState<User | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [sessionsBusy, setSessionsBusy] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const sessionsEpoch = useRef(0);
  const sessionsLock = useRef(false);
  function clearSessions() {
    sessionsEpoch.current++; sessionsLock.current = false;
    setSessions([]); setSessionsError(""); setSessionsBusy(false);
  }
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordNotice, setPasswordNotice] = useState("");
  const passwordLock = useRef(false);
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesState, setNotesState] = useState<"loading" | "ready" | "error">("loading");
  const [noteError, setNoteError] = useState("");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  // Every session boundary invalidates reads and writes, even if fetch ignores abort.
  const epoch = useRef(0);
  const controller = useRef(new AbortController());
  const authLock = useRef(false);
  const notesLock = useRef(false);

  function clearPasswords() {
    setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
  }
  function boundary() {
    clearSessions(); clearPasswords(); setAccountOpen(false); setPasswordError(""); setPasswordNotice("");
    passwordLock.current = false; setPasswordBusy(false);
    epoch.current++;
    controller.current.abort();
    controller.current = new AbortController();
    notesLock.current = false;
    setUser(null); setNotes([]); setDraft(""); setPassword(""); setEmail("");
    setNoteError(""); setAccountError(""); setNotice(""); setSaving(false); setNotesState("loading");
    return epoch.current;
  }
  async function request(path: string, expected: number, body?: unknown, method?: "DELETE"): Promise<Response> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 15_000);
    try {
      const response = await fetch(path, {
        credentials: "same-origin", cache: "no-store",
        signal: AbortSignal.any([controller.current.signal, timeout.signal]),
        ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
        ...(method ? { method } : {}),
      });
      if (response.status !== expected) throw new ApiError(response.status);
      return response;
    } finally { clearTimeout(timer); }
  }
  async function json(response: Response): Promise<unknown> {
    if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") throw new Error("Invalid response");
    return response.json();
  }
  function expired(version: number) {
    if (version !== epoch.current) return;
    boundary(); setSession("ready"); setRegister(false);
    setAccountError("Your session expired. Please log in again.");
  }
  async function loadNotes(version: number) {
    if (version !== epoch.current || notesLock.current) return;
    notesLock.current = true; setNotesState("loading"); setNotes([]); setNoteError("");
    try {
      const data = await json(await request("/api/notes", 200));
      if (!isNotes(data)) throw new Error("Invalid response");
      if (version === epoch.current) { setNotes(data); setNotesState("ready"); }
    } catch (error) {
      if (version !== epoch.current) return;
      if (error instanceof ApiError && error.status === 401) expired(version);
      else { setNotesState("error"); setNoteError("Could not load notes. Try refreshing notes."); }
    } finally { if (version === epoch.current) notesLock.current = false; }
  }
  async function loadSessions(version = epoch.current, accountVersion = sessionsEpoch.current) {
    const active = () => version === epoch.current && accountVersion === sessionsEpoch.current;
    if (!active() || sessionsLock.current) return;
    sessionsLock.current = true; setSessionsBusy(true); setSessions([]); setSessionsError("");
    try {
      const data = await json(await request("/api/auth/sessions", 200));
      if (!isAccountSessions(data)) throw new Error("Invalid response");
      if (active()) setSessions(data);
    } catch (error) {
      if (!active()) return;
      if (error instanceof ApiError && error.status === 401) expired(version);
      else setSessionsError("Could not load sessions. Try refreshing sessions.");
    } finally { if (active()) { sessionsLock.current = false; setSessionsBusy(false); } }
  }
  async function revokeSession(id: number) {
    if (!user || sessionsLock.current || passwordLock.current || !positiveId(id) || !sessions.some(row => row.id === id && !row.current)) return;
    const version = epoch.current, accountVersion = sessionsEpoch.current;
    const active = () => version === epoch.current && accountVersion === sessionsEpoch.current;
    sessionsLock.current = true; setSessionsBusy(true); setSessionsError("");
    try {
      await request(`/api/auth/sessions/${id}`, 204, undefined, "DELETE");
      if (!active()) return;
      sessionsLock.current = false;
      await loadSessions(version, accountVersion);
    } catch (error) {
      if (!active()) return;
      if (error instanceof ApiError && error.status === 401) expired(version);
      else setSessionsError("Could not revoke session. Refresh sessions and try again.");
    } finally { if (active()) { sessionsLock.current = false; setSessionsBusy(false); } }
  }
  async function restore() {
    const version = boundary(); setSession("checking");
    try {
      const data = await json(await request("/api/auth/me", 200));
      if (!isUser(data)) throw new Error("Invalid response");
      if (version !== epoch.current) return;
      setUser(data); setSession("ready"); void loadNotes(version);
    } catch (error) {
      if (version !== epoch.current) return;
      if (error instanceof ApiError && error.status === 401) setSession("ready");
      else { setSession("error"); setAccountError("Could not check your session. Try again."); }
    }
  }
  useEffect(() => {
    void restore();
    return () => { epoch.current++; controller.current.abort(); };
  }, []);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authLock.current || session !== "ready" || user) return;
    const normalized = normalizeEmail(email);
    if (!normalized) { setAccountError("Enter a valid ASCII email address, up to 254 characters."); return; }
    const credentials = { email: normalized, password };
    if (password.length < 12 || encoder.encode(password).length > 1024) {
      setAccountError("Use at least 12 password characters and at most 1024 UTF-8 bytes."); return;
    }
    if (encoder.encode(JSON.stringify(credentials)).length > 4096) {
      setAccountError("The encoded credentials exceed the 4 KiB request limit."); return;
    }
    authLock.current = true; setAuthBusy(true);
    const version = boundary();
    try {
      const data = await json(await request(register ? "/api/auth/register" : "/api/auth/login", register ? 201 : 200, credentials));
      if (!isUser(data)) throw new Error("Invalid response");
      if (version !== epoch.current) return;
      setUser(data); void loadNotes(version);
    } catch (error) {
      if (version !== epoch.current) return;
      setEmail(normalized);
      setAccountError(error instanceof ApiError && error.status === 429
        ? "Too many attempts. Wait a minute before trying again."
        : register ? "Could not create account. Check your details and try again." : "Could not log in. Check your details and try again.");
    } finally {
      if (version === epoch.current) { authLock.current = false; setAuthBusy(false); }
    }
  }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || session !== "ready" || passwordLock.current || authLock.current || sessionsLock.current) return;
    setPasswordNotice(""); setPasswordError("");
    if ([currentPassword, newPassword].some(value => value.length < 12 || value.length > 1024 || encoder.encode(value).length > 1024)) {
      setPasswordError("Use at least 12 password characters and at most 1024 UTF-8 bytes."); return;
    }
    if (newPassword !== confirmPassword) { setPasswordError("Passwords must match."); return; }
    const body = { currentPassword, newPassword };
    if (encoder.encode(JSON.stringify(body)).length > 4096) {
      setPasswordError("The encoded passwords exceed the 4 KiB request limit."); return;
    }
    const version = epoch.current;
    const identity = user;
    passwordLock.current = true; setPasswordBusy(true);
    try {
      await request("/api/auth/password", 204, body);
      if (version !== epoch.current) return;
      // The browser applies Set-Cookie; no token or cookie is exposed to React.
      clearSessions(); void loadSessions();
      clearPasswords(); setPasswordNotice("Password changed. Your other sessions have been signed out.");
    } catch (error) {
      if (version !== epoch.current) return;
      if (error instanceof ApiError && error.status === 401) {
        try {
          const data = await json(await request("/api/auth/me", 200));
          if (version !== epoch.current) return;
          if (!isUser(data) || data.id !== identity.id || data.email !== identity.email) throw new Error("Invalid response");
        } catch (checkError) {
          if (version !== epoch.current) return;
          if (checkError instanceof ApiError && checkError.status === 401) { expired(version); return; }
        }
      }
      if (version === epoch.current) setPasswordError("Could not change password. Check your details and try again.");
    } finally {
      if (version === epoch.current) { passwordLock.current = false; setPasswordBusy(false); }
    }
  }
  async function logout() {
    if (authLock.current) return;
    authLock.current = true;
    const version = boundary(); setSession("logging-out");
    try {
      await request("/api/auth/logout", 204, {});
      if (version === epoch.current) { setRegister(false); setSession("ready"); setNotice("You are logged out."); }
    } catch {
      if (version === epoch.current) { setSession("logout-error"); setAccountError("Could not log out. Retry to finish ending your session."); }
    } finally { if (version === epoch.current) authLock.current = false; }
  }
  async function createNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || notesLock.current) return;
    const body = draft.trim();
    if (!body || body.length > 1000) { setNoteError("Enter a note with 1–1000 characters after trimming."); return; }
    const version = epoch.current;
    notesLock.current = true; setSaving(true); setNoteError(""); setNotice("");
    try {
      const data = await json(await request("/api/notes", 201, { body }));
      if (!isNote(data) || data.body !== body) throw new Error("Invalid response");
      if (version !== epoch.current) return;
      setDraft(""); setNotice("Note created.");
      // Re-read the bounded ascending list instead of appending beyond the server's 100-row window.
      notesLock.current = false; await loadNotes(version);
    } catch (error) {
      if (version !== epoch.current) return;
      if (error instanceof ApiError && error.status === 401) expired(version);
      else setNoteError("Could not create note. Refresh notes before retrying; it may already have been saved.");
    } finally { if (version === epoch.current) { notesLock.current = false; setSaving(false); } }
  }
  const accountDisabled = authBusy || session !== "ready";
  const sessionVersion = epoch.current;
  return <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-6 py-12">
    <header className="space-y-2">
      <h1 className="text-3xl font-bold tracking-tight">Your Bundle notes</h1>
      <p className="text-muted-foreground">A private place for your notes.</p>
    </header>
    {accountError && <p role="alert" className="text-destructive">{accountError}</p>}
    <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
      {session === "checking" ? "Checking your session…" : session === "logging-out" ? "Logging out…" : notice}
    </p>
    {session === "error" && <Button onClick={() => void restore()}>Retry session check</Button>}
    {session === "logout-error" && <Button onClick={() => void logout()}>Retry logout</Button>}
    {user ? <>
      <section aria-label="Account" className="flex flex-wrap items-center justify-between gap-4 rounded-lg border bg-card p-6">
        <p className="break-all">Signed in as <strong>{user.email}</strong></p>
        <Button variant="outline" aria-expanded={accountOpen} aria-controls="password-settings" onClick={() => {
          if (passwordLock.current) return;
          clearSessions(); clearPasswords(); setPasswordError(""); setPasswordNotice(""); setAccountOpen(!accountOpen);
          if (!accountOpen) void loadSessions();
        }} disabled={passwordBusy}>Account</Button>
        <Button variant="outline" onClick={() => void logout()}>Log out</Button>
      </section>
      <ResourceNavigation pages={resourcePages} key={`${user.id}:${epoch.current}`} onExpired={() => expired(sessionVersion)}>
      <section aria-labelledby="notes-heading" className="space-y-5 rounded-lg border bg-card p-6">
        <h2 id="notes-heading" className="text-xl font-semibold">Notes</h2>
        <form onSubmit={createNote} className="space-y-3" aria-busy={saving}>
          <label htmlFor="note" className="block text-sm font-medium">Note</label>
          <textarea id="note" className={fieldClass} rows={4} required maxLength={1000} value={draft}
            onChange={event => setDraft(event.target.value)} disabled={saving} aria-describedby="note-help" />
          <p id="note-help" className="text-sm text-muted-foreground">1–1000 characters after trimming. {draft.length}/1000</p>
          <Button type="submit" disabled={saving || notesState === "loading" || !draft.trim()}>{saving ? "Creating note…" : "Create note"}</Button>
        </form>
        {noteError && <p role="alert" className="text-destructive">{noteError}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">First 100 notes, oldest first.</p>
          <Button variant="outline" disabled={saving || notesState === "loading"} onClick={() => void loadNotes(epoch.current)}>Refresh notes</Button>
        </div>
        <div aria-busy={notesState === "loading"}>
          {notesState === "loading" && <p role="status">Loading notes…</p>}
          {notesState === "ready" && (notes.length === 0 ? <p>No notes yet. Create your first note above.</p>
            : <ul aria-label="Your notes" className="space-y-3">{notes.map(note => <li key={note.id} className="whitespace-pre-wrap break-words rounded-md border p-4">{note.body}</li>)}</ul>)}
        </div>
      </section>
      </ResourceNavigation>
      {accountOpen && <section id="password-settings" aria-labelledby="password-heading" className="space-y-4 rounded-lg border bg-card p-6">
        <section aria-labelledby="sessions-heading" className="space-y-3">
          <h2 id="sessions-heading" className="text-xl font-semibold">Sessions</h2>
          <p>Minimal metadata: session ID and expiry only, with a current session marker. Up to 50 active sessions, newest first. No device, browser or IP information is collected.</p>
          <Button variant="outline" disabled={sessionsBusy || passwordBusy} onClick={() => void loadSessions()}>Refresh sessions</Button>
          {sessionsBusy && <p role="status">Loading sessions…</p>}
          {sessionsError && <p role="alert">{sessionsError}</p>}
          <ul aria-label="Your sessions" aria-busy={sessionsBusy}>{sessions.map(row => <li key={row.id} className="rounded-md border p-3">
            <span>Session {row.id}{row.current ? " — Current session" : ""}. Expires </span><time dateTime={row.expiresAt}>{row.expiresAt}</time>
            {!row.current && <Button variant="outline" disabled={sessionsBusy || passwordBusy} onClick={() => void revokeSession(row.id)}>Revoke session {row.id}</Button>}
          </li>)}</ul>
        </section>
        <h2 id="password-heading" className="text-xl font-semibold">Change password</h2>
        <p id="change-password-help">At least 12 characters; at most 1024 UTF-8 bytes. Passwords are kept exactly as typed. Changing your password signs out your other sessions.</p>
        <form aria-label="Change password" aria-busy={passwordBusy} onSubmit={changePassword} className="space-y-4">
          <label htmlFor="current-password" className="block text-sm font-medium">Current password</label>
          <input id="current-password" name="currentPassword" type="password" autoComplete="current-password" required
            aria-describedby="change-password-help" className={fieldClass} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} disabled={passwordBusy} />
          <label htmlFor="new-password" className="block text-sm font-medium">New password</label>
          <input id="new-password" name="newPassword" type="password" autoComplete="new-password" required
            aria-describedby="change-password-help" className={fieldClass} value={newPassword} onChange={event => setNewPassword(event.target.value)} disabled={passwordBusy} />
          <label htmlFor="confirm-password" className="block text-sm font-medium">Confirm new password</label>
          <input id="confirm-password" name="confirmPassword" type="password" autoComplete="new-password" required
            className={fieldClass} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} disabled={passwordBusy} />
          <Button type="submit" disabled={passwordBusy}>{passwordBusy ? "Changing password…" : "Change password"}</Button>
        </form>
        {passwordError && <p role="alert" className="text-destructive">{passwordError}</p>}
        <p role="status" aria-live="polite">{passwordNotice}</p>
      </section>}
    </> : session !== "logout-error" && session !== "logging-out" && <section aria-labelledby="account-heading" className="space-y-5 rounded-lg border bg-card p-6">
      <h2 id="account-heading" className="text-xl font-semibold">{register ? "Create an account" : "Log in"}</h2>
      <form onSubmit={authenticate} className="space-y-4" aria-busy={authBusy}>
        <div className="space-y-2">
          <label htmlFor="email" className="block text-sm font-medium">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required maxLength={320} className={fieldClass}
            value={email} onChange={event => setEmail(event.target.value)} disabled={accountDisabled} aria-describedby="email-help" />
          <p id="email-help" className="text-sm text-muted-foreground">Use an ASCII email address, up to 254 characters.</p>
        </div>
        <div className="space-y-2">
          <label htmlFor="password" className="block text-sm font-medium">Password</label>
          <input id="password" name="password" type="password" autoComplete={register ? "new-password" : "current-password"} required minLength={12} maxLength={1024}
            className={fieldClass} value={password} onChange={event => setPassword(event.target.value)} disabled={accountDisabled} aria-describedby="password-help" />
          <p id="password-help" className="text-sm text-muted-foreground">At least 12 characters; at most 1024 UTF-8 bytes. Passwords are kept exactly as typed.</p>
        </div>
        <Button type="submit" disabled={accountDisabled}>{authBusy ? "Please wait…" : register ? "Register" : "Log in"}</Button>
      </form>
      <Button variant="link" disabled={accountDisabled} onClick={() => { setRegister(!register); setPassword(""); setAccountError(""); setNotice(""); }}>
        {register ? "Back to log in" : "Create an account"}
      </Button>
    </section>}
  </main>;
}
