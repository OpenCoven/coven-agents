const RECORDING_SECRET_VARIABLES = [
  "AUTH_SECRET",
  "DEMO_RECORDER_ACCOUNT_EMAIL",
  "DEMO_RECORDING_CREDENTIAL",
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
