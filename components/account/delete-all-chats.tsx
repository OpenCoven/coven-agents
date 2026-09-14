"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { useSWRConfig } from "swr";
import { unstable_serialize } from "swr/infinite";
import { getChatHistoryPaginationKey } from "@/components/chat/sidebar-history";
import { toast } from "@/components/chat/toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { sessionFetch as fetch } from "@/lib/auth/session-recovery";

/**
 * Deletes every chat this account owns.
 *
 * It used to sit permanently in the chat sidebar, one click from "New chat",
 * which put an irreversible account-wide action next to the most-used control
 * on the screen. Account settings is where it belongs.
 *
 * The request is awaited rather than fired and forgotten — the sidebar version
 * navigated away immediately and never learned whether the delete succeeded,
 * so a failure looked identical to a success until the history reappeared.
 */
export function DeleteAllChats() {
  const router = useRouter();
  const { mutate } = useSWRConfig();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  const show = useCallback(() => {
    setOpen(true);
  }, []);

  const remove = useCallback(async () => {
    setPending(true);

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/history`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        throw new Error(String(response.status));
      }

      await mutate(unstable_serialize(getChatHistoryPaginationKey), [], {
        revalidate: false,
      });

      toast({ description: "All chats deleted.", type: "success" });
      setOpen(false);
      router.refresh();
    } catch {
      toast({ description: "Could not delete your chats.", type: "error" });
    } finally {
      setPending(false);
    }
  }, [mutate, router]);

  return (
    <>
      <div className="flex max-w-[720px] flex-col gap-4 rounded-[var(--radius)] border border-destructive/30 p-6">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold text-[15px]">Delete all chats</h2>
          <p className="text-[13px] text-muted-foreground">
            Permanently removes every chat on this account. Agents and stored
            credentials are not affected.
          </p>
        </div>

        <Button
          className="h-10 w-full rounded-[8px] font-semibold text-[13px]"
          onClick={show}
          type="button"
          variant="destructive"
        >
          Delete all chats
        </Button>
      </div>

      <AlertDialog onOpenChange={setOpen} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all chats?</AlertDialogTitle>
            <AlertDialogDescription>
              This cannot be undone. Every chat on this account is permanently
              removed. Your agents and stored credentials are left alone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={remove}>
              {pending ? "Deleting…" : "Delete all"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
