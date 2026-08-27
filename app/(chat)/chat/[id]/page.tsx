// The chat layout owns the visible shell; this leaf exists only to bind the id.
// Rendering it for cached-navigation validation would intentionally render
// nothing, so opt out instead of making Next drop the segment with a warning.
export const instant = false;

export default function Page() {
  return null;
}
