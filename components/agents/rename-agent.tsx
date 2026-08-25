"use client";

import { Check, Pencil, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Renames an agent in place.
 *
 * Templates give an agent a generic name -- "Critic · Change crew" -- which is
 * right at creation and wrong the moment someone has three of them. Renaming
 * had no path at all: the worker has always accepted `PUT /api/agents/:id`,
 * but nothing in the client or the UI ever called it.
 *
 * The write sends the whole definition because that is what the endpoint
 * takes. Owner, `createdAt` and `lastRunAt` are carried forward by the worker
 * from stored state rather than from this body, so a rename cannot move an
 * agent between tenants or rewrite its history.
 */
export function RenameAgent({
  disabled,
  name,
  onRename,
}: {
  disabled: boolean;
  name: string;
  onRename: (next: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const start = useCallback(() => {
    setDraft(name);
    setEditing(true);
    // Focused on the next frame, after the input exists.
    setTimeout(() => input.current?.select(), 0);
  }, [name]);

  const cancel = useCallback(() => {
    setEditing(false);
  }, []);

  const commit = useCallback(async () => {
    const next = draft.trim();

    // An unchanged or empty name is not a rename. Writing either would spend
    // a round trip to store what is already there, or to store nothing.
    if (!next || next === name) {
      setEditing(false);
      return;
    }

    setSaving(true);

    try {
      await onRename(next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }, [draft, name, onRename]);

  const onChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    setDraft(event.target.value);
  }, []);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        commit();
      }

      if (event.key === "Escape") {
        cancel();
      }
    },
    [cancel, commit]
  );

  if (!editing) {
    return (
      <div className="group/name flex items-center gap-2">
        <h2 className="font-semibold text-2xl tracking-tight">{name}</h2>

        <Button
          aria-label="Rename agent"
          className="size-7 opacity-0 transition-opacity group-hover/name:opacity-100 focus-visible:opacity-100"
          disabled={disabled}
          onClick={start}
          size="icon"
          variant="ghost"
        >
          <Pencil className="size-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label="Agent name"
        className="h-9 w-[260px] rounded-[8px] font-semibold text-lg"
        disabled={saving}
        onChange={onChange}
        onKeyDown={onKeyDown}
        ref={input}
        value={draft}
      />

      <Button
        aria-label="Save name"
        className="size-8"
        disabled={saving}
        onClick={commit}
        size="icon"
        variant="ghost"
      >
        <Check className="size-4" />
      </Button>

      <Button
        aria-label="Cancel rename"
        className="size-8"
        disabled={saving}
        onClick={cancel}
        size="icon"
        variant="ghost"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
