import { redirect } from "next/navigation";
import { DemoRoot } from "@/components/demo/demo-root";
import { loadDemoTranscript } from "@/lib/demo/load";
import { resolveDemoView, resolveRootRoute } from "@/lib/demo/root";

export default function Page() {
  const route = resolveRootRoute(process.env.IS_DEMO);
  if (route.kind === "redirect") {
    redirect(route.location);
  }

  const transcript = loadDemoTranscript({
    selectedName: process.env.DEMO_TRANSCRIPT,
  });

  return <DemoRoot view={resolveDemoView(transcript)} />;
}
