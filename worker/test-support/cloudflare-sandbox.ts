let destroyed: string[] = [];
let lifecycle: string[] = [];
let destroyError: Error | null = null;

export function getSandbox(
  _binding: unknown,
  name: string
): {
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
  };
}

export function resetDestroyedSandboxes(): void {
  destroyed = [];
  lifecycle = [];
  destroyError = null;
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
