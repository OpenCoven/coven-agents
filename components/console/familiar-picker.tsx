"use client";

import type { FamiliarId } from "@opencoven/agent-contracts";
import { type ChangeEvent, useCallback } from "react";
import { FamiliarPortrait } from "@/components/console/familiar-portrait";
import { FAMILIARS } from "@/lib/console/familiars";

const FAMILIAR_IDS = [
  "auto",
  "scout",
  "builder",
  "critic",
  "tester",
  "scribe",
  "custom",
] as const satisfies readonly FamiliarId[];

export function FamiliarPicker({
  automaticProfileId,
  disabled = false,
  onChange,
  value,
}: {
  automaticProfileId: string;
  disabled?: boolean;
  onChange: (familiarId: FamiliarId) => void;
  value: FamiliarId;
}) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange(event.currentTarget.value as FamiliarId);
    },
    [onChange]
  );

  return (
    <div
      aria-label="Choose familiar"
      role="radiogroup"
      style={{
        display: "grid",
        gap: 8,
        gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))",
      }}
    >
      {FAMILIAR_IDS.map((familiarId) => {
        const automatic = familiarId === "auto";
        const definition = automatic
          ? {
              name: "Match profile",
              species: "Uses the profile's role",
            }
          : FAMILIARS[familiarId];
        const selected = familiarId === value;

        return (
          <label
            className="oc-familiar-picker__option oc-row"
            key={familiarId}
            style={{
              alignItems: "center",
              background: selected
                ? "color-mix(in oklch, var(--accent-presence) 15%, var(--bg-raised))"
                : "var(--bg-sunken)",
              border: selected
                ? "1px solid var(--accent-presence)"
                : "1px solid var(--border-hairline)",
              borderRadius: "var(--radius-control)",
              color: "var(--text-primary)",
              cursor: disabled ? "not-allowed" : "pointer",
              display: "flex",
              gap: 9,
              minHeight: 56,
              opacity: disabled ? 0.55 : 1,
              padding: "8px 10px",
              position: "relative",
              textAlign: "left",
            }}
          >
            <input
              checked={selected}
              disabled={disabled}
              name="familiar"
              onChange={handleChange}
              style={{
                cursor: disabled ? "not-allowed" : "pointer",
                height: "100%",
                inset: 0,
                opacity: 0,
                position: "absolute",
                width: "100%",
              }}
              type="radio"
              value={familiarId}
            />
            <FamiliarPortrait
              fallbackLabel={definition.name}
              familiarId={familiarId}
              profileId={automaticProfileId}
              selected={selected}
              size={36}
            />
            <span style={{ minWidth: 0 }}>
              <strong
                style={{
                  display: "block",
                  font: "600 12px/1.2 var(--font-ui)",
                }}
              >
                {definition.name}
              </strong>
              <span
                style={{
                  color: "var(--text-muted)",
                  display: "block",
                  font: "400 10px/1.35 var(--font-ui)",
                  marginTop: 3,
                }}
              >
                {definition.species}
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
