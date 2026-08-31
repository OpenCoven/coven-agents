"use client";

import { useSession } from "next-auth/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "@/components/chat/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { browserApplicationPath } from "@/lib/application-path";
import { refreshAvatarSession } from "@/lib/avatar";

type AvatarState = { avatar: string; custom: boolean };

/**
 * Where someone sets their avatar.
 *
 * There is nothing to do here by default: an account with no stored image
 * already has one generated from its id. This exists for replacing that, so it
 * opens showing the current picture rather than an empty form implying
 * something is missing.
 */
export function AvatarSettings() {
  const [state, setState] = useState<AvatarState | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const { update } = useSession();

  const load = useCallback(async () => {
    const response = await fetch(browserApplicationPath("/api/account/avatar"));

    if (!response.ok) {
      return;
    }

    setState((await response.json()) as AvatarState);
  }, []);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  const submit = useCallback(
    async (image: string | null) => {
      setBusy(true);

      try {
        const response = await fetch(
          browserApplicationPath("/api/account/avatar"),
          {
            body: JSON.stringify({ image }),
            headers: { "content-type": "application/json" },
            method: "PUT",
          }
        );

        if (response.status === 401 || response.status === 403) {
          setLocked(true);
          setUrl("");
          return;
        }

        if (response.status === 422) {
          const body = (await response.json()) as { message?: string };

          toast({
            description: body.message ?? "That image URL was rejected.",
            type: "error",
          });
          return;
        }

        if (!response.ok) {
          throw new Error(String(response.status));
        }

        setState((await response.json()) as AvatarState);
        setUrl("");
        const refreshStatus = await refreshAvatarSession(image, update).catch(
          () => "deferred" as const
        );
        if (refreshStatus === "deferred") {
          toast({
            description:
              "Avatar saved, but the session could not refresh. It will update later.",
            type: "error",
          });
          return;
        }
        toast({
          description: image ? "Avatar updated." : "Back to the generated one.",
          type: "success",
        });
      } catch {
        toast({ description: "Could not save the avatar.", type: "error" });
      } finally {
        setBusy(false);
      }
    },
    [update]
  );

  const save = useCallback(() => {
    submit(url.trim()).catch(() => undefined);
  }, [submit, url]);
  const reset = useCallback(() => {
    submit(null).catch(() => undefined);
  }, [submit]);
  const change = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setUrl(event.target.value);
  }, []);

  return (
    <div className="flex max-w-[720px] flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold text-[15px]">Avatar</h2>
        <p className="text-[13px] text-muted-foreground">
          One is generated for you. Point at an https image to use your own.
        </p>
      </div>

      {locked ? (
        <p className="text-[13px] text-muted-foreground">
          Setting an avatar needs an active subscription.
        </p>
      ) : (
        <div className="flex items-center gap-4">
          {/** biome-ignore lint/performance/noImgElement: the generated default is a data URI, which the image optimizer cannot process. */}
          <img
            alt=""
            className="size-16 shrink-0 rounded-full border border-border bg-secondary"
            src={state?.avatar ?? ""}
          />

          <div className="flex flex-1 flex-col gap-2">
            <Label
              className="font-medium text-[12px] text-muted-foreground uppercase tracking-[0.08em]"
              htmlFor="avatar-url"
            >
              Image URL
            </Label>

            <div className="flex gap-2">
              <Input
                className="h-10 flex-1 rounded-[8px] border-border bg-secondary text-sm"
                disabled={busy}
                id="avatar-url"
                onChange={change}
                placeholder="https://example.com/me.png"
                value={url}
              />

              <Button
                className="h-10 rounded-[8px] text-[13px]"
                disabled={busy || !url.trim()}
                onClick={save}
                type="button"
              >
                Save
              </Button>

              {state?.custom ? (
                <Button
                  className="h-10 rounded-[8px] text-[13px]"
                  disabled={busy}
                  onClick={reset}
                  type="button"
                  variant="outline"
                >
                  Use generated
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
