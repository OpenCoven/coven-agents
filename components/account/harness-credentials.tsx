"use client";

import { HARNESS_SPECS } from "@opencoven/harness";
import { Check, Trash2 } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { ConnectCopilot } from "@/components/account/connect-copilot";
import { toast } from "@/components/chat/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { browserApplicationPath } from "@/lib/application-path";
import { sessionFetch as fetch } from "@/lib/auth/session-recovery";

/**
 * Where a tenant supplies their own harness credential.
 *
 * `/api/credentials` shipped with no caller at all, so the only way to store a
 * credential was a hand-written fetch from devtools — the same "route with no
 * caller" gap that previously broke account-scoped execution. A run refused
 * for a missing credential otherwise has no path to recovery inside the app.
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
 * setup and behaves like a missing one -- the runner refuses the run with
 * `harness_unsupported` long after the person thought they were done. The
 * supported registry now includes Copilot, Codex and Claude Code.
 */
const GUIDANCE: Record<string, string> = {
  claude: "A Claude Code OAuth token.",
  codex:
    "Your Codex CLI ChatGPT auth.json contents. API-key sign-ins are not accepted.",
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
const CREDENTIAL_ENDPOINT = browserApplicationPath("/api/credentials");

type CredentialOperation = Readonly<{
  authorityContext: string;
  controller: AbortController;
  generation: number;
}>;

type CredentialLock = Readonly<{
  authorityContext: string;
  reason: "session" | "subscription";
}>;

export function HarnessCredentials({
  authorityContextRevision,
  authorityRevision,
  isSubscriber,
  onAuthorityInvalidated,
}: {
  authorityContextRevision: string;
  authorityRevision: string | null;
  isSubscriber: boolean;
  onAuthorityInvalidated: () => void;
}) {
  const [configured, setConfigured] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [stateAuthorityContext, setStateAuthorityContext] = useState<
    string | null
  >(null);
  const [credentialLock, setCredentialLock] = useState<CredentialLock | null>(
    null
  );
  const authorityContext = `${authorityContextRevision}:${isSubscriber ? "subscriber" : "demo"}`;
  const authorityContextRef = useRef(authorityContext);
  authorityContextRef.current = authorityContext;
  const authorityInvalidatedRef = useRef(onAuthorityInvalidated);
  authorityInvalidatedRef.current = onAuthorityInvalidated;
  const isSubscriberRef = useRef(isSubscriber);
  isSubscriberRef.current = isSubscriber;
  const activeControllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const scheduledLoadRef = useRef(0);
  const stateIsCurrent = stateAuthorityContext === authorityContext;
  const visibleConfigured = stateIsCurrent ? configured : [];
  const visibleValues = stateIsCurrent ? values : {};
  const visibleBusy = stateIsCurrent ? busy : null;
  const currentLock =
    stateIsCurrent && credentialLock?.authorityContext === authorityContext
      ? credentialLock
      : null;
  const locked = !isSubscriber || currentLock !== null;

  const abortActiveOperation = useCallback(() => {
    generationRef.current += 1;
    activeControllerRef.current?.abort();
    activeControllerRef.current = null;
  }, []);

  const beginOperation = useCallback((): CredentialOperation | null => {
    const requestAuthorityContext = authorityContextRef.current;
    if (!isSubscriberRef.current) {
      return null;
    }
    abortActiveOperation();
    const controller = new AbortController();
    activeControllerRef.current = controller;
    return {
      authorityContext: requestAuthorityContext,
      controller,
      generation: generationRef.current,
    };
  }, [abortActiveOperation]);

  const operationIsCurrent = useCallback(
    (operation: CredentialOperation): boolean =>
      mountedRef.current &&
      !operation.controller.signal.aborted &&
      activeControllerRef.current === operation.controller &&
      generationRef.current === operation.generation &&
      authorityContextRef.current === operation.authorityContext &&
      isSubscriberRef.current,
    []
  );

  const finishOperation = useCallback((operation: CredentialOperation) => {
    if (activeControllerRef.current === operation.controller) {
      activeControllerRef.current = null;
    }
  }, []);

  const refresh = useCallback(async () => {
    const operation = beginOperation();
    if (!operation) {
      return;
    }
    setBusy(null);
    let response: Response;
    try {
      response = await fetch(CREDENTIAL_ENDPOINT, {
        signal: operation.controller.signal,
      });
    } catch {
      if (operationIsCurrent(operation)) {
        finishOperation(operation);
      }
      return;
    }
    if (!operationIsCurrent(operation)) {
      return;
    }

    if (response.status === 401 || response.status === 403) {
      setCredentialLock({
        authorityContext: operation.authorityContext,
        reason: response.status === 401 ? "session" : "subscription",
      });
      setConfigured([]);
      setValues({});
      finishOperation(operation);
      authorityInvalidatedRef.current();
      return;
    }

    if (!response.ok) {
      finishOperation(operation);
      return;
    }

    const body = (await response.json()) as { harnessIds?: string[] };
    if (!operationIsCurrent(operation)) {
      return;
    }
    setConfigured(body.harnessIds ?? []);
    finishOperation(operation);
  }, [beginOperation, finishOperation, operationIsCurrent]);

  const reload = useCallback(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scheduledLoadRef.current += 1;
      abortActiveOperation();
    };
  }, [abortActiveOperation]);

  useLayoutEffect(() => {
    abortActiveOperation();
    setStateAuthorityContext(authorityContext);
    setConfigured([]);
    setValues({});
    setBusy(null);
    setCredentialLock(null);
    scheduledLoadRef.current += 1;
    const scheduledLoad = scheduledLoadRef.current;
    if (!isSubscriber) {
      return;
    }
    queueMicrotask(() => {
      if (
        mountedRef.current &&
        scheduledLoadRef.current === scheduledLoad &&
        authorityContextRef.current === authorityContext &&
        isSubscriberRef.current
      ) {
        reload();
      }
    });
  }, [abortActiveOperation, authorityContext, isSubscriber, reload]);

  const change = useCallback((harnessId: string, next: string) => {
    setValues((current) => ({ ...current, [harnessId]: next }));
  }, []);

  const save = useCallback(
    async (harnessId: string): Promise<boolean> => {
      const credential = values[harnessId]?.trim();

      if (!credential) {
        return false;
      }

      setBusy(harnessId);
      const operation = beginOperation();
      if (!operation) {
        setBusy(null);
        return false;
      }

      try {
        const response = await fetch(CREDENTIAL_ENDPOINT, {
          body: JSON.stringify({ credential, harnessId }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: operation.controller.signal,
        });
        if (!operationIsCurrent(operation)) {
          return false;
        }

        if (response.status === 422) {
          // A rejected token is the person's to fix, so it is shown verbatim
          // rather than folded into a generic failure. The typed value is
          // deliberately kept so they can see and correct it.
          const body = (await response.json()) as { message?: string };
          if (!operationIsCurrent(operation)) {
            return false;
          }

          toast({
            description: body.message ?? "That token was rejected.",
            type: "error",
          });
          return false;
        }

        if (response.status === 401 || response.status === 403) {
          setCredentialLock({
            authorityContext: operation.authorityContext,
            reason: response.status === 401 ? "session" : "subscription",
          });
          setConfigured([]);
          setValues({});
          authorityInvalidatedRef.current();
          toast({
            description:
              response.status === 401
                ? "Sign in again."
                : "Storing a credential needs an active subscription.",
            type: "error",
          });
          return false;
        }

        if (!response.ok) {
          throw new Error(String(response.status));
        }

        // Cleared immediately: there is no reason for the secret to sit in
        // component state after the write succeeded.
        setValues((current) => ({ ...current, [harnessId]: "" }));
        toast({ description: "Credential stored.", type: "success" });
        finishOperation(operation);
        await refresh();
        return true;
      } catch {
        if (operationIsCurrent(operation)) {
          toast({
            description: "Could not store the credential.",
            type: "error",
          });
        }
        return false;
      } finally {
        if (operationIsCurrent(operation)) {
          setBusy(null);
          finishOperation(operation);
        }
      }
    },
    [beginOperation, finishOperation, operationIsCurrent, refresh, values]
  );

  const remove = useCallback(
    async (harnessId: string) => {
      setBusy(harnessId);
      const operation = beginOperation();
      if (!operation) {
        setBusy(null);
        return;
      }

      try {
        const response = await fetch(CREDENTIAL_ENDPOINT, {
          body: JSON.stringify({ harnessId }),
          headers: { "content-type": "application/json" },
          method: "DELETE",
          signal: operation.controller.signal,
        });
        if (!operationIsCurrent(operation)) {
          return;
        }

        if (response.status === 401 || response.status === 403) {
          setCredentialLock({
            authorityContext: operation.authorityContext,
            reason: response.status === 401 ? "session" : "subscription",
          });
          setConfigured([]);
          setValues({});
          authorityInvalidatedRef.current();
          toast({
            description:
              response.status === 401
                ? "Sign in again."
                : "Storing a credential needs an active subscription.",
            type: "error",
          });
          return;
        }

        if (!response.ok) {
          throw new Error(String(response.status));
        }

        toast({ description: "Credential removed.", type: "success" });
        finishOperation(operation);
        await refresh();
      } catch {
        if (operationIsCurrent(operation)) {
          toast({
            description: "Could not remove the credential.",
            type: "error",
          });
        }
      } finally {
        if (operationIsCurrent(operation)) {
          setBusy(null);
          finishOperation(operation);
        }
      }
    },
    [beginOperation, finishOperation, operationIsCurrent, refresh]
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
          {currentLock?.reason === "session"
            ? "Sign in again to manage harness credentials."
            : "Storing a credential needs an active subscription."}
        </p>
      ) : (
        HARNESSES.map((harness) => (
          <HarnessRow
            authorityContextRevision={authorityContextRevision}
            authorityRevision={authorityRevision}
            busy={visibleBusy === harness.id}
            configured={visibleConfigured.includes(harness.id)}
            harness={harness}
            isSubscriber={isSubscriber}
            key={harness.id}
            onAuthorityInvalidated={onAuthorityInvalidated}
            onChange={change}
            onConnected={reload}
            onRemove={remove}
            onSave={save}
            value={visibleValues[harness.id] ?? ""}
          />
        ))
      )}
    </div>
  );
}

function HarnessRow({
  authorityContextRevision,
  authorityRevision,
  busy,
  configured,
  harness,
  isSubscriber,
  onChange,
  onAuthorityInvalidated,
  onConnected,
  onRemove,
  onSave,
  value,
}: {
  authorityContextRevision: string;
  authorityRevision: string | null;
  busy: boolean;
  configured: boolean;
  isSubscriber: boolean;
  onAuthorityInvalidated: () => void;
  onConnected: () => void;
  harness: { help: string; id: string; label: string };
  onChange: (harnessId: string, next: string) => void;
  onRemove: (harnessId: string) => void;
  onSave: (harnessId: string) => Promise<boolean>;
  value: string;
}) {
  /**
   * A connected harness shows one affordance, not four.
   *
   * Connected, this row used to offer a "Reconnect" button, a "replace stored
   * credential" field, a Save, and a Remove all at once -- four routes to the
   * same single stored value, with nothing to say which one was meant. The
   * credential is already working, so the common case is doing nothing; the
   * ways to change it are worth one click.
   */
  const rowAuthorityContext = `${authorityContextRevision}:${authorityRevision ?? ""}:${isSubscriber ? "subscriber" : "demo"}`;
  const [replacingFor, setReplacingFor] = useState<string | null>(null);
  const replacing = replacingFor === rowAuthorityContext;
  const showEditor = !configured || replacing;

  // Bound here rather than at the call site so the parent passes stable
  // references and every row does not re-render when one changes.
  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      onChange(harness.id, event.target.value);
    },
    [harness.id, onChange]
  );
  const handleSave = useCallback(() => {
    // Closed only on success. A rejected token keeps the editor open with the
    // typed value intact, which is the only state from which it can be fixed.
    onSave(harness.id)
      .then((stored) => {
        if (stored) {
          setReplacingFor(null);
        }
      })
      .catch(() => undefined);
  }, [harness.id, onSave]);
  const handleRemove = useCallback(() => {
    onRemove(harness.id);
  }, [harness.id, onRemove]);
  const handleConnected = useCallback(() => {
    // Device flow succeeded, so the editor has done its job and closes with
    // the same gesture a successful paste uses.
    setReplacingFor(null);
    onConnected();
  }, [onConnected]);
  const stopReplacing = useCallback(() => {
    setReplacingFor(null);
    onChange(harness.id, "");
  }, [harness.id, onChange]);
  const startReplacing = useCallback(() => {
    setReplacingFor(rowAuthorityContext);
  }, [rowAuthorityContext]);

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
            Stored
          </span>
        ) : null}
      </div>

      {configured && !replacing ? (
        <div className="flex items-center justify-between gap-3 rounded-[8px] border border-border bg-secondary/40 px-4 py-3">
          <p className="text-[13px] text-muted-foreground">
            Runs are handed this credential. It is stored, not verified.
          </p>
          <div className="flex gap-2">
            <Button
              className="h-9 rounded-[8px] text-[13px]"
              disabled={busy}
              onClick={startReplacing}
              type="button"
              variant="outline"
            >
              Replace
            </Button>
            <Button
              aria-label={`Remove ${harness.label} credential`}
              className="h-9 rounded-[8px]"
              disabled={busy}
              onClick={handleRemove}
              type="button"
              variant="outline"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}

      {showEditor && harness.id === "copilot" ? (
        <>
          <ConnectCopilot
            authorityContextRevision={authorityContextRevision}
            authorityRevision={authorityRevision}
            configured={configured}
            isSubscriber={isSubscriber}
            onAuthorityInvalidated={onAuthorityInvalidated}
            onConnected={handleConnected}
          />
          <div className="flex items-center gap-3 py-1">
            <span className="h-px flex-1 bg-border" />
            <span className="text-[11px] text-muted-foreground">
              or paste a token
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>
        </>
      ) : null}

      {showEditor ? (
        <div className="flex gap-2">
          <Input
            autoComplete="off"
            className="h-10 flex-1 rounded-[8px] border-border bg-secondary text-sm"
            disabled={busy}
            id={`cred-${harness.id}`}
            onChange={handleChange}
            placeholder={
              configured
                ? "Replace stored credential"
                : harness.id === "codex"
                  ? "Paste auth.json"
                  : "Paste token"
            }
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

          {replacing ? (
            <Button
              className="h-10 rounded-[8px] text-[13px]"
              disabled={busy}
              onClick={stopReplacing}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}

      {showEditor ? (
        <p className="text-[12px] text-muted-foreground">{harness.help}</p>
      ) : null}
    </div>
  );
}
