let destroyed: string[] = [];
let lifecycle: string[] = [];

export function getSandbox(
  _binding: unknown,
  name: string
): {
  destroy: () => Promise<void>;
} {
  return {
    async destroy() {
      destroyed.push(name);
      lifecycle.push(`destroy:${name}`);
    },
  };
}

export function resetDestroyedSandboxes(): void {
  destroyed = [];
  lifecycle = [];
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
