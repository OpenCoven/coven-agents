import { ipAddress } from "@vercel/functions";
import { productionGitHubConnectionHandlers } from "@/lib/github/route-dependencies";

export function GET(request: Request): Promise<Response> {
  return productionGitHubConnectionHandlers().install(
    request,
    ipAddress(request) ?? null
  );
}
