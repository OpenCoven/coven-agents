import { ipAddress } from "@vercel/functions";
import { productionGitHubConnectionHandlers } from "@/lib/github/route-dependencies";

export const maxDuration = 300;

export function GET(request: Request): Promise<Response> {
  return productionGitHubConnectionHandlers().callback(
    request,
    ipAddress(request) ?? null
  );
}
