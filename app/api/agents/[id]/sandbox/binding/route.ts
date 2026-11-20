import { productionRunnerHttpHandlers } from "@/lib/runner/route-dependencies";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;
  return productionRunnerHttpHandlers().bindSandbox(request, id);
}
