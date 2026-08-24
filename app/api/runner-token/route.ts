import { auth } from "@/app/(auth)/auth";
import { claimsForUser, mintRunnerToken } from "@/lib/agents/runner-token";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const privateKey = process.env.RUNNER_SIGNING_KEY;
  if (!privateKey) {
    return Response.json({ error: "signing_unavailable" }, { status: 503 });
  }

  const token = await mintRunnerToken(
    claimsForUser({ id: session.user.id, type: session.user.type }),
    privateKey
  );

  return Response.json({ token });
}
