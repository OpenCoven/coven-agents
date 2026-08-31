/**
 * Avatars, without a third party.
 *
 * The obvious implementations -- Gravatar, DiceBear, any avatar CDN -- work by
 * sending the account's email or id to someone else and letting them serve an
 * image back. That hands a stable identifier for every tenant to an external
 * service and makes an account page fail to render when that service is down.
 * Generating the image here costs a few lines and leaks nothing.
 *
 * The result is a `data:` URI, so it also survives a strict image CSP and
 * needs no `remotePatterns` entry.
 */

/**
 * FNV-1a. Deliberately not a cryptographic hash: this picks colours and
 * squares, so the only property that matters is that the same seed always
 * produces the same picture. Using SHA-256 here would force the whole call
 * chain async to decorate a menu button.
 */
function hash(seed: string): number {
  let value = 0x81_1c_9d_c5;

  for (let index = 0; index < seed.length; index += 1) {
    value ^= seed.charCodeAt(index);
    value = Math.imul(value, 0x01_00_01_93) >>> 0;
  }

  return value >>> 0;
}

const GRID = 5;
const HALF = Math.ceil(GRID / 2);

/**
 * A symmetric 5x5 identicon.
 *
 * Only the left three columns are decided; the rest are mirrored. Symmetry is
 * what makes an arbitrary bit pattern read as a deliberate mark rather than
 * noise.
 */
export function generatedAvatar(seed: string): string {
  const value = hash(seed || "anonymous");
  const hue = value % 360;
  const background = `hsl(${hue} 62% 16%)`;
  const foreground = `hsl(${hue} 78% 68%)`;

  const cells: string[] = [];

  for (let row = 0; row < GRID; row += 1) {
    for (let column = 0; column < HALF; column += 1) {
      // Re-hash per cell so neighbouring squares do not simply track adjacent
      // bits of one number, which produces visible banding.
      if (hash(`${value}:${row}:${column}`) % 2 === 0) {
        continue;
      }

      const mirrored = GRID - 1 - column;
      cells.push(`<rect x="${column}" y="${row}" width="1" height="1"/>`);

      if (mirrored !== column) {
        cells.push(`<rect x="${mirrored}" y="${row}" width="1" height="1"/>`);
      }
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GRID} ${GRID}" width="${GRID}" height="${GRID}" shape-rendering="crispEdges">` +
    `<rect width="${GRID}" height="${GRID}" fill="${background}"/>` +
    `<g fill="${foreground}">${cells.join("")}</g>` +
    "</svg>";

  // `encodeURIComponent` rather than base64: it keeps the payload readable in
  // devtools and avoids depending on `btoa`/`Buffer`, which differ between the
  // server and the browser.
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Only `https:` is stored.
 *
 * The value is rendered as an image `src`, so a `javascript:` or `data:` URL
 * would be a stored-content injection with the account page as its delivery
 * mechanism, and a plaintext `http:` image on an https page is blocked as
 * mixed content anyway -- it would save cleanly and then never appear.
 */
export function isStorableAvatarUrl(candidate: string): boolean {
  if (candidate.length > 2048) {
    return false;
  }

  try {
    return new URL(candidate).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * What to render for an account, given whatever is stored.
 *
 * Seeded by the user id rather than the email so the picture does not change
 * when someone changes their address.
 */
export function avatarFor(user: { id: string; image?: string | null }): string {
  const stored = user.image?.trim();

  return stored && isStorableAvatarUrl(stored)
    ? stored
    : generatedAvatar(user.id);
}

export function avatarSessionRefreshStatus(
  expectedImage: string | null,
  session: { user?: { image?: string | null } | null } | null
): "deferred" | "refreshed" {
  if (!session?.user) {
    return "deferred";
  }
  return (session.user.image ?? null) === expectedImage
    ? "refreshed"
    : "deferred";
}
