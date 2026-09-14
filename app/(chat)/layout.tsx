import { cookies } from "next/headers";
import Link from "next/link";
import Script from "next/script";
import { SessionProvider } from "next-auth/react";
import { Suspense } from "react";
import { Toaster } from "sonner";
import { SessionRecovery } from "@/components/auth/session-recovery";
import { BrandMark } from "@/components/brand/brand-mark";
import { AppSidebar } from "@/components/chat/app-sidebar";
import { DataStreamProvider } from "@/components/chat/data-stream-provider";
import { ChatMotionProvider } from "@/components/chat/motion-provider";
import { ChatShell } from "@/components/chat/shell";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { ActiveChatProvider } from "@/hooks/use-active-chat";
import { browserApplicationPath } from "@/lib/application-path";
import { pageAuth } from "../(auth)/auth";

type ChatLayoutProps = {
  children: React.ReactNode;
  params: Promise<{ id?: string }>;
};

export default function Layout({ children, params }: ChatLayoutProps) {
  return (
    <SessionProvider
      basePath={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/auth`}
    >
      <SessionRecovery />
      <Script
        src="https://cdn.jsdelivr.net/pyodide/v0.23.4/full/pyodide.js"
        strategy="lazyOnload"
      />
      <DataStreamProvider>
        <Suspense fallback={<div className="flex h-dvh bg-sidebar" />}>
          <SidebarShell params={params}>{children}</SidebarShell>
        </Suspense>
      </DataStreamProvider>
    </SessionProvider>
  );
}

async function SidebarShell({ children, params }: ChatLayoutProps) {
  const { id } = await params;
  const [session, cookieStore] = await Promise.all([
    pageAuth(browserApplicationPath(id ? `/chat/${id}` : "/agents")),
    cookies(),
  ]);
  const isCollapsed = cookieStore.get("sidebar_state")?.value !== "true";

  if (session?.user?.type !== "subscriber") {
    const signedIn = Boolean(session?.user);
    return (
      <main className="flex h-dvh w-full items-center justify-center bg-background px-5 py-10 text-center">
        <div className="max-w-[440px]">
          <BrandMark className="mx-auto mb-5 size-10 text-[var(--oc-accent)]" />
          <p className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
            {signedIn ? "Subscription required" : "Account required"}
          </p>
          <h1 className="mt-3 font-semibold text-2xl tracking-tight">
            {signedIn ? "Subscribe to use chat" : "Sign in to use chat"}
          </h1>
          <p className="mt-2 text-[13px] text-muted-foreground leading-relaxed">
            Chat history, models, and uploads are available to active
            subscribers.
          </p>
          <Link
            className="mt-5 inline-flex h-10 items-center rounded-[8px] bg-[var(--oc-accent)] px-4 font-medium text-[13px] text-[var(--oc-accent-ink)] transition-opacity hover:opacity-90"
            href={signedIn ? "/account" : "/login"}
          >
            {signedIn ? "Open account settings" : "Sign in with GitHub"}
          </Link>
        </div>
      </main>
    );
  }

  return (
    <ChatMotionProvider>
      <SidebarProvider defaultOpen={!isCollapsed}>
        <AppSidebar user={session?.user} />
        <SidebarInset>
          <Toaster
            position="top-center"
            theme="system"
            toastOptions={{
              className:
                "!bg-card !text-foreground !border-border/50 !shadow-[var(--shadow-float)]",
            }}
          />
          <Suspense fallback={<div className="flex h-dvh" />}>
            <ActiveChatProvider>
              <ChatShell />
            </ActiveChatProvider>
          </Suspense>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </ChatMotionProvider>
  );
}
