import { eq } from "drizzle-orm";
import { auth } from "@/app/(auth)/auth";
import { subscriberAccessResponse } from "@/lib/auth/subscriber-access";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";
import { avatarFor, isStorableAvatarUrl } from "@/lib/avatar";
import { databaseFor } from "@/lib/db/access";
import { user as userTable } from "@/lib/db/schema";

/**
 * The account's avatar.
 *
 * Signed in is enough to read one, because every account has an avatar whether
 * or not it has ever stored anything -- the default is generated from the id.
 * Writing touches the owner's database, so it takes the same subscriber check
 * as every other write, rather than a looser one because the field is
 * cosmetic.
 */
async function resolveAccount() {
  const session = await auth();

  if (!session?.user?.id) {
    return null;
  }

  return {
    authSession: session,
    userId: session.user.id,
  };
}

export async function GET() {
  const account = await resolveAccount();

  if (!account) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const access = await authorizeSubscriberAccess(account.authSession);
  if (access.kind === "subscription_required") {
    // Guest access never reads stored account data. The generated avatar needs
    // only the already-authenticated account id.
    return Response.json({
      avatar: avatarFor({ id: account.userId }),
      custom: false,
    });
  }
  if (access.kind !== "allowed") {
    return subscriberAccessResponse(access);
  }

  const rows = await databaseFor(access.session)
    .select({ image: userTable.image })
    .from(userTable)
    .where(eq(userTable.id, account.userId))
    .limit(1);

  const image = rows[0]?.image ?? null;

  return Response.json({
    avatar: avatarFor({ id: account.userId, image }),
    custom: Boolean(image),
  });
}

/**
 * Sets or clears the avatar.
 *
 * A null image is a clear, not a failure -- it is how someone goes back to the
 * generated default, so it must not be confused with a rejected value.
 */
export async function PUT(request: Request) {
  const account = await resolveAccount();

  if (!account) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const access = await authorizeSubscriberAccess(account.authSession);
  if (access.kind !== "allowed") {
    return subscriberAccessResponse(access);
  }

  const body = (await request.json().catch(() => null)) as {
    image?: unknown;
  } | null;
  const raw = body?.image;
  const trimmed = typeof raw === "string" ? raw.trim() : null;

  if (raw !== null && raw !== undefined && typeof raw !== "string") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  if (trimmed && !isStorableAvatarUrl(trimmed)) {
    return Response.json(
      {
        error: "invalid_image",
        message:
          "Give an https image URL, or clear it to use the generated one.",
      },
      { status: 422 }
    );
  }

  const image = trimmed || null;

  await databaseFor(access.session)
    .update(userTable)
    .set({ image })
    .where(eq(userTable.id, account.userId));

  return Response.json({
    avatar: avatarFor({ id: account.userId, image }),
    custom: Boolean(image),
  });
}
