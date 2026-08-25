const RECORDING_SECRET_VARIABLES = [
  "DEMO_RECORDING_CREDENTIAL",
  "DEMO_RUNNER_IDENTITY_TOKEN",
  "DEMO_RUNNER_SIGNING_KEY",
  "DEMO_RUNNER_SUBJECT",
  "DEMO_RUNNER_TENANT",
  "DEMO_RUNNER_TOKEN",
] as const;

export function demoRecordingSecrets(
  environment: Readonly<Record<string, string | undefined>>
): string[] {
  return [
    ...new Set(
      RECORDING_SECRET_VARIABLES.map((name) => environment[name]).filter(
        (value): value is string => Boolean(value)
      )
    ),
  ];
}
