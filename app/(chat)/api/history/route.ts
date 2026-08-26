import { ipAddress } from "@vercel/functions";
import type { NextRequest } from "next/server";
import { auth } from "@/app/(auth)/auth";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import { subscriberAccessResponse } from "@/lib/auth/subscriber-access";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";
import { deleteAllChatsByUserId, getChatsByUserId } from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const limit = Math.min(
    Math.max(Number.parseInt(searchParams.get("limit") || "10", 10), 1),
    50
  );
  const startingAfter = searchParams.get("starting_after");
  const endingBefore = searchParams.get("ending_before");

  if (startingAfter && endingBefore) {
    return new ChatbotError(
      "bad_request:api",
      "Only one of starting_after or ending_before can be provided."
    ).toResponse();
  }

  const session = await auth();
  const access = await authorizeSubscriberAccess(session);
  if (access.kind !== "allowed") {
    return subscriberAccessResponse(access);
  }

  const admission = await enforceAbusePolicy({
    ip: ipAddress(request) ?? null,
    route: "history_read",
    userId: access.userId,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const chats = await getChatsByUserId({
    endingBefore,
    id: access.userId,
    limit,
    startingAfter,
  });

  return Response.json(chats);
}

export async function DELETE(request: Request) {
  const session = await auth();
  const access = await authorizeSubscriberAccess(session);
  if (access.kind !== "allowed") {
    return subscriberAccessResponse(access);
  }

  const admission = await enforceAbusePolicy({
    ip: ipAddress(request) ?? null,
    route: "history_delete",
    userId: access.userId,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const result = await deleteAllChatsByUserId({ userId: access.userId });

  return Response.json(result, { status: 200 });
}
