import type { z } from "zod";

export type BoundedBodyResult<T> =
  | { kind: "invalid" }
  | { kind: "ok"; value: T }
  | { kind: "too_large" };

export type BoundedBytesResult =
  | BoundedBodyResult<Uint8Array>
  | { error: unknown; kind: "read_error" };

function declaredContentLength(headers: Headers): number | "invalid" | null {
  const header = headers.get("content-length");
  if (header === null) {
    return null;
  }
  if (!/^(?:0|[1-9]\d*)$/.test(header)) {
    return "invalid";
  }

  const length = Number(header);
  return Number.isSafeInteger(length) ? length : Number.POSITIVE_INFINITY;
}

export async function readBoundedJson<T>(
  request: Request,
  maximumBytes: number,
  schema: z.ZodType<T>,
  options: { emptyBody?: unknown } = {}
): Promise<BoundedBodyResult<T>> {
  const body = await readBoundedBytes(request, maximumBytes);
  if (body.kind === "read_error") {
    return { kind: "invalid" };
  }
  if (body.kind !== "ok") {
    return body;
  }
  if (body.value.byteLength === 0) {
    if (!Object.hasOwn(options, "emptyBody")) {
      return { kind: "invalid" };
    }
    const parsed = schema.safeParse(options.emptyBody);
    return parsed.success
      ? { kind: "ok", value: parsed.data }
      : { kind: "invalid" };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body.value);
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success
      ? { kind: "ok", value: parsed.data }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

export async function readBoundedFormData(
  request: Request,
  maximumBytes: number
): Promise<BoundedBodyResult<FormData>> {
  const body = await readBoundedBytes(request, maximumBytes);
  if (body.kind === "read_error") {
    return { kind: "invalid" };
  }
  if (body.kind !== "ok" || body.value.byteLength === 0) {
    return body.kind === "ok" ? { kind: "invalid" } : body;
  }

  try {
    const headers = new Headers(request.headers);
    headers.delete("content-length");
    const boundedRequest = new Request(request.url, {
      body: body.value as BodyInit,
      headers,
      method: request.method,
    });
    return { kind: "ok", value: await boundedRequest.formData() };
  } catch {
    return { kind: "invalid" };
  }
}

function bodyPreflight(
  request: Request,
  maximumBytes: number
): { kind: "invalid" } | { kind: "too_large" } | null {
  const encoding = request.headers.get("content-encoding");
  if (encoding && encoding.trim().toLowerCase() !== "identity") {
    return { kind: "invalid" };
  }

  const length = declaredContentLength(request.headers);
  if (length === "invalid") {
    return { kind: "invalid" };
  }
  if (length !== null && length > maximumBytes) {
    return { kind: "too_large" };
  }
  return null;
}

export async function readBoundedBytes(
  request: Request,
  maximumBytes: number
): Promise<BoundedBytesResult> {
  validateMaximum(maximumBytes);

  const preflight = bodyPreflight(request, maximumBytes);
  if (preflight) {
    return preflight;
  }

  if (request.body === null) {
    return { kind: "ok", value: new Uint8Array() };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch (error) {
    return { error, kind: "read_error" };
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      // biome-ignore lint/performance/noAwaitInLoops: request streams must be consumed sequentially.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The limit decision is authoritative; cancellation is best-effort cleanup.
        }
        return { kind: "too_large" };
      }
      chunks.push(value);
    }
  } catch (error) {
    return { error, kind: "read_error" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", value: bytes };
}

function validateMaximum(maximumBytes: number): void {
  if (!Number.isFinite(maximumBytes) || maximumBytes < 0) {
    throw new RangeError("maximumBytes must be finite and nonnegative");
  }
}
