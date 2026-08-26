// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  hairline,
  tabular,
  truncate,
  type as type_,
} from "@/components/console/styles";

/**
 * ⌘K.
 *
 * Ranks nothing cleverly: it filters on a substring and keeps the caller's
 * order. A console this size does not need fuzzy matching, and a surprising
 * top result is worse than a predictable list.
 */

export type PaletteItem = {
  group: string;
  hint?: string;
  id: string;
  label: string;
  run: () => void;
};

export function CommandPalette({
  items,
  onClose,
}: {
  items: PaletteItem[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return items;
    }
    return items.filter((item) =>
      `${item.group} ${item.label} ${item.hint ?? ""}`
        .toLowerCase()
        .includes(needle)
    );
  }, [items, query]);

  useEffect(() => {
    setActive(0);
  }, []);

  const choose = (index: number) => {
    const item = matches[index];
    if (item) {
      onClose();
      item.run();
    }
  };

  return (
    <div
      style={{
        alignItems: "flex-start",
        background: "oklch(0 0 0 / 0.42)",
        display: "flex",
        inset: 0,
        justifyContent: "center",
        padding: "12vh 16px 16px",
        position: "absolute",
        zIndex: 70,
      }}
    >
      <button
        aria-label="Close the command palette"
        onClick={onClose}
        style={{
          background: "transparent",
          border: 0,
          cursor: "default",
          inset: 0,
          position: "absolute",
        }}
        type="button"
      />
      <div
        aria-label="Search runs, agents, and commands"
        aria-modal="true"
        role="dialog"
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-panel)",
          boxShadow: "var(--shadow-lg)",
          display: "flex",
          flexDirection: "column",
          maxHeight: "60vh",
          overflow: "hidden",
          position: "relative",
          width: "min(620px, 100%)",
        }}
      >
        <input
          aria-label="Search"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              onClose();
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((value) => Math.min(matches.length - 1, value + 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((value) => Math.max(0, value - 1));
            }
            if (event.key === "Enter") {
              event.preventDefault();
              choose(active);
            }
          }}
          placeholder="Search runs, agents, and commands"
          ref={inputRef}
          style={{
            background: "transparent",
            border: 0,
            borderBottom: hairline,
            color: "var(--text-primary)",
            font: "400 14px/1 var(--font-ui)",
            outline: "none",
            padding: "16px 18px",
          }}
          value={query}
        />
        <div
          className="oc-scroll"
          style={{ minHeight: 0, overflowY: "auto", padding: 6 }}
        >
          {matches.length === 0 ? (
            <p
              style={{
                ...type_.body,
                color: "var(--text-muted)",
                font: "400 12px/1.5 var(--font-ui)",
                padding: "14px 12px",
              }}
            >
              Nothing matches “{query}”.
            </p>
          ) : (
            matches.map((item, index) => (
              <button
                className="oc-row"
                key={item.id}
                onClick={() => choose(index)}
                onPointerEnter={() => setActive(index)}
                style={{
                  alignItems: "center",
                  background:
                    index === active ? "var(--bg-hover)" : "transparent",
                  border: 0,
                  borderRadius: "var(--radius-control)",
                  cursor: "pointer",
                  display: "flex",
                  gap: 10,
                  padding: "9px 12px",
                  textAlign: "left",
                  width: "100%",
                }}
                type="button"
              >
                <span
                  style={{
                    ...type_.meta,
                    ...tabular,
                    flex: "none",
                    textTransform: "uppercase",
                    width: 62,
                  }}
                >
                  {item.group}
                </span>
                <span style={{ ...type_.label, flex: 1, ...truncate }}>
                  {item.label}
                </span>
                {item.hint ? (
                  <span style={{ ...type_.meta, ...truncate, maxWidth: 200 }}>
                    {item.hint}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
