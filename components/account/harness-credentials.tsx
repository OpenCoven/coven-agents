"use client";

import { HARNESS_SPECS } from "@opencoven/harness";
import { Check, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConnectCopilot } from "@/components/account/connect-copilot";
import { toast } from "@/components/chat/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Where a tenant supplies their own harness credential.
 *
 * `/api/credentials` shipped with no caller at all, so the only way to store a
 * credential was a hand-written fetch from devtools — the same "route with no
 * caller" gap that made the runner token so painful. A run refused for a
 * missing credential otherwise has no path to recovery from inside the app.
 *
 * The value is never read back. The endpoint returns configured ids only, so
 * this shows "Configured" rather than a masked secret: a status check has no
 * business putting the credential back on the wire.
 */
/**
 * Only harnesses a run can actually use.
 *
 * Derived from the registry rather than listed here, because offering a slot
 * for an unsupported harness stores a credential that looks like a working
 * setup and behaves like a missing one -- the worker refuses the run with
 * `harness_unsupported` long after the person thought they were done. Codex
 * and Claude Code are present in the registry but not yet supported, so they
 * are deliberately absent from this form.
 */
const GUIDANCE: Record<string, string> = {
  claude: "A Claude Code OAuth token.",
  codex: "An OpenAI API key.",
  copilot:
    "A fine-grained PAT with the Copilot Requests permission, or an OAuth token from the Copilot CLI. Classic ghp_ tokens are not supported.",
};

const HARNESSES = HARNESS_SPECS.filter((spec) => spec.supported).map(
  (spec) => ({
    help: GUIDANCE[spec.id] ?? "",
    id: spec.id as string,
    label: spec.label,
  })
);

export function HarnessCredentials() {
  const [configured, setConfigured] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/credentials");

    if (response.status === 403) {
      // A demo session cannot store one, and saying so beats a form that
      // fails on submit.
      setLocked(true);
      return;
    }

    if (!response.ok) {
      return;
    }

    const body = (await response.json()) as { harnessIds?: string[] };
    setConfigured(body.harnessIds ?? []);
  }, []);

  const reload = useCallback(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    reload();
  }, [reload]);

  const change = useCallback((harnessId: string, next: string) => {
    setValues((current) => ({ ...current, [harnessId]: next }));
  }, []);

  const save = useCallback(
    async (harnessId: string) => {
      const credential = values[harnessId]?.trim();

      if (!credential) {
        return;
      }

      setBusy(harnessId);

      try {
        const response = await fetch("/api/credentials", {
          body: JSON.stringify({ credential, harnessId }),
          headers: { "content-type": "application/json" },
          method: "POST",
        });

        if (response.status === 422) {
          // A rejected token is the person's to fix, so it is shown verbatim
          // rather than folded into a generic failure. The typed value is
          // deliberately kept so they can see and correct it.
          const body = (await response.json()) as { message?: string };

          toast({
            description: body.message ?? "That token was rejected.",
            type: "error",
          });
          return;
        }

        if (!response.ok) {
          throw new Error(String(response.status));
        }

        // Cleared immediately: there is no reason for the secret to sit in
        // component state after the write succeeded.
        setValues((current) => ({ ...current, [harnessId]: "" }));
        toast({ description: "Credential stored.", type: "success" });
        await refresh();
      } catch {
        toast({
          description: "Could not store the credential.",
          type: "error",
        });
      } finally {
        setBusy(null);
      }
    },
    [refresh, values]
  );

  const remove = useCallback(
    async (harnessId: string) => {
      setBusy(harnessId);

      try {
        const response = await fetch("/api/credentials", {
          body: JSON.stringify({ harnessId }),
          headers: { "content-type": "application/json" },
          method: "DELETE",
        });

        if (!response.ok) {
          throw new Error(String(response.status));
        }

        toast({ description: "Credential removed.", type: "success" });
        await refresh();
      } catch {
        toast({
          description: "Could not remove the credential.",
          type: "error",
        });
      } finally {
        setBusy(null);
      }
    },
    [refresh]
  );

  return (
    <div className="flex max-w-[720px] flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-semibold text-[15px]">Harness credentials</h2>
        <p className="text-[13px] text-muted-foreground">
          Agents run with your credential, encrypted and used only for the
          duration of a run. It is never shared with another account.
        </p>
      </div>

      {locked ? (
        <p className="text-[13px] text-muted-foreground">
          Storing a credential needs an active subscription.
        </p>
      ) : (
        HARNESSES.map((harness) => (
          <HarnessRow
            busy={busy === harness.id}
            configured={configured.includes(harness.id)}
            harness={harness}
            key={harness.id}
            onChange={change}
            onConnected={reload}
            onRemove={remove}
            onSave={save}
            value={values[harness.id] ?? ""}
          />
        ))
      )}
    </div>
  );
}

function HarnessRow({
  busy,
  configured,
  harness,
  onChange,
  onConnected,
  onRemove,
  onSave,
  value,
}: {
  busy: boolean;
  configured: boolean;
  onConnected: () => void;
  harness: { help: string; id: string; label: string };
  onChange: (harnessId: string, next: string) => void;
  onRemove: (harnessId: string) => void;
  onSave: (harnessId: string) => void;
  value: string;
}) {
  // Bound here rather than at the call site so the parent passes stable
  // references and every row does not re-render when one changes.
  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      onChange(harness.id, event.target.value);
    },
    [harness.id, onChange]
  );
  const handleSave = useCallback(() => {
    onSave(harness.id);
  }, [harness.id, onSave]);
  const handleRemove = useCallback(() => {
    onRemove(harness.id);
  }, [harness.id, onRemove]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label
          className="font-medium text-[12px] text-muted-foreground uppercase tracking-[0.08em]"
          htmlFor={`cred-${harness.id}`}
        >
          {harness.label}
        </Label>

        {configured ? (
          <span className="flex items-center gap-1 text-[11px] text-[var(--oc-accent)]">
            <Check className="size-3" />
            Configured
          </span>
        ) : null}
      </div>

      {harness.id === "copilot" ? (
        <>
          <ConnectCopilot configured={configured} onConnected={onConnected} />
          <div className="flex items-center gap-3 py-1">
            <span className="h-px flex-1 bg-border" />
            <span className="text-[11px] text-muted-foreground">
              or paste a token
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>
        </>
      ) : null}

      <div className="flex gap-2">
        <Input
          autoComplete="off"
          className="h-10 flex-1 rounded-[8px] border-border bg-secondary text-sm"
          disabled={busy}
          id={`cred-${harness.id}`}
          onChange={handleChange}
          placeholder={configured ? "Replace stored credential" : "Paste token"}
          type="password"
          value={value}
        />

        <Button
          className="h-10 rounded-[8px] text-[13px]"
          disabled={busy || !value.trim()}
          onClick={handleSave}
          type="button"
        >
          Save
        </Button>

        {configured ? (
          <Button
            aria-label={`Remove ${harness.label} credential`}
            className="h-10 rounded-[8px]"
            disabled={busy}
            onClick={handleRemove}
            type="button"
            variant="outline"
          >
            <Trash2 className="size-4" />
          </Button>
        ) : null}
      </div>

      <p className="text-[12px] text-muted-foreground">{harness.help}</p>
    </div>
  );
}
