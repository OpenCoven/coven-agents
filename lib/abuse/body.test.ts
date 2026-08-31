import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { readBoundedBytes, readBoundedFormData, readBoundedJson } from "./body";

const jsonSchema = z.object({ name: z.string() });

test("rejects invalid maximum byte limits", async () => {
  const request = jsonRequest('{"name":"coven"}');

  await Promise.all(
    [-1, Number.NaN, Number.POSITIVE_INFINITY].map((maximumBytes) =>
      assert.rejects(
        readBoundedJson(request.clone(), maximumBytes, jsonSchema),
        RangeError
      )
    )
  );
});

test("rejects a declared oversized JSON body before reading its stream", async () => {
  let opened = false;
  const request = {
    body: {
      getReader() {
        opened = true;
        throw new Error("body stream must not be opened");
      },
    },
    headers: new Headers({ "content-length": "129" }),
  } as unknown as Request;

  assert.deepEqual(await readBoundedJson(request, 128, jsonSchema), {
    kind: "too_large",
  });
  assert.equal(opened, false);
});

test("rejects unsupported content encoding before reading JSON", async () => {
  let opened = false;
  const request = {
    body: {
      getReader() {
        opened = true;
        throw new Error("encoded body must not be opened");
      },
    },
    headers: new Headers({ "content-encoding": "gzip" }),
  } as unknown as Request;

  assert.deepEqual(await readBoundedJson(request, 128, jsonSchema), {
    kind: "invalid",
  });
  assert.equal(opened, false);
});

test("bounds a streamed JSON body when content length is absent", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"name":"too long"}'));
    },
  });
  const request = streamRequest(stream, {
    "content-type": "application/json",
  });

  assert.deepEqual(await readBoundedJson(request, 8, jsonSchema), {
    kind: "too_large",
  });
  assert.equal(cancelled, true);
});

test("rejects declared oversized raw bytes before opening the stream", async () => {
  let opened = false;
  const request = {
    body: {
      getReader() {
        opened = true;
        throw new Error("body stream must not be opened");
      },
    },
    headers: new Headers({ "content-length": "9" }),
  } as unknown as Request;

  assert.deepEqual(await readBoundedBytes(request, 8), {
    kind: "too_large",
  });
  assert.equal(opened, false);
});

test("bounds a chunked raw body as streamed bytes cross the limit", async () => {
  let cancelled = false;
  const request = streamRequest(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        controller.enqueue(new Uint8Array([5]));
      },
    }),
    {}
  );

  assert.deepEqual(await readBoundedBytes(request, 4), {
    kind: "too_large",
  });
  assert.equal(cancelled, true);
});

test("accepts a raw body at the exact byte limit", async () => {
  const expected = new Uint8Array([0, 1, 2, 3]);
  const request = streamRequest(
    new ReadableStream({
      start(controller) {
        controller.enqueue(expected);
        controller.close();
      },
    }),
    { "content-length": String(expected.byteLength) }
  );

  assert.deepEqual(await readBoundedBytes(request, expected.byteLength), {
    kind: "ok",
    value: expected,
  });
});

test("preserves exact multibyte raw-body bytes", async () => {
  const expected = new TextEncoder().encode('{"name":"🧙"}');
  const request = streamRequest(
    new ReadableStream({
      start(controller) {
        controller.enqueue(expected.subarray(0, 10));
        controller.enqueue(expected.subarray(10));
        controller.close();
      },
    }),
    {}
  );

  const result = await readBoundedBytes(request, expected.byteLength);

  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.deepEqual(result.value, expected);
  }
});

test("reports raw stream failures distinctly", async () => {
  const failure = new Error("stream failed");
  const request = streamRequest(
    new ReadableStream({
      pull(controller) {
        controller.error(failure);
      },
    }),
    {}
  );

  const result = await readBoundedBytes(request, 64);

  assert.equal(result.kind, "read_error");
  if (result.kind === "read_error") {
    assert.equal(result.error, failure);
  }
});

test("reports raw stream reader failures distinctly", async () => {
  const failure = new Error("reader unavailable");
  const request = {
    body: {
      getReader() {
        throw failure;
      },
    },
    headers: new Headers(),
  } as unknown as Request;

  const result = await readBoundedBytes(request, 64);

  assert.equal(result.kind, "read_error");
  if (result.kind === "read_error") {
    assert.equal(result.error, failure);
  }
});

test("accepts valid bounded JSON and applies the supplied schema", async () => {
  const result = await readBoundedJson(
    jsonRequest('{"name":"coven"}'),
    64,
    jsonSchema
  );

  assert.deepEqual(result, { kind: "ok", value: { name: "coven" } });
});

test("treats empty, malformed, invalid UTF-8, and schema-invalid JSON as invalid", async () => {
  const invalidUtf8 = new Uint8Array([0xff]);

  await Promise.all(
    [
      jsonRequest(""),
      jsonRequest("{"),
      streamRequest(
        new ReadableStream({
          start(controller) {
            controller.enqueue(invalidUtf8);
            controller.close();
          },
        }),
        { "content-type": "application/json" }
      ),
      jsonRequest('{"name":3}'),
    ].map(async (request) => {
      assert.deepEqual(await readBoundedJson(request, 64, jsonSchema), {
        kind: "invalid",
      });
    })
  );
});

test("rejects declared oversized multipart before opening the stream", async () => {
  let opened = false;
  let originalFormDataCalled = false;
  const request = {
    body: {
      getReader() {
        opened = true;
        throw new Error("body stream must not be opened");
      },
    },
    formData() {
      originalFormDataCalled = true;
      throw new Error("original formData must not be called");
    },
    headers: new Headers({
      "content-length": "1025",
      "content-type": "multipart/form-data; boundary=coven",
    }),
  } as unknown as Request;

  assert.deepEqual(await readBoundedFormData(request, 1024), {
    kind: "too_large",
  });
  assert.equal(opened, false);
  assert.equal(originalFormDataCalled, false);
});

test("never parses multipart from the original unbounded request", async () => {
  const formData = new FormData();
  formData.append(
    "file",
    new Blob(["tiny"], { type: "image/png" }),
    "tiny.png"
  );
  const request = new Request("https://example.test/upload", {
    body: formData,
    method: "POST",
  });
  let originalFormDataCalled = false;
  Object.defineProperty(request, "formData", {
    value() {
      originalFormDataCalled = true;
      throw new Error("original formData must not be called");
    },
  });

  const result = await readBoundedFormData(request, 4096);

  assert.equal(result.kind, "ok");
  if (result.kind === "ok") {
    assert.equal((result.value.get("file") as File).name, "tiny.png");
  }
  assert.equal(originalFormDataCalled, false);
});

test("bounds multipart streams with missing content length before parsing", async () => {
  let originalFormDataCalled = false;
  const request = streamRequest(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1025));
      },
    }),
    { "content-type": "multipart/form-data; boundary=coven" }
  );
  Object.defineProperty(request, "formData", {
    value() {
      originalFormDataCalled = true;
      throw new Error("original formData must not be called");
    },
  });

  assert.deepEqual(await readBoundedFormData(request, 1024), {
    kind: "too_large",
  });
  assert.equal(originalFormDataCalled, false);
});

function jsonRequest(body: string): Request {
  return new Request("https://example.test/json", {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

function streamRequest(
  body: ReadableStream<Uint8Array>,
  headers: HeadersInit
): Request {
  return new Request("https://example.test/body", {
    body,
    duplex: "half",
    headers,
    method: "POST",
  } as RequestInit & { duplex: "half" });
}
