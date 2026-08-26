import { ipAddress } from "@vercel/functions";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import type { ArtifactKind } from "@/components/chat/artifact";
import { readBoundedJson } from "@/lib/abuse/body";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import { abusePolicyFor } from "@/lib/abuse/policy";
import { subscriberAccessResponse } from "@/lib/auth/subscriber-access";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";
import {
  deleteDocumentsByIdAfterTimestamp,
  getDocumentsById,
  saveDocument,
  updateDocumentContent,
} from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";

const documentSchema = z.object({
  content: z.string(),
  isManualEdit: z.boolean().optional(),
  kind: z.enum(["text", "code", "image", "sheet"]),
  title: z.string(),
});

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatbotError(
      "bad_request:api",
      "Parameter id is missing"
    ).toResponse();
  }

  const session = await auth();
  const access = await authorizeSubscriberAccess(session);
  if (access.kind !== "allowed") {
    return subscriberAccessResponse(access);
  }

  const admission = await enforceAbusePolicy({
    ip: ipAddress(request) ?? null,
    route: "document_read",
    userId: access.userId,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const documents = await getDocumentsById({ id });

  const [document] = documents;

  if (!document) {
    return new ChatbotError("not_found:document").toResponse();
  }

  if (document.userId !== access.userId) {
    return new ChatbotError("forbidden:document").toResponse();
  }

  return Response.json(documents, { status: 200 });
}

async function writeDocument(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return new ChatbotError(
      "bad_request:api",
      "Parameter id is required."
    ).toResponse();
  }

  const session = await auth();
  const access = await authorizeSubscriberAccess(session);
  if (access.kind !== "allowed") {
    return subscriberAccessResponse(access);
  }

  const admission = await enforceAbusePolicy({
    ip: ipAddress(request) ?? null,
    route: "document_write",
    userId: access.userId,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const body = await readBoundedJson(
    request,
    abusePolicyFor("document_write").bodyBytes,
    documentSchema
  );
  if (body.kind === "too_large") {
    return Response.json({ error: "request_too_large" }, { status: 413 });
  }
  if (body.kind === "invalid") {
    return new ChatbotError(
      "bad_request:api",
      "Invalid request body."
    ).toResponse();
  }
  const {
    content,
    isManualEdit,
    kind,
    title,
  }: {
    content: string;
    isManualEdit?: boolean;
    kind: ArtifactKind;
    title: string;
  } = body.value;

  const documents = await getDocumentsById({ id });

  if (documents.length > 0) {
    const [doc] = documents;

    if (doc.userId !== access.userId) {
      return new ChatbotError("forbidden:document").toResponse();
    }
  }

  if (isManualEdit && documents.length > 0) {
    const result = await updateDocumentContent({ content, id });
    return Response.json(result, { status: 200 });
  }

  const document = await saveDocument({
    content,
    id,
    kind,
    title,
    userId: access.userId,
  });

  return Response.json(document, { status: 200 });
}

export function POST(request: Request) {
  return writeDocument(request);
}

export function PATCH(request: Request) {
  return writeDocument(request);
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const timestamp = searchParams.get("timestamp");

  if (!id) {
    return new ChatbotError(
      "bad_request:api",
      "Parameter id is required."
    ).toResponse();
  }

  if (!timestamp) {
    return new ChatbotError(
      "bad_request:api",
      "Parameter timestamp is required."
    ).toResponse();
  }

  const session = await auth();
  const access = await authorizeSubscriberAccess(session);
  if (access.kind !== "allowed") {
    return subscriberAccessResponse(access);
  }

  const admission = await enforceAbusePolicy({
    ip: ipAddress(request) ?? null,
    route: "document_delete",
    userId: access.userId,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const documents = await getDocumentsById({ id });

  const [document] = documents;

  if (document.userId !== access.userId) {
    return new ChatbotError("forbidden:document").toResponse();
  }

  const parsedTimestamp = new Date(timestamp);

  if (Number.isNaN(parsedTimestamp.getTime())) {
    return new ChatbotError(
      "bad_request:api",
      "Invalid timestamp."
    ).toResponse();
  }

  const documentsDeleted = await deleteDocumentsByIdAfterTimestamp({
    id,
    timestamp: parsedTimestamp,
  });

  return Response.json(documentsDeleted, { status: 200 });
}
