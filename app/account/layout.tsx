import { SessionProvider } from "next-auth/react";
import { Toaster } from "sonner";
import { SessionRecovery } from "@/components/auth/session-recovery";

/**
 * Account settings sit outside the `(chat)` group deliberately.
 *
 * That group's layout renders `<ChatShell />` unconditionally and then
 * `{children}` beneath it, so a page placed there gets the entire chat
 * interface -- sidebar, suggestion chips, composer -- stacked above its own
 * content, and inherits whatever that shell fetches.
 *
 * `SessionProvider` is mounted here rather than at the root because the demo
 * route must render with no session context at all.
 */
export default function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionProvider
      basePath={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/auth`}
    >
      <SessionRecovery />
      <Toaster
        position="top-center"
        theme="system"
        toastOptions={{
          className:
            "!bg-card !text-foreground !border-border/50 !shadow-[var(--shadow-float)]",
        }}
      />
      {children}
    </SessionProvider>
  );
}
