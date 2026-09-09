export const DAYTONA_MAX_SNAPSHOT_NAME_LENGTH = 64;

const VERSIONED_SNAPSHOT_NAME = /^coven-agents-copilot-\d+$/u;

export function isDaytonaVersionedSnapshotName(value: string): boolean {
  return (
    value.length <= DAYTONA_MAX_SNAPSHOT_NAME_LENGTH &&
    VERSIONED_SNAPSHOT_NAME.test(value)
  );
}
