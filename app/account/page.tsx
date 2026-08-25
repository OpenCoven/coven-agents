"use client";

import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { useActionState, useEffect } from "react";
import {
  type ChangePasswordActionState,
  changePassword,
} from "@/app/(auth)/actions";
import { DeleteAllChats } from "@/components/account/delete-all-chats";
import { AccountMenu } from "@/components/agents/account-menu";
import { toast } from "@/components/chat/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const MESSAGES: Record<
  string,
  { description: string; type: "error" | "success" }
> = {
  failed: { description: "Could not update your password.", type: "error" },
  mismatch: {
    description: "The two new passwords do not match.",
    type: "error",
  },
  success: { description: "Password updated.", type: "success" },
  too_short: {
    description: "Use at least 6 characters.",
    type: "error",
  },
  unauthorized: { description: "Sign in first.", type: "error" },
  unchanged: {
    description: "That is already your password. Choose a different one.",
    type: "error",
  },
  wrong_password: {
    description: "Current password is incorrect.",
    type: "error",
  },
};

export default function Page() {
  const [state, formAction] = useActionState<
    ChangePasswordActionState,
    FormData
  >(changePassword, { status: "idle" });

  useEffect(() => {
    const message = MESSAGES[state.status];

    if (message) {
      toast(message);
    }
  }, [state.status]);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col justify-center gap-6 px-6 py-12">
      <div className="flex items-center justify-between">
        <Link
          className="flex w-fit items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          href="/agents"
        >
          <ArrowLeftIcon className="size-3.5" />
          Back
        </Link>

        {/* Sign-out was reachable from the console and the chat but not from
            the settings page itself, which is where a person goes looking. */}
        <AccountMenu />
      </div>
      <div className="flex flex-col gap-6 rounded-[var(--radius)] border border-border bg-card p-8">
        <div className="flex flex-col gap-1">
          <h1 className="font-semibold text-2xl tracking-tight">Account</h1>
          <p className="text-muted-foreground text-sm">
            Change your password. If you signed in with a temporary one, replace
            it here.
          </p>
        </div>

        <form action={formAction} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="currentPassword">Current password</Label>
            <Input
              autoComplete="current-password"
              id="currentPassword"
              name="currentPassword"
              required
              type="password"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="newPassword">New password</Label>
            <Input
              autoComplete="new-password"
              id="newPassword"
              minLength={6}
              name="newPassword"
              required
              type="password"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmPassword">Confirm new password</Label>
            <Input
              autoComplete="new-password"
              id="confirmPassword"
              minLength={6}
              name="confirmPassword"
              required
              type="password"
            />
          </div>

          <Button
            className="h-10 w-full rounded-[8px] font-semibold text-[13px]"
            type="submit"
          >
            Update password
          </Button>
        </form>
      </div>

      <DeleteAllChats />
    </div>
  );
}
