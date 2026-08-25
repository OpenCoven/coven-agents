"use client";

import { LogOut, Settings, User } from "lucide-react";
import Link from "next/link";
import { signOut, useSession } from "next-auth/react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The signed-in account control.
 *
 * Sign-out had no entry point at all, and neither did `/account` — the
 * password-change page shipped reachable only by typing the URL. Both live
 * here.
 *
 * Renders nothing when there is no session, so a demo visitor is not offered
 * a sign-out that would do nothing.
 */
export function AccountMenu() {
  const { data: session } = useSession();
  const [pending, setPending] = useState(false);

  const leave = useCallback(() => {
    setPending(true);
    signOut({ callbackUrl: "/login" });
  }, []);

  const email = session?.user?.email;

  if (!email) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Account"
          className="size-9 rounded-full border-border p-0"
          variant="outline"
        >
          <User className="size-4" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <div className="px-2 py-1.5">
          <p className="truncate font-medium text-[13px]">{email}</p>
          <p className="text-[11px] text-muted-foreground capitalize">
            {session?.user?.type ?? "demo"}
          </p>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link href="/account">
            <Settings className="size-4" />
            Account settings
          </Link>
        </DropdownMenuItem>

        <DropdownMenuItem disabled={pending} onSelect={leave}>
          <LogOut className="size-4" />
          {pending ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
