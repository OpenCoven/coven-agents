import { ipAddress } from "@vercel/functions";
import { productionGitHubConnectionHandlers } from "@/lib/github/route-dependencies";

export function GET(request: Request): Promise<Response> {
  return productionGitHubConnectionHandlers().getConnection(
    request,
    ipAddress(request) ?? null
  );
}

export function DELETE(request: Request): Promise<Response> {
  return productionGitHubConnectionHandlers().disconnect(
    request,
    ipAddress(request) ?? null
  );
}
