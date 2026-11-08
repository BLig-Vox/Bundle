import { expect, test } from "bun:test";
import { createElement, StrictMode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../src/App.tsx";

test("frontend renders accessible account entry and session loading state", () => {
  const html = renderToStaticMarkup(createElement(App));
  expect(html).toContain('for="email"');
  expect(html).toContain('type="email"');
  expect(html).toContain('for="password"');
  expect(html).toContain('type="password"');
  expect(html).toContain('Log in');
  expect(html).toContain('Create an account');
  expect(html).toContain('role="status"');
});

const domModule = process.env.BUNDLE_ACCEPTANCE_DOM_MODULE;
(domModule ? test : test.skip)("real React DOM interactions against migrated SQLite and hostile/stale responses", async () => {
  // Optional host-supplied DOM test environment; never an application dependency.
  const { JSDOM } = await import(domModule!);
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
  }
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { createRouteHandler } = await import("bundle/src/web/server.ts");
  const handler = await createRouteHandler(new URL("../", import.meta.url).pathname);
  const nativeFetch = globalThis.fetch;
  let cookie = "";
  let intercept: ((path: string, init?: RequestInit) => Promise<Response> | undefined) | undefined;
  const requests: { path: string; method: string }[] = [];
  const bridge = async (path: string, init?: RequestInit) => {
    const response = await handler(new Request(`http://localhost${path}`, { ...init, headers: { ...init?.headers, origin: "http://localhost", cookie } }));
    const next = response.headers.get("set-cookie");
    if (next) { expect(next).toContain("HttpOnly"); cookie = next.split(";")[0]!; }
    return response;
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(typeof input).toBe("string");
    const path = input as string;
    expect(path.startsWith("/api/")).toBe(true);
    expect(init?.credentials).toBe("same-origin");
    expect(init?.cache).toBe("no-store");
    requests.push({ path, method: init?.method ?? "GET" });
    return intercept?.(path, init) ?? bridge(path, init);
  }) as typeof fetch;
  const root = createRoot(dom.window.document.getElementById("root")!);
  const doc = dom.window.document;
  const text = () => doc.body.textContent ?? "";
  const settle = async (predicate: () => boolean) => {
    for (let i = 0; i < 400; i++) {
      await act(async () => { await Bun.sleep(10); });
      if (predicate()) return;
    }
    throw new Error(`UI did not settle: ${text()}`);
  };
  const click = async (label: string) => {
    const button = [...doc.querySelectorAll("button")].find((b: any) => b.textContent === label) as HTMLButtonElement;
    expect(button).toBeDefined(); expect(button.disabled).toBe(false);
    await act(async () => { button.click(); });
  };
  const fill = async (id: string, value: string) => {
    const input = doc.getElementById(id) as HTMLInputElement;
    expect(doc.querySelector(`label[for="${id}"]`)).not.toBeNull();
    const proto = input.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const submit = async () => { await act(async () => { doc.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); }); };
  const out = () => !!doc.getElementById("email") && !(doc.getElementById("email") as HTMLInputElement).disabled;
  const first = `ui-${Date.now()}@example.com`, second = `second-${Date.now()}@example.com`;
  let password = "interaction test password!";
  const account = async (email: string, register = false) => {
    if (register) await click("Create an account");
    await fill("email", email); await fill("password", password); await submit();
    await settle(() => text().includes(email) && !!doc.getElementById("note"));
  };
  try {
    await act(async () => { root.render(createElement(StrictMode, null, createElement(App))); });
    await settle(out);
    await account(first, true);
    await settle(() => text().includes("No notes yet"));
    // Password acceptance is exercised through the mounted UI and migrated router.
    await click("Account");
    await settle(() => !!doc.querySelector('ul[aria-label="Your sessions"]'));
    expect(text()).toContain("Current session"); expect(text()).toContain("Expires");
    expect(text()).toContain("50");
    const sessionRows = () => doc.querySelectorAll('ul[aria-label="Your sessions"] li');
    expect(sessionRows()).toHaveLength(1);
    const sessionDevice = await handler(new Request("http://localhost/api/auth/login", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ email: first, password }) }));
    const sessionDeviceCookie = sessionDevice.headers.get("set-cookie")!.split(";")[0]!;
    await click("Refresh sessions"); await settle(() => sessionRows().length === 2);
    const revokeLabel = [...doc.querySelectorAll("button")].find(button => button.textContent?.startsWith("Revoke session "))!.textContent!;
    intercept = path => path.startsWith("/api/auth/sessions/") ? Promise.resolve(new Response("SECRET REVOKE ERROR", { status: 409 })) : undefined;
    await click(revokeLabel); await settle(() => text().includes("Could not revoke session"));
    expect(text()).not.toContain("SECRET REVOKE ERROR"); expect(sessionRows()).toHaveLength(2);
    intercept = undefined;
    await click(revokeLabel); await settle(() => sessionRows().length === 1);
    expect((await handler(new Request("http://localhost/api/auth/me", { headers: { cookie: sessionDeviceCookie } }))).status).toBe(401);
    const goodSession = { id: 1, expiresAt: "2099-01-01T00:00:00.000Z", current: true };
    for (const bad of [{}, [null], [{ ...goodSession, tokenHash: "SECRET HASH" }], [{ ...goodSession, id: 0 }], [{ ...goodSession, id: 1.5 }],
      [{ ...goodSession, current: "true" }], [{ ...goodSession, expiresAt: "2099-02-30T00:00:00.000Z" }], [{ ...goodSession, expiresAt: "yesterday" }],
      [{ ...goodSession, expiresAt: "2000-01-01T00:00:00.000Z" }], Array(51).fill(goodSession), [goodSession, goodSession],
      [{ ...goodSession, id: 1 }, { ...goodSession, id: 2, current: false }], [{ ...goodSession, id: 2 }, goodSession]]) {
      intercept = path => path === "/api/auth/sessions" ? Promise.resolve(Response.json(bad)) : undefined;
      await click("Refresh sessions"); await settle(() => text().includes("Could not load sessions"));
      expect(sessionRows()).toHaveLength(0); expect(text()).not.toContain("SECRET HASH");
    }
    let releaseSessions!: (response: Response) => void;
    intercept = path => path === "/api/auth/sessions" ? new Promise(resolve => { releaseSessions = resolve; }) : undefined;
    await click("Refresh sessions"); await settle(() => !!releaseSessions);
    await click("Account"); expect(sessionRows()).toHaveLength(0);
    intercept = undefined; await click("Account"); await settle(() => sessionRows().length === 1);
    await act(async () => { releaseSessions(Response.json([{ ...goodSession, id: 987654, current: false }])); });
    expect(text()).not.toContain("987654");
    // A late mutation may not refresh a newly opened Account view.
    const heldDevice = await handler(new Request("http://localhost/api/auth/login", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ email: first, password }) }));
    expect(heldDevice.status).toBe(200);
    await click("Refresh sessions"); await settle(() => sessionRows().length === 2);
    let releaseRevoke!: (response: Response) => void;
    intercept = path => path.startsWith("/api/auth/sessions/") ? new Promise(resolve => { releaseRevoke = resolve; }) : undefined;
    await click([...doc.querySelectorAll("button")].find(button => button.textContent?.startsWith("Revoke session "))!.textContent!);
    await settle(() => !!releaseRevoke); await click("Account");
    intercept = undefined; await click("Account"); await settle(() => sessionRows().length === 2);
    const beforeLateRevoke = requests.length;
    await act(async () => { releaseRevoke(new Response(null, { status: 204 })); });
    expect(requests.length).toBe(beforeLateRevoke);
    // Logout invalidates a pending read even when the transport ignores abort.
    intercept = path => path === "/api/auth/sessions" ? new Promise(resolve => { releaseSessions = resolve; }) : undefined;
    await click("Refresh sessions"); await click("Log out"); await settle(out);
    intercept = undefined; await account(first); await click("Account"); await settle(() => sessionRows().length > 0);
    await act(async () => { releaseSessions(Response.json([{ ...goodSession, id: 987654, current: false }])); });
    expect(text()).not.toContain("987654");
    intercept = path => path === "/api/auth/sessions" ? Promise.resolve(new Response("PRIVATE EXPIRED BODY", { status: 401 })) : undefined;
    await click("Refresh sessions"); await settle(out); expect(text()).not.toContain("PRIVATE EXPIRED BODY"); expect(sessionRows()).toHaveLength(0);
    intercept = undefined; await account(first); await click("Account"); await settle(() => sessionRows().length > 0);
    const changeForm = () => doc.querySelector('form[aria-label="Change password"]')!;
    const change = async (current: string, next: string, confirm = next) => {
      await fill("current-password", current); await fill("new-password", next); await fill("confirm-password", confirm);
      await act(async () => { changeForm().dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
    };
    const emptyPasswords = () => ["current-password", "new-password", "confirm-password"].every(id => (doc.getElementById(id) as HTMLInputElement).value === "");
    const device = await handler(new Request("http://localhost/api/auth/login", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ email: first, password }) }));
    expect(device.status).toBe(200);
    const deviceCookie = device.headers.get("set-cookie")!.split(";")[0]!;
    const oldCookie = cookie;
    for (const [current, next, confirm] of [
      ["short", password, password], [password, "short", "short"],
      ["😀".repeat(257), password, password], [password, "😀".repeat(257), "😀".repeat(257)],
      [password, "a".repeat(1025), "a".repeat(1025)], [password, password, "different confirmation"],
      [password, "\u0000".repeat(700), "\u0000".repeat(700)],
    ]) {
      const before = requests.length;
      await change(current!, next!, confirm!);
      expect(requests.length).toBe(before);
      expect(doc.querySelector('[role="alert"]')).not.toBeNull();
    }
    for (const value of ["a".repeat(12), "a".repeat(1024), "😀".repeat(256), "  é😀 exact value  "]) {
      let sent = false;
      intercept = (path, init) => {
        if (path !== "/api/auth/password") return;
        expect(JSON.parse(init!.body as string)).toEqual({ currentPassword: value, newPassword: value });
        sent = true;
        return Promise.resolve(new Response("private mutation failure", { status: 500 }));
      };
      await change(value, value);
      await settle(() => !(doc.getElementById("current-password") as HTMLInputElement).disabled);
      expect(sent).toBe(true); expect(text()).not.toContain("private mutation failure");
    }
    intercept = undefined;
    const beforeWrong = requests.length;
    await change("wrong current password!", password);
    await settle(() => text().includes("Could not change password"));
    expect(requests.slice(beforeWrong)).toEqual([{ path: "/api/auth/password", method: "POST" }, { path: "/api/auth/me", method: "GET" }]);
    expect(text()).toContain(first); expect(await (await bridge("/api/auth/me")).json()).toEqual(expect.objectContaining({ email: first }));
    // Revalidation failure or malformed/other identity is not confirmed expiry.
    for (const response of [new Response("private backend body", { status: 503 }), Response.json({ id: 999999, email: "other@example.com" }), Response.json({ token: "secret" })]) {
      intercept = path => path === "/api/auth/password" ? Promise.resolve(new Response("private password body", { status: 401 })) : path === "/api/auth/me" ? Promise.resolve(response) : undefined;
      await change(password, password); await settle(() => text().includes("Could not change password") && !(doc.getElementById("current-password") as HTMLInputElement).disabled);
      expect(text()).toContain(first); expect(text()).not.toContain("private password body"); expect(text()).not.toContain("private backend body");
    }
    intercept = undefined;
    // Leading/trailing whitespace and Unicode must survive unchanged.
    const nextPassword = "  é😀 new password!  ";
    await change(password, nextPassword);
    await settle(() => text().includes("Password changed"));
    expect(emptyPasswords()).toBe(true); expect(cookie).not.toBe(oldCookie);
    expect((await bridge("/api/auth/me")).status).toBe(200);
    for (const prior of [oldCookie, deviceCookie]) expect((await handler(new Request("http://localhost/api/auth/me", { headers: { cookie: prior } }))).status).toBe(401);
    const loginDirect = (value: string) => handler(new Request("http://localhost/api/auth/login", { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify({ email: first, password: value }) }));
    expect((await loginDirect(password)).status).toBe(401); expect((await loginDirect(nextPassword)).status).toBe(200);
    password = nextPassword;
    expect(dom.window.localStorage.length).toBe(0); expect(dom.window.sessionStorage.length).toBe(0);
    // A mutation that ignores abort cannot affect a subsequent account epoch.
    let releasePassword!: (response: Response) => void;
    intercept = path => path === "/api/auth/password" ? new Promise(resolve => { releasePassword = resolve; }) : undefined;
    await change(password, password);
    expect((doc.getElementById("current-password") as HTMLInputElement).disabled).toBe(true);
    const beforeDuplicate = requests.length;
    await act(async () => { changeForm().dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
    expect(requests.length).toBe(beforeDuplicate);
    await click("Log out"); await settle(out); intercept = undefined;
    await account(`pending-${Date.now()}@example.com`, true); await click("Account"); await fill("new-password", "next account draft");
    await act(async () => { releasePassword(new Response(null, { status: 204 })); await Bun.sleep(20); });
    expect((doc.getElementById("new-password") as HTMLInputElement).value).toBe("next account draft");
    expect(text()).not.toContain("Password changed");
    // Only /me 401 confirms expiry; old revalidation must also obey the epoch.
    let releaseMe!: (response: Response) => void;
    intercept = path => path === "/api/auth/password" ? Promise.resolve(new Response("secret", { status: 401 })) : path === "/api/auth/me" ? new Promise(resolve => { releaseMe = resolve; }) : undefined;
    await change(password, password); await settle(() => !!releaseMe);
    await click("Log out"); await settle(out); intercept = undefined; await account(first); await click("Account");
    await act(async () => { releaseMe(new Response("secret", { status: 401 })); await Bun.sleep(20); });
    expect(text()).toContain(first); expect(emptyPasswords()).toBe(true);
    intercept = path => ["/api/auth/password", "/api/auth/me"].includes(path) ? Promise.resolve(new Response("secret expired body", { status: 401 })) : undefined;
    await change(password, password); await settle(out);
    expect(text()).toContain("Your session expired"); expect(text()).not.toContain("secret expired body");
    intercept = undefined; await account(first);
    expect((doc.getElementById("note") as HTMLTextAreaElement).maxLength).toBe(1000);
    await fill("note", "  <script>private note</script>  "); await submit();
    await settle(() => doc.querySelector("li")?.textContent === "<script>private note</script>");
    expect(doc.querySelector("li script")).toBeNull();
    // Generated resource is reachable from the real authenticated App.
    const taskLink = doc.querySelector('a[href="#/tasks"]') as HTMLAnchorElement;
    expect(taskLink).not.toBeNull();
    await act(async () => { taskLink.click(); });
    await settle(() => text().includes("No Task yet"));
    await fill("Task-title", "  private task  ");
    await act(async () => { (doc.getElementById("Task-body-null") as HTMLInputElement).click(); });
    await fill("Task-body", "details");
    await fill("Task-count", "2"); await fill("Task-price", "1.25");
    await act(async () => { doc.querySelector('form[aria-label="Task editor"]')!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
    await settle(() => text().includes("private task") && !!doc.querySelector('button[aria-label^="Edit Task"]'));
    let rows = await (await bridge("/api/tasks")).json() as any[];
    expect(rows).toHaveLength(1); expect(rows[0].body).toBe("details");
    await click(`Edit Task ${rows[0].id}`);
    await act(async () => { (doc.getElementById("Task-body-null") as HTMLInputElement).click(); });
    await click("Save Task");
    await settle(() => text().includes("Task saved"));
    rows = await (await bridge("/api/tasks")).json() as any[];
    expect(rows[0].body).toBeNull();
    await click(`Delete Task ${rows[0].id}`);
    await settle(() => text().includes("No Task yet"));
    expect(await (await bridge("/api/tasks")).json()).toEqual([]);
    // Seed 205 rows in one ORM flush, then navigate real migrated SQLite pages.
    const { withDatabase } = await import("bundle/src/database/connection.ts");
    const { Task } = await import("../src/models/Task.ts");
    const { User } = await import("../src/models/User.ts");
    const appRoot = new URL("../", import.meta.url).pathname;
    let seeded: number[] = [];
    await withDatabase(async orm => {
      const em = orm.em.fork();
      const owner = await em.findOneOrFail(User, { email: first });
      const entities = Array.from({ length: 205 }, (_, i) => em.create(Task, { owner, title: `paged ${i + 1}`, count: i, price: 1, done: false }));
      em.persist(entities); await em.flush(); seeded = entities.map(row => row.id);
    }, { root: appRoot });
    const nav = (label: string) => [...doc.querySelectorAll("button")].find(b => b.textContent === label) as HTMLButtonElement;
    const visibleIds = () => [...doc.querySelectorAll('button[aria-label^="Edit Task"]')].map(b => Number(b.getAttribute("aria-label")!.split(" ").at(-1)));
    const checkPage = (page: number, ids: number[], more: boolean) => {
      expect(text()).toContain(`Page ${page}`);
      expect(visibleIds()).toEqual(ids);
      expect(new Set(visibleIds()).size).toBe(ids.length);
      const items = doc.querySelectorAll('ul[aria-label="Your Task"] li');
      expect(items[0]?.textContent).toContain(`paged ${seeded.indexOf(ids[0]!) + 1}`);
      expect(items[items.length - 1]?.textContent).toContain(`paged ${seeded.indexOf(ids.at(-1)!) + 1}`);
      expect(nav("Previous").disabled).toBe(page === 1);
      expect(nav("Next").disabled).toBe(!more);
    };
    await click("Refresh Task"); await settle(() => visibleIds().length === 100);
    checkPage(1, seeded.slice(0, 100), true);
    const arrayResponse = await bridge("/api/tasks");
    expect(arrayResponse.headers.get("X-Has-More")).toBe("true");
    expect((await arrayResponse.json() as any[]).map(row => row.id)).toEqual(seeded.slice(0, 100));
    // Failed navigation cannot commit a cursor; in-flight navigation is locked.
    let releasePage!: (response: Response) => void;
    intercept = path => path.startsWith("/api/tasks?") ? new Promise(resolve => { releasePage = resolve; }) : undefined;
    await click("Next");
    expect(nav("Previous").disabled).toBe(true); expect(nav("Next").disabled).toBe(true); expect(text()).toContain("Page 1");
    await act(async () => { releasePage(new Response("private page failure", { status: 500 })); });
    await settle(() => text().includes("Request failed"));
    expect(text()).toContain("Page 1"); expect(text()).not.toContain("private page failure");
    intercept = undefined; await click("Refresh Task"); await settle(() => visibleIds().length === 100);
    await click("Next"); await settle(() => visibleIds()[0] === seeded[100]); checkPage(2, seeded.slice(100, 200), true);
    await click("Next"); await settle(() => visibleIds().length === 5); checkPage(3, seeded.slice(200), false);
    // Deletes may empty the tail. The UI stays there until Previous is explicit.
    await withDatabase(async orm => { await orm.em.fork().nativeDelete(Task, { id: { $in: seeded.slice(200) } }); }, { root: appRoot });
    await click("Refresh Task"); await settle(() => text().includes("No Task yet"));
    expect(text()).toContain("Page 3"); expect(nav("Previous").disabled).toBe(false); expect(nav("Next").disabled).toBe(true);
    await fill("Task-title", "new tail"); await fill("Task-count", "206"); await fill("Task-price", "1"); await click("Create Task");
    await settle(() => visibleIds().length === 1);
    expect(text()).toContain("Page 3"); expect(text()).toContain("new tail");
    const newId = visibleIds()[0]!; expect(newId).toBeGreaterThan(seeded.at(-1)!);
    await click(`Delete Task ${newId}`); await settle(() => text().includes("No Task yet"));
    expect(text()).toContain("Page 3"); expect(nav("Previous").disabled).toBe(false);
    await click("Previous"); await settle(() => visibleIds().length === 100); checkPage(2, seeded.slice(100, 200), false);
    await click("Previous"); await settle(() => visibleIds()[0] === seeded[0]); checkPage(1, seeded.slice(0, 100), true);
    await click("Next"); await settle(() => visibleIds()[0] === seeded[100]);
    // A response at/below the exclusive boundary must be rejected even if sorted.
    intercept = path => path.startsWith("/api/tasks?") ? Promise.resolve(Response.json([{ id: seeded[99], title: "boundary leak", body: null, label: null, count: 1, price: 1, done: false, rank: null, ratio: null, active: null }], { headers: { "X-Has-More": "false" } })) : undefined;
    await click("Refresh Task"); await settle(() => text().includes("Request failed"));
    expect(text()).not.toContain("boundary leak"); expect(nav("Next").disabled).toBe(true);
    intercept = undefined; await click("Refresh Task"); await settle(() => visibleIds()[0] === seeded[100]);
    checkPage(2, seeded.slice(100, 200), false);
    await click("Previous"); await settle(() => visibleIds()[0] === seeded[0]);
    await withDatabase(async orm => { await orm.em.fork().nativeDelete(Task, { id: { $in: seeded } }); }, { root: appRoot });
    await click("Refresh Task"); await settle(() => text().includes("No Task yet"));
    // Reject hostile resource responses and retain drafts on failed mutations.
    const task = { id: 1, title: "must not render", body: null, label: null, count: 2, price: 1.25, done: false, rank: null, ratio: null, active: null };
    for (const invalid of [null, {}, [{ ...task, secret: "extra" }], [{ ...task, id: 0 }], [{ ...task, title: " " }], [{ ...task, count: 1.5 }], [{ ...task, price: null }], [{ ...task, done: "false" }], [{ ...task, body: 42 }], [task, task], [{ ...task, id: 2 }, task], Array.from({ length: 101 }, (_, i) => ({ ...task, id: i + 1 }))]) {
      intercept = path => path === "/api/tasks" ? Promise.resolve(Response.json(invalid, { headers: { "X-Has-More": "false" } })) : undefined;
      await click("Refresh Task"); await settle(() => text().includes("Request failed"));
      expect(text()).not.toContain("must not render");
    }
    for (const header of [undefined, "", "1", "TRUE", "false, true", "true"]) {
      intercept = path => path === "/api/tasks" ? Promise.resolve(Response.json([], { headers: header === undefined ? {} : { "X-Has-More": header } })) : undefined;
      await click("Refresh Task");
      await settle(() => text().includes("Request failed")); expect(nav("Next").disabled).toBe(true);
    }
    intercept = undefined; await click("Refresh Task"); await settle(() => text().includes("No Task yet"));
    await fill("Task-title", "keep task draft"); await fill("Task-count", "3"); await fill("Task-price", "2.5");
    intercept = (path, init) => path === "/api/tasks" && init?.method === "POST" ? Promise.resolve(new Response("private SQL failure", { status: 500 })) : undefined;
    await click("Create Task"); await settle(() => text().includes("Request failed"));
    expect((doc.getElementById("Task-title") as HTMLInputElement).value).toBe("keep task draft");
    expect(text()).not.toContain("private SQL failure");
    // Client rejects unsafe integer input without sending a mutation.
    intercept = undefined; await fill("Task-count", "1.5");
    const beforeTaskValidation = requests.length;
    await act(async () => { doc.querySelector('form[aria-label="Task editor"]')!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })); });
    expect(requests.length).toBe(beforeTaskValidation);
    await fill("Task-count", "3"); await click("Create Task");
    await settle(() => !!doc.querySelector('button[aria-label^="Edit Task"]'));
    const ownedTask = (await (await bridge("/api/tasks")).json() as any[])[0];
    // A read that ignores abort must not expire or populate the next account.
    let releaseTask!: (response: Response) => void;
    intercept = path => path === "/api/tasks" ? new Promise(resolve => { releaseTask = resolve; }) : undefined;
    await click("Refresh Task"); expect(text()).toContain("Loading Task");
    await click("Log out"); await settle(out); intercept = undefined;
    // Login helper expects Notes, so select it while signed out.
    dom.window.location.hash = "#/notes";
    await account(second, true); await settle(() => text().includes("No notes yet"));
    await act(async () => { releaseTask(new Response("expired old request", { status: 401 })); await Bun.sleep(20); });
    expect(text()).toContain(second); expect(text()).not.toContain("keep task draft");
    expect(await (await bridge("/api/tasks")).json()).toEqual([]);
    for (const method of ["GET", "PATCH", "DELETE"]) {
      const response = await bridge(`/api/tasks/${ownedTask.id}`, { method, ...(method === "PATCH" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ body: null }) } : {}) });
      expect(response.status).toBe(404);
    }
    await act(async () => { (doc.querySelector('a[href="#/tasks"]') as HTMLAnchorElement).click(); });
    await settle(() => text().includes("No Task yet"));
    // Hold a write across logout/login; it must not reset the next account's draft.
    await fill("Task-title", "pending task"); await fill("Task-count", "1"); await fill("Task-price", "1");
    intercept = (path, init) => path === "/api/tasks" && init?.method === "POST" ? new Promise(resolve => { releaseTask = resolve; }) : undefined;
    await click("Create Task"); await click("Log out"); await settle(out); intercept = undefined;
    dom.window.location.hash = "#/notes";
    await account(first); await settle(() => text().includes("private note"));
    await act(async () => { releaseTask(Response.json({ ...task, title: "pending task", count: 1, price: 1 }, { status: 201 })); await Bun.sleep(20); });
    expect(text()).not.toContain("pending task");
    await act(async () => { (doc.querySelector('a[href="#/tasks"]') as HTMLAnchorElement).click(); });
    await settle(() => text().includes("keep task draft"));
    // Current resource 401 invalidates the entire account and Notes state.
    intercept = path => path === "/api/tasks" ? Promise.resolve(new Response("Unauthorized", { status: 401 })) : undefined;
    await click("Refresh Task"); await settle(out);
    expect(text()).not.toContain("keep task draft"); expect(text()).not.toContain(first);
    intercept = undefined; dom.window.location.hash = "#/notes";
    await account(first); await settle(() => text().includes("private note"));
    await act(async () => { (doc.querySelector('a[href="#/notes"]') as HTMLAnchorElement).click(); });
    await settle(() => !!doc.getElementById("note"));
    await click("Log out"); await settle(out);
    expect(text()).not.toContain("private note"); expect(text()).not.toContain(first);
    await account(second); await settle(() => text().includes("No notes yet"));
    expect(text()).not.toContain("private note");
    await click("Log out"); await settle(out);
    await account(first); await settle(() => text().includes("private note"));
    // Retryable list failure must never echo server text; invalid shape is rejected.
    intercept = (path, init) => path === "/api/notes" && !init?.method ? Promise.resolve(Response.json([{ id: 1, body: "leaked", secret: "extra" }])) : undefined;
    await click("Refresh notes"); await settle(() => text().includes("Could not load notes"));
    expect(text()).not.toContain("leaked");
    intercept = () => undefined;
    await click("Refresh notes"); await settle(() => text().includes("private note"));
    // Failed writes keep the draft; no untrusted server error reaches the page.
    intercept = (path, init) => path === "/api/notes" && init?.method === "POST" ? Promise.resolve(new Response("private SQL error", { status: 500 })) : undefined;
    await fill("note", "keep this draft"); await submit();
    await settle(() => text().includes("Could not create note"));
    expect((doc.getElementById("note") as HTMLTextAreaElement).value).toBe("keep this draft");
    expect(text()).not.toContain("private SQL error");
    // Reject invalid list elements, duplicates, unsorted IDs and over-limit windows.
    for (const invalid of [null, {}, [{ id: 0, body: "bad" }], [{ id: 1, body: " " }], [{ id: 1, body: "x".repeat(1001) }], [{ id: 2, body: "a" }, { id: 1, body: "b" }], [{ id: 1, body: "a" }, { id: 1, body: "b" }], Array.from({ length: 101 }, (_, i) => ({ id: i + 1, body: "over limit" }))]) {
      intercept = (path, init) => path === "/api/notes" && !init?.method ? Promise.resolve(Response.json(invalid)) : undefined;
      await click("Refresh notes"); await settle(() => text().includes("Could not load notes"));
      expect(doc.querySelector("li")).toBeNull();
    }
    intercept = undefined; await click("Refresh notes"); await settle(() => text().includes("private note"));
    // Hold an old account's read across logout and new account registration.
    let release!: (response: Response) => void;
    intercept = (path, init) => path === "/api/notes" && !init?.method ? new Promise(resolve => { release = resolve; }) : undefined;
    await click("Refresh notes");
    await click("Log out"); await settle(out);
    intercept = undefined;
    await account(second); await settle(() => text().includes("No notes yet"));
    await act(async () => { release(Response.json([{ id: 999, body: "stale private data" }])); await Bun.sleep(20); });
    expect(text()).not.toContain("stale private data"); expect(text()).not.toContain("private note");
    // A pending create from the old account must not update another account's UI.
    intercept = (path, init) => path === "/api/notes" && init?.method === "POST" ? new Promise(resolve => { release = resolve; }) : undefined;
    await fill("note", "old account create"); await submit();
    expect(text()).toContain("Creating note…");
    await click("Log out"); await settle(out); intercept = undefined;
    await account(first); await settle(() => text().includes("private note"));
    await act(async () => { release(Response.json({ id: 999, body: "old account create" }, { status: 201 })); await Bun.sleep(20); });
    expect(text()).not.toContain("old account create");
    // Session expiry clears user, notes and the editor rather than showing stale data.
    intercept = (path, init) => path === "/api/notes" && !init?.method ? Promise.resolve(new Response("Unauthorized", { status: 401 })) : undefined;
    await click("Refresh notes"); await settle(out);
    expect(text()).toContain("Your session expired"); expect(text()).not.toContain("private note");
    intercept = undefined; await account(second); await settle(() => text().includes("No notes yet"));
    // Logout failures clear private state but block account changes until revocation succeeds.
    intercept = path => path === "/api/auth/logout" ? Promise.resolve(new Response("<script>untrusted error</script>", { status: 500 })) : undefined;
    await click("Log out"); await settle(() => text().includes("Could not log out"));
    expect(text()).not.toContain(second); expect(text()).not.toContain("untrusted error");
    expect(doc.getElementById("email")).toBeNull();
    intercept = undefined; await click("Retry logout"); await settle(out);
    // Client validation enforces UTF-8 password bytes and nonempty trimmed Notes.
    await fill("email", first); await fill("password", "😀".repeat(300));
    const beforeValidation = requests.length; await submit();
    expect(requests.length).toBe(beforeValidation); expect(text()).toContain("1024 UTF-8 bytes");
    // Never accept malformed user objects or forward server credential errors.
    intercept = () => Promise.resolve(Response.json({ id: 1, email: first, token: "forbidden" }));
    await fill("email", first); await fill("password", password); await submit();
    await settle(() => text().includes("Could not log in")); expect(doc.getElementById("note")).toBeNull();
    intercept = () => Promise.resolve(new Response("sensitive backend error", { status: 401 }));
    await fill("password", password); await submit(); await settle(() => text().includes("Could not log in"));
    expect(text()).not.toContain("sensitive backend error");
    expect(dom.window.localStorage.length).toBe(0); expect(dom.window.sessionStorage.length).toBe(0);
    expect(requests).toEqual(expect.arrayContaining([
      { path: "/api/auth/me", method: "GET" }, { path: "/api/auth/register", method: "POST" },
      { path: "/api/auth/login", method: "POST" }, { path: "/api/auth/logout", method: "POST" },
      { path: "/api/notes", method: "GET" }, { path: "/api/notes", method: "POST" },
    ]));
  } finally {
    await act(async () => { root.unmount(); }); globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    dom.window.close();
  }
}, 30_000);
