import { expect, test } from "bun:test";
import { createRouter } from "./router.ts";

function secure(response: Response) {
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("content-type")).toBeTruthy();
}

test("router enforces methods, HEAD bodies, secure headers, and generic errors on every path", async () => {
  let calls = 0;
  const router = createRouter([
    { path: "/ok", handler() { calls++; return new Response("hello", { headers: {
      "Content-Security-Policy": "default-src *", "Cache-Control": "public", "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "unsafe-url", "X-Content-Type-Options": "invalid",
    } }); } },
    { path: "/error", handler() { throw new Error("private-secret"); } },
    { path: "/async", async handler() { throw new Error("private-secret"); } },
    { path: "/invalid", handler: (() => "private-secret") as any },
  ]);
  for (const path of ["/ok", "/missing", "/error", "/async", "/invalid"]) {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await router(new Request(`http://localhost${path}`, { method }));
      secure(response);
      const status = !["GET", "HEAD"].includes(method) ? 405 : path === "/ok" ? 200 : path === "/missing" ? 404 : 500;
      expect(response.status).toBe(status);
      if (status === 405) expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(await response.text()).toBe(method === "HEAD" ? "" : status === 200 ? "hello" : status === 404 ? "Not Found" : status === 405 ? "Method Not Allowed" : "Internal Server Error");
    }
  }
  expect(calls).toBe(2);
});

test("router validates and snapshots static registrations", async () => {
  for (const path of ["/a\n", "/../secret", "/a/", "/a?b", "relative", "/%2f", "//a"]) {
    expect(() => createRouter([{ path, handler: () => new Response() }])).toThrow();
  }
  expect(() => createRouter([{ path: "/", handler: 42 } as any])).toThrow();
  expect(() => createRouter([{ path: "/", handler: () => new Response() }, { path: "/", handler: () => new Response() }])).toThrow("Duplicate");
  const entry = { path: "/ok", handler: () => new Response("original") };
  const router = createRouter([entry]);
  entry.handler = () => new Response("changed");
  expect(await (await router(new Request("http://localhost/ok"))).text()).toBe("original");
});

test("router preserves only known HttpErrors with safe text and security headers", async () => {
  const { HttpError } = await import("./http-error.ts");
  for (const method of ["GET", "HEAD"]) {
    for (const status of [400, 413, 415] as const) {
      for (const asyncHandler of [false, true]) {
        const fail = () => { throw new HttpError(status, "Safe request error"); };
        const router = createRouter([{ path: "/", handler: asyncHandler ? async () => fail() : fail }]);
        const response = await router(new Request("http://localhost/", { method }));
        secure(response);
        expect(response.status).toBe(status);
        expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(await response.text()).toBe(method === "HEAD" ? "" : "Safe request error");
      }
    }
    for (const error of [new Error("private-secret"), { status: 400, message: "private-secret" }, new Response("private-secret", { status: 400 }), new HttpError(401 as any, "private-secret")]) {
      const router = createRouter([{ path: "/", handler() { throw error; } }]);
      const response = await router(new Request("http://localhost/", { method }));
      secure(response);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe(method === "HEAD" ? "" : "Internal Server Error");
    }
  }
});

test("router safely renders JSON parser errors and redacts unexpected body failures", async () => {
  const { readJson } = await import("./request.ts");
  for (const [body, contentType, maxBytes, status, message] of [
    ["private-secret", "application/json", 64, 400, "Invalid JSON"],
    ["", "application/json", 64, 400, "Empty JSON body"],
    ['"private-secret"', "application/json", 2, 413, "Payload Too Large"],
    ["private-secret", "text/plain", 64, 415, "Unsupported Media Type"],
  ] as const) {
    const router = createRouter([{ path: "/", async handler() {
      await readJson(new Request("http://localhost/", { method: "POST", body, headers: { "content-type": contentType } }), { maxBytes });
      return new Response("ok");
    } }]);
    const response = await router(new Request("http://localhost/"));
    secure(response);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(message);
  }
  const router = createRouter([{ path: "/", async handler() {
    const body = new ReadableStream<Uint8Array>({ pull() { throw new Error("private-stream-secret"); } });
    await readJson(new Request("http://localhost/", { method: "POST", body, headers: { "content-type": "application/json" } }));
    return new Response("ok");
  } }]);
  const response = await router(new Request("http://localhost/"));
  secure(response);
  expect(response.status).toBe(500);
  expect(await response.text()).toBe("Internal Server Error");
});


test("explicit route methods are validated, snapshotted and produce precise Allow", async () => {
  const methods: ("GET" | "POST")[] = ["POST", "GET"];
  const router = createRouter([
    { path: "/notes", methods, handler: request => new Response(request.method) },
    { path: "/write", methods: ["POST"], handler: () => new Response("created") },
  ]);
  methods.splice(0);
  for (const method of ["GET", "HEAD", "POST"]) {
    const response = await router(new Request("http://localhost/notes", { method }));
    secure(response);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(method === "HEAD" ? "" : method);
  }
  for (const [path, allow] of [["/notes", "GET, HEAD, POST"], ["/write", "POST"]]) {
    const response = await router(new Request(`http://localhost${path}`, { method: "DELETE" }));
    secure(response);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe(allow!);
  }
  const head = await router(new Request("http://localhost/write", { method: "HEAD" }));
  expect(head.status).toBe(405);
  expect(await head.text()).toBe("");
  expect(head.headers.get("allow")).toBe("POST");
  for (const methods of [[], ["HEAD"], ["TRACE"], ["get"], ["GET", "GET"], new Array(1), "GET", null]) {
    expect(() => createRouter([{ path: "/", methods, handler: () => new Response() } as any])).toThrow("methods");
  }
});
