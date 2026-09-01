const ASCII = /^[\x20-\x7e]*$/u;

export function compareAscii(left: string, right: string): number {
  if (!(ASCII.test(left) && ASCII.test(right))) {
    throw new TypeError("ASCII comparison requires printable ASCII strings.");
  }
  return left < right ? -1 : left > right ? 1 : 0;
}
