import { timingSafeEqual } from "node:crypto";

export function authorizeInternalRequest(
  request: Request,
  expected: string
): boolean {
  const supplied = request.headers.get("x-service-token");
  if (!supplied || !expected) {
    return false;
  }

  const suppliedBytes = new TextEncoder().encode(supplied);
  const expectedBytes = new TextEncoder().encode(expected);
  if (suppliedBytes.byteLength !== expectedBytes.byteLength) {
    return false;
  }

  return timingSafeEqual(suppliedBytes, expectedBytes);
}
