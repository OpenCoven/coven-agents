import { put } from "@vercel/blob";
import { ipAddress } from "@vercel/functions";
import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/app/(auth)/auth";
import { readBoundedFormData } from "@/lib/abuse/body";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import { abusePolicyFor } from "@/lib/abuse/policy";
import { subscriberAccessResponse } from "@/lib/auth/subscriber-access";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";

const FileSchema = z.object({
  file: z
    .instanceof(Blob)
    .refine((file) => file.size <= 5 * 1024 * 1024, {
      message: "File size should be less than 5MB",
    })
    .refine((file) => ["image/jpeg", "image/png"].includes(file.type), {
      message: "File type should be JPEG or PNG",
    }),
});

export async function POST(request: Request) {
  const session = await auth();
  const access = await authorizeSubscriberAccess(session);
  if (access.kind !== "allowed") {
    return subscriberAccessResponse(access);
  }

  const admission = await enforceAbusePolicy({
    ip: ipAddress(request) ?? null,
    route: "upload",
    userId: access.userId,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  if (request.body === null) {
    return new Response("Request body is empty", { status: 400 });
  }

  const body = await readBoundedFormData(
    request,
    abusePolicyFor("upload").bodyBytes
  );
  if (body.kind === "too_large") {
    return NextResponse.json({ error: "request_too_large" }, { status: 413 });
  }
  if (body.kind === "invalid") {
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 400 }
    );
  }

  const formData = body.value;
  const file = formData.get("file") as Blob;

  if (!file) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }

  const validatedFile = FileSchema.safeParse({ file });

  if (!validatedFile.success) {
    const errorMessage = validatedFile.error.issues
      .map((error) => error.message)
      .join(", ");

    return NextResponse.json({ error: errorMessage }, { status: 400 });
  }

  const filename = (formData.get("file") as File).name;
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const fileBuffer = await file.arrayBuffer();

  try {
    const data = await put(`${safeName}`, fileBuffer, {
      access: "public",
    });

    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
