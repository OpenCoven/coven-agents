export type GitHubAppRepositoryPermission = "none" | "read" | "write";

export type GitHubUserRepositoryPermission =
  | "read"
  | "triage"
  | "write"
  | "maintain"
  | "admin";

const USER_PERMISSION_RANK: Readonly<
  Record<GitHubUserRepositoryPermission, number>
> = Object.freeze({
  admin: 5,
  maintain: 4,
  read: 1,
  triage: 2,
  write: 3,
});

export function appPermissionAtLeast(
  permission: GitHubAppRepositoryPermission,
  required: "read" | "write"
): boolean {
  return (
    permission === "write" || (required === "read" && permission === "read")
  );
}

export function userPermissionAtLeast(
  permission: GitHubUserRepositoryPermission,
  required: "read" | "write"
): boolean {
  return (
    USER_PERMISSION_RANK[permission] >=
    USER_PERMISSION_RANK[required === "write" ? "write" : "read"]
  );
}

export function userPermissionAtMost(
  permission: GitHubUserRepositoryPermission,
  ceiling: GitHubUserRepositoryPermission
): boolean {
  return USER_PERMISSION_RANK[permission] <= USER_PERMISSION_RANK[ceiling];
}

export function clampUserPermission(
  ceiling: GitHubUserRepositoryPermission,
  observed: GitHubUserRepositoryPermission | "none"
): GitHubUserRepositoryPermission | null {
  if (observed === "none") {
    return null;
  }
  return USER_PERMISSION_RANK[ceiling] <= USER_PERMISSION_RANK[observed]
    ? ceiling
    : observed;
}

export function validAppRepositoryPermission(
  value: unknown
): value is GitHubAppRepositoryPermission {
  return value === "none" || value === "read" || value === "write";
}

export function validUserRepositoryPermission(
  value: unknown
): value is GitHubUserRepositoryPermission {
  return (
    value === "read" ||
    value === "triage" ||
    value === "write" ||
    value === "maintain" ||
    value === "admin"
  );
}
