import { expect, test } from "bun:test";
import { HttpError } from "./http-error.ts";
import { readJson } from "./request.ts";

function request(body: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/", {
    method: "POST", body, headers: { "content-type": "application/json", ...headers },
  });
}

async function rejects(input: Request, status: 400 | 413 | 415, message: string, maxBytes = 64 * 1024) {
  try {
    await readJson(input, { maxBytes });
    throw new Error("Expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(status);
    expect((error as HttpError).message).toBe(message);
  }
}

function streamed(chunks: string[], length?: string) {
  let cancelled = false;
  let pulls = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return {
    input: new Request("http://localhost/", {
      method: "POST", body,
      headers: { "content-type": "application/json", ...(length === undefined ? {} : { "content-length": length }) },
    }),
    cancelled: () => cancelled,
    pulls: () => pulls,
  };
}

test("readJson returns unknown JSON values and accepts only JSON with optional UTF-8 charset", async () => {
  for (const contentType of ["application/json", "Application/JSON", "application/json; charset=utf-8", 'application/json; Charset="UTF-8"']) {
    for (const value of [{ ok: true }, [1, "two"], null, true, 42, "text"]) {
      expect(await readJson(request(JSON.stringify(value), { "content-type": contentType }))).toEqual(value);
    }
  }
});

test("readJson rejects missing/incorrect media types, charsets, and unsupported parameters", async () => {
  for (const contentType of ["", "text/plain", "application/problem+json", "application/jsonx", "application/json; charset=latin1", "application/json; charset=utf8", "application/json; charset=utf-8; charset=utf-8", "application/json; boundary=secret", "application/json;", "application/json, text/plain"]) {
    await rejects(request('{"private":"secret"}', { "content-type": contentType }), 415, "Unsupported Media Type");
  }
  await rejects(new Request("http://localhost/"), 415, "Unsupported Media Type");
});

test("readJson rejects malformed and empty bodies with safe 400 errors", async () => {
  for (const body of ["{private-secret", '{"a":}', "undefined", "{} {}"])
    await rejects(request(body), 400, "Invalid JSON");
  for (const body of ["", " \n\t "])
    await rejects(request(body), 400, "Empty JSON body");
  await rejects(new Request("http://localhost/", { headers: { "content-type": "application/json" } }), 400, "Empty JSON body");
});

test("readJson checks declared length before reading and cancels an oversized body", async () => {
  const body = streamed(["{}"], "100");
  await rejects(body.input, 413, "Payload Too Large", 8);
  expect(body.pulls()).toBe(0);
  expect(body.cancelled()).toBe(true);
  await rejects(request("{}", { "content-length": "999999999999999999999999999999999999" }), 413, "Payload Too Large");
});

test("readJson rejects invalid declared lengths without echoing headers", async () => {
  for (const length of ["", "-1", "1.5", "NaN", "2, 2", "2e0", "+2", "private-secret"]) {
    await rejects(request("{}", { "content-length": length }), 400, "Invalid Content-Length");
  }
  expect(await readJson(request("{}", { "content-length": "2" }))).toEqual({});
});

test("readJson enforces actual streaming bytes with missing or spoofed small lengths and cancels immediately", async () => {
  for (const length of [undefined, "0", "1", "8"]) {
    const body = streamed(['"1234', '56789', 'unread-secret"'], length);
    await rejects(body.input, 413, "Payload Too Large", 8);
    expect(body.pulls()).toBe(2);
    expect(body.cancelled()).toBe(true);
  }
});

test("readJson counts UTF-8 bytes, accepts the exact limit and decodes split multibyte characters", async () => {
  expect(await readJson(request('"é"'), { maxBytes: 4 })).toBe("é");
  await rejects(request('"é"'), 413, "Payload Too Large", 3);
  const bytes = new TextEncoder().encode('"💡"');
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  expect(await readJson(new Request("http://localhost/", { method: "POST", body, headers: { "content-type": "application/json" } }), { maxBytes: 6 })).toBe("💡");
});

test("readJson has a bounded default and validates configured limits", async () => {
  await rejects(request('"' + "a".repeat(64 * 1024) + '"'), 413, "Payload Too Large");
  for (const maxBytes of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await expect(readJson(request("{}"), { maxBytes })).rejects.toThrow("maxBytes must be a positive safe integer");
  }
});

test("readJson rejects invalid UTF-8 as malformed JSON", async () => {
  const input = new Request("http://localhost/", { method: "POST", body: Uint8Array.of(34, 255, 34), headers: { "content-type": "application/json" } });
  await rejects(input, 400, "Invalid JSON");
});

test("readJson preserves unexpected stream failures and does not leak cancellation failures", async () => {
  const failure = new Error("private-stream-secret");
  const broken = new ReadableStream<Uint8Array>({ pull() { throw failure; } });
  const input = new Request("http://localhost/", { method: "POST", body: broken, headers: { "content-type": "application/json" } });
  await expect(readJson(input)).rejects.toBe(failure);
  for (const length of [undefined, "100"]) {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode("too large")); },
      cancel() { throw new Error("private-cancel-secret"); },
    }, { highWaterMark: 0 });
    await rejects(new Request("http://localhost/", {
      method: "POST", body, headers: { "content-type": "application/json", ...(length ? { "content-length": length } : {}) },
    }), 413, "Payload Too Large", 2);
  }
});

// The typed boundary must preserve parser protections and hide schema diagnostics.
test("readValidatedJson infers transformed output without coercing primitives", async () => {
  const { readValidatedJson } = await import("./request.ts");
  const { schema } = await import("../validation/schema.ts");
  const shape = schema.object({ title: schema.string({ trim: true, min: 1 }), count: schema.number({ integer: true }), published: schema.boolean(), tag: schema.optional(schema.string()) });
  const data = await readValidatedJson(request(JSON.stringify({ title: " hello ", count: 2, published: false })), shape);
  const title: string = data.title;
  const count: number = data.count;
  const tag: string | undefined = data.tag;
  // @ts-expect-error Inferred number must not become any or string.
  const wrong: string = data.count;
  expect({ title, count, tag, published: data.published }).toEqual({ title: "hello", count: 2, tag: undefined, published: false });
  for (const patch of [{ count: "2" }, { published: "false" }]) {
    await expect(readValidatedJson(request(JSON.stringify({ title, count, published: false, ...patch })), shape)).rejects.toMatchObject({ status: 400, message: "Invalid request body" });
  }
});

test("readValidatedJson renders one safe router response for shapes, strict extras and nested schema paths", async () => {
  const { readValidatedJson } = await import("./request.ts");
  const { schema } = await import("../validation/schema.ts");
  const { createRouter } = await import("./router.ts");
  const shape = schema.object({ privateSchemaPath: schema.array(schema.object({ secretField: schema.literal("private-expected-value") })) });
  const router = createRouter([{ path: "/", methods: ["POST"], async handler(input) {
    return Response.json(await readValidatedJson(input, shape));
  } }]);
  for (const body of [null, [], {}, { privateSchemaPath: [{ secretField: "private-input-value" }] }, { privateSchemaPath: [], "private-extra-key": "private-extra-value" }]) {
    const response = await router(request(JSON.stringify(body)));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid request body");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  }
  try {
    await readValidatedJson(request("null"), shape);
    throw new Error("Expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect(Object.keys(error as object).sort()).toEqual(["name", "status"]);
    expect((error as Error).cause).toBeUndefined();
  }
});

test("readValidatedJson preserves parser statuses, streaming limits and custom maxBytes", async () => {
  const { readValidatedJson } = await import("./request.ts");
  const { schema } = await import("../validation/schema.ts");
  const { createRouter } = await import("./router.ts");
  const router = createRouter([{ path: "/", methods: ["POST"], async handler(input) {
    return Response.json(await readValidatedJson(input, schema.string(), { maxBytes: 4 }));
  } }]);
  for (const [input, status, message] of [
    [request("{"), 400, "Invalid JSON"],
    [request(""), 400, "Empty JSON body"],
    [request('"ok"', { "content-type": "text/plain" }), 415, "Unsupported Media Type"],
    [request('"ok"', { "content-length": "secret" }), 400, "Invalid Content-Length"],
    [request('"ok"', { "content-length": "100" }), 413, "Payload Too Large"],
    [streamed(['"é', 'é"'], "1").input, 413, "Payload Too Large"],
    [new Request("http://localhost/", { method: "POST", body: Uint8Array.of(34, 255, 34), headers: { "content-type": "application/json" } }), 400, "Invalid JSON"],
  ] as const) {
    const response = await router(input);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(message);
  }
  expect(await readValidatedJson(request('"é"'), schema.string(), { maxBytes: 4 })).toBe("é");
  await expect(readValidatedJson(request('"' + "a".repeat(64 * 1024) + '"'), schema.string())).rejects.toMatchObject({ status: 413 });
  await expect(readValidatedJson(request('"ok"'), schema.string(), { maxBytes: 0 })).rejects.toThrow("maxBytes must be a positive safe integer");
});
