// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import { Bot, CornerDownLeft, ScrollText, Zap } from "lucide-react";
import {
  type ComponentType,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { hairline, truncate, type as type_ } from "@/components/console/styles";

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

const GROUP_LABELS: Record<string, string> = {
  action: "Commands",
  agent: "Agents",
  run: "Runs",
};

const GROUP_ICONS: Record<string, ComponentType<{ size?: number }>> = {
  action: Zap,
  agent: Bot,
  run: ScrollText,
};

function optionId(id: string): string {
  return `oc-palette-option-${id}`;
}

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
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = dialogRef.current;
    dialog?.showModal();
    inputRef.current?.focus();
    return () => {
      dialog?.close();
      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }
    };
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

  // Items keep the caller's order; sections appear in first-seen order so
  // the caller still decides what leads.
  const sections = useMemo(() => {
    const byGroup = new Map<string, { index: number; item: PaletteItem }[]>();
    matches.forEach((item, index) => {
      const bucket = byGroup.get(item.group) ?? [];
      bucket.push({ index, item });
      byGroup.set(item.group, bucket);
    });
    return [...byGroup.entries()];
  }, [matches]);

  useEffect(() => {
    const activeItem = matches[active];
    if (!activeItem) {
      return;
    }
    document
      .getElementById(optionId(activeItem.id))
      ?.scrollIntoView({ block: "nearest" });
  }, [active, matches]);

  const choose = (index: number) => {
    const item = matches[index];
    if (item) {
      onClose();
      item.run();
    }
  };

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: the modal owns Tab cycling between its controls.
    <dialog
      aria-label="Search runs, agents, and commands"
      className="oc-command-palette"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") {
          return;
        }
        const controls = [
          ...event.currentTarget.querySelectorAll<HTMLElement>(
            'input, button:not([tabindex="-1"])'
          ),
        ];
        const [first] = controls;
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
      ref={dialogRef}
      style={{
        alignItems: "flex-start",
        backdropFilter: "blur(6px)",
        background: "oklch(0 0 0 / 0.42)",
        border: 0,
        color: "var(--text-primary)",
        height: "100%",
        inset: 0,
        justifyContent: "center",
        margin: 0,
        maxHeight: "none",
        maxWidth: "none",
        padding: "12vh 16px 16px",
        position: "fixed",
        width: "100%",
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
        tabIndex={-1}
        type="button"
      />
      <div
        className="oc-palette-panel"
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
          aria-activedescendant={
            matches[active] ? optionId(matches[active].id) : undefined
          }
          aria-autocomplete="list"
          aria-controls="oc-palette-options"
          aria-expanded="true"
          aria-label="Search"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
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
          role="combobox"
          style={{
            background: "transparent",
            border: 0,
            borderBottom: hairline,
            color: "var(--text-primary)",
            font: "400 14px/1 var(--font-ui)",
            padding: "16px 18px",
          }}
          value={query}
        />
        <div
          className="oc-scroll"
          id="oc-palette-options"
          role="listbox"
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
            sections.map(([group, entries]) => {
              const Icon = GROUP_ICONS[group] ?? Zap;
              return (
                // biome-ignore lint/a11y/useSemanticElements: `group` is the ARIA role for option clusters inside a listbox; a fieldset is for form controls and is invalid here.
                <div
                  aria-label={GROUP_LABELS[group] ?? group}
                  key={group}
                  role="group"
                  style={{ paddingBottom: 4 }}
                >
                  <div
                    aria-hidden="true"
                    style={{
                      alignItems: "center",
                      display: "flex",
                      gap: 8,
                      padding: "8px 12px 4px",
                    }}
                  >
                    <span
                      style={{ ...type_.eyebrow, color: "var(--text-faint)" }}
                    >
                      {GROUP_LABELS[group] ?? group}
                    </span>
                    <span
                      style={{
                        background: "var(--border-hairline)",
                        flex: 1,
                        height: 1,
                      }}
                    />
                  </div>
                  {entries.map(({ index, item }) => (
                    <button
                      aria-selected={index === active}
                      className="oc-row"
                      id={optionId(item.id)}
                      key={item.id}
                      onClick={() => choose(index)}
                      onPointerEnter={() => setActive(index)}
                      role="option"
                      style={{
                        alignItems: "center",
                        background:
                          index === active ? "var(--bg-hover)" : "transparent",
                        border: 0,
                        borderRadius: "var(--radius-control)",
                        cursor: "pointer",
                        display: "flex",
                        gap: 10,
                        padding: "8px 10px",
                        textAlign: "left",
                        width: "100%",
                      }}
                      type="button"
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          alignItems: "center",
                          background:
                            index === active
                              ? "var(--fill-info)"
                              : "var(--bg-raised)",
                          border: hairline,
                          borderRadius: "var(--radius-sm)",
                          color:
                            index === active
                              ? "var(--accent-presence)"
                              : "var(--text-muted)",
                          display: "inline-flex",
                          flex: "none",
                          height: 24,
                          justifyContent: "center",
                          width: 24,
                        }}
                      >
                        <Icon size={12} />
                      </span>
                      <span style={{ ...type_.label, flex: 1, ...truncate }}>
                        {item.label}
                      </span>
                      {item.hint ? (
                        <span
                          style={{ ...type_.meta, ...truncate, maxWidth: 200 }}
                        >
                          {item.hint}
                        </span>
                      ) : null}
                      {index === active ? (
                        <span
                          aria-hidden="true"
                          style={{
                            color: "var(--text-faint)",
                            display: "inline-flex",
                            flex: "none",
                          }}
                        >
                          <CornerDownLeft size={11} />
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>
        <div
          aria-hidden="true"
          style={{
            alignItems: "center",
            borderTop: hairline,
            display: "flex",
            gap: 14,
            padding: "8px 14px",
          }}
        >
          {[
            ["↑↓", "navigate"],
            ["↵", "open"],
            ["esc", "close"],
          ].map(([key, label]) => (
            <span
              key={key}
              style={{
                alignItems: "center",
                color: "var(--text-faint)",
                display: "inline-flex",
                font: "400 10px/1 var(--font-mono)",
                gap: 6,
              }}
            >
              <kbd
                style={{
                  background: "var(--bg-raised)",
                  border: hairline,
                  borderRadius: 4,
                  color: "var(--text-muted)",
                  font: "500 10px/1 var(--font-mono)",
                  padding: "3px 5px",
                }}
              >
                {key}
              </kbd>
              {label}
            </span>
          ))}
          <span
            style={{
              color: "var(--text-faint)",
              font: "400 10px/1 var(--font-mono)",
              marginLeft: "auto",
            }}
          >
            {matches.length} {matches.length === 1 ? "result" : "results"}
          </span>
        </div>
      </div>
    </dialog>
  );
}
