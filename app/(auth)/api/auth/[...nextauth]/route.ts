import { GET as authGET, POST as authPOST } from "@/app/(auth)/auth";
import { withAuthAbusePolicy } from "@/lib/auth/abuse";

export const GET = withAuthAbusePolicy(authGET);
export const POST = withAuthAbusePolicy(authPOST);
