import { realpath as fsRealpath } from "node:fs/promises";
import path from "node:path";

export type RealpathResolver = (filePath: string) => Promise<string>;

export function isInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

export function requireConfiguredPath(
  label: "BEADS_WORKSPACE" | "repositoryRoot",
  value: string | undefined
): string {
  const configuredPath = value?.trim();

  if (!configuredPath) {
    throw new Error(`${label} must be configured`);
  }

  return configuredPath;
}

export async function validatePrivateBeadsWorkspace(
  workspacePath: string | undefined,
  repositoryRoot: string | undefined,
  realpath: RealpathResolver = (filePath) => fsRealpath(filePath)
): Promise<string> {
  const configuredWorkspace = requireConfiguredPath(
    "BEADS_WORKSPACE",
    workspacePath
  );
  const configuredRepositoryRoot = requireConfiguredPath(
    "repositoryRoot",
    repositoryRoot
  );
  const resolvedWorkspace = path.resolve(configuredWorkspace);
  const resolvedRepositoryRoot = path.resolve(configuredRepositoryRoot);

  if (isInsideRoot(resolvedWorkspace, resolvedRepositoryRoot)) {
    throw new Error("BEADS_WORKSPACE must be outside the repository root");
  }

  let realRepositoryRoot = "";

  try {
    realRepositoryRoot = await realpath(resolvedRepositoryRoot);
  } catch (error) {
    throw new Error("repositoryRoot must reference an existing directory", {
      cause: error,
    });
  }

  let realWorkspace = "";

  try {
    realWorkspace = await realpath(resolvedWorkspace);
  } catch (error) {
    throw new Error(
      "BEADS_WORKSPACE must reference an existing directory outside the repository root",
      {
        cause: error,
      }
    );
  }

  if (isInsideRoot(realWorkspace, realRepositoryRoot)) {
    throw new Error("BEADS_WORKSPACE must be outside the repository root");
  }

  return realWorkspace;
}
