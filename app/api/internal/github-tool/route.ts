import { productionGitHubToolHandler } from "@/lib/github/tool-route-dependencies";

export const maxDuration = 300;

export function POST(request: Request): Promise<Response> {
  return productionGitHubToolHandler()(request);
}
