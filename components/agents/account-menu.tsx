"use client";

import { LogIn, LogOut, Settings } from "lucide-react";
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
import { browserApplicationPath } from "@/lib/application-path";
import { sessionMenu } from "@/lib/auth/session-menu";
import { avatarFor } from "@/lib/avatar";

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
    signOut({
      callbackUrl: browserApplicationPath("/login"),
      redirect: true,
    });
  }, []);

  const email = session?.user?.email;
  const userId = session?.user?.id;
  const menu = sessionMenu({ email });

  // A signed-out visitor is offered sign IN rather than nothing, so the
  // control is in the same place whatever the session state.
  if (!menu.signedIn) {
    return (
      <Button
        asChild
        className="h-9 rounded-[8px] text-[13px]"
        variant="outline"
      >
        <Link href={menu.destination}>
          <LogIn className="size-4" />
          Sign in
        </Link>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label="Account"
          className="size-9 overflow-hidden rounded-full border-border p-0"
          variant="outline"
        >
          {/** biome-ignore lint/performance/noImgElement: a generated avatar is a data URI, which the image optimizer cannot process. */}
          <img
            alt=""
            className="size-full object-cover"
            src={avatarFor({
              id: userId ?? "",
              image: session?.user?.image,
            })}
          />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-56">
        <div className="px-2 py-1.5">
          <p className="truncate font-medium text-[13px]">{email}</p>
          <p className="text-[11px] text-muted-foreground">
            {session?.user?.type === "subscriber" ? "Subscriber" : "Guest"}
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
          {pending ? "Signing out…" : menu.label}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
