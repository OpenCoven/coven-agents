export type SessionOperationContext = Readonly<{
  generation: number;
  isCurrent: () => boolean;
  signal: AbortSignal;
}>;

export function isSessionOperationCurrent(
  expected: SessionOperationContext | null,
  current: SessionOperationContext | null
): expected is SessionOperationContext {
  return (
    expected !== null &&
    current !== null &&
    expected.generation === current.generation &&
    expected.signal === current.signal &&
    !expected.signal.aborted &&
    expected.isCurrent()
  );
}
