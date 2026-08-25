import type { DemoTranscript } from "@opencoven/agent-contracts";

export function resolveRootRoute(isDemo: string | undefined) {
  if (isDemo === "1") {
    return { kind: "demo" } as const;
  }

  return { kind: "redirect", location: "/agents" } as const;
}

export function resolveDemoView(transcript: DemoTranscript | null) {
  if (transcript) {
    return { kind: "replay", transcript } as const;
  }

  return {
    description:
      "No recorded run is available to replay. No live run was started.",
    kind: "unavailable",
    title: "Demo unavailable",
  } as const;
}
