import { auth } from "@/app/(auth)/auth";
import { decideCredentialWrite } from "@/lib/credentials/authorize";
import {
  deleteCredential,
  listCredentialHarnesses,
  putCredential,
} from "@/lib/credentials/store";
import {
  blocksSave,
  checkCopilotToken,
  checkMessage,
} from "@/lib/credentials/validate";
import { isSubscriber, toSession } from "@/lib/session";

/**
 * Where a tenant supplies their own harness credential.
 *
 * This is the counterpart to `/api/internal/credential`, which the worker
 * reads from. Without this route the store has a writer nothing calls, and a
 * run refused for a missing credential has no path to recovery.
 *
 * The authorization decision lives in `decideCredentialWrite` rather than
 * here, because logic inside a route handler cannot be unit tested and this is
 * the decision that says who may write to the owner's database.
 */
async function resolveSession() {
  const session = await auth();
  if (!session?.user?.id) {
    return null;
  }
  return toSession({ id: session.user.id, type: session.user.type });
}

function respond(decision: { kind: string; reason?: string }) {
  if (decision.kind === "unauthorized") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (decision.kind === "forbidden") {
    return Response.json(
      {
        error: "subscription_required",
        message:
          "Storing a credential needs an active subscription. Being signed in is not enough.",
      },
      { status: 403 }
    );
  }
  return Response.json(
    { error: decision.reason ?? "invalid_request" },
    { status: 400 }
  );
}

/**
 * Which harnesses this tenant has configured.
 *
 * Ids only, never the credential. The UI needs to say "configured" and offer
 * to replace or remove it; it never needs the value back, and returning one
 * would put a secret on the wire for a status check.
 */
export async function GET() {
  const session = await resolveSession();

  if (!session) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isSubscriber(session)) {
    return Response.json({ error: "subscription_required" }, { status: 403 });
  }

  return Response.json(
    { harnessIds: await listCredentialHarnesses(session) },
    { headers: { "cache-control": "no-store" } }
  );
}

export async function POST(request: Request) {
  const session = await resolveSession();

  let body: { credential?: unknown; harnessId?: unknown };
  try {
    body = (await request.json()) as {
      credential?: unknown;
      harnessId?: unknown;
    };
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const decision = decideCredentialWrite(session, body);
  if (decision.kind !== "allowed") {
    return respond(decision);
  }

  const credential = String(body.credential);

  // Checked before storing, against the same endpoint the harness checks
  // entitlement against, so a token that passes here is one the run will
  // accept. Without this the first sign of a wrong token is a failed run,
  // long after the person believed they were set up.
  if (decision.harnessId === "copilot") {
    const check = await checkCopilotToken(credential);

    if (blocksSave(check)) {
      return Response.json(
        { error: check, message: checkMessage(check) },
        { status: 422 }
      );
    }
  }

  await putCredential(decision.session, decision.harnessId, credential);

  // Deliberately no echo of what was stored. A write confirmation that
  // returned the credential would put it back on the wire for no reason.
  return Response.json({ harnessId: decision.harnessId, stored: true });
}

export async function DELETE(request: Request) {
  const session = await resolveSession();

  let body: { harnessId?: unknown };
  try {
    body = (await request.json()) as { harnessId?: unknown };
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // A delete needs the same subscription check as a write: both reach the
  // owner's database. `credential` is supplied only to satisfy the shared
  // decision, which has nothing to validate on a removal.
  const decision = decideCredentialWrite(session, {
    credential: "placeholder-not-stored",
    harnessId: body.harnessId,
  });
  if (decision.kind !== "allowed") {
    return respond(decision);
  }

  await deleteCredential(decision.session, decision.harnessId);

  return Response.json({ harnessId: decision.harnessId, removed: true });
}
