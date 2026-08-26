let destroyed: string[] = [];
let lifecycle: string[] = [];
let destroyError: Error | null = null;
let execImplementation:
  | ((command: string, options?: Record<string, unknown>) => Promise<unknown>)
  | null = null;

export function getSandbox(
  _binding: unknown,
  name: string
): {
  exec: (
    command: string,
    options?: Record<string, unknown>
  ) => Promise<unknown>;
  destroy: () => Promise<void>;
} {
  return {
    destroy() {
      destroyed.push(name);
      lifecycle.push(`destroy:${name}`);
      if (destroyError) {
        return Promise.reject(destroyError);
      }
      return Promise.resolve();
    },
    exec(command, options) {
      if (!execImplementation) {
        return Promise.reject(new Error("sandbox exec is not configured"));
      }
      return execImplementation(command, options);
    },
  };
}

export function resetDestroyedSandboxes(): void {
  destroyed = [];
  lifecycle = [];
  destroyError = null;
  execImplementation = null;
}

export function setSandboxDestroyError(error: Error | null): void {
  destroyError = error;
}

export function destroyedSandboxes(): string[] {
  return [...destroyed];
}

export function recordSandboxLifecycle(value: string): void {
  lifecycle.push(value);
}

export function sandboxLifecycle(): string[] {
  return [...lifecycle];
}

export function setSandboxExec(
  implementation: (
    command: string,
    options?: Record<string, unknown>
  ) => Promise<unknown>
): void {
  execImplementation = implementation;
}
