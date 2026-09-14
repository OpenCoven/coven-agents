import { pageAuth } from "@/app/(auth)/auth";
import { browserApplicationPath } from "@/lib/application-path";

// Revalidate on leaf navigation too: Next can reuse the authenticated layout.
// Rendering it for cached-navigation validation would intentionally render
// nothing, so opt out instead of making Next drop the segment with a warning.
export const instant = false;

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await pageAuth(browserApplicationPath(`/chat/${id}`));
  return null;
}
