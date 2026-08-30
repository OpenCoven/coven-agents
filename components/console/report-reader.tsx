"use client";

import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { MarkdownPreview } from "@/components/console/markdown-preview";

type ReportSection = {
  id: string;
  markdown: string;
  title: string;
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  'button:not([disabled]):not([tabindex="-1"])',
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function plainHeading(value: string): string {
  return value
    .replace(/[*_`~[\]]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function reportSections(source: string): ReportSection[] {
  const sections: ReportSection[] = [];
  let lines: string[] = [];
  let title = "Overview";

  const pushSection = () => {
    const markdown = lines.join("\n").trim();
    if (!markdown) {
      return;
    }
    sections.push({
      id: `report-section-${sections.length + 1}`,
      markdown,
      title,
    });
  };

  for (const line of source.split("\n")) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/u.exec(line);
    if (!heading) {
      lines.push(line);
      continue;
    }
    pushSection();
    title = plainHeading(heading[2] ?? "") || "Untitled section";
    lines = [line];
  }
  pushSection();

  return sections.length > 0
    ? sections
    : [{ id: "report-section-1", markdown: source, title: "Report" }];
}

export function ReportReader({
  content,
  onClose,
  title,
}: {
  content: string;
  onClose: () => void;
  title: string;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const sections = useMemo(() => reportSections(content), [content]);
  const lineCount = content.split("\n").filter((line) => line.trim()).length;
  const words = content.trim().split(/\s+/u).filter(Boolean).length;
  const readingMinutes = Math.max(1, Math.ceil(words / 220));
  const scrollToSection = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const sectionId = event.currentTarget.dataset.reportSectionTarget;
      if (!sectionId) {
        return;
      }
      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches
        ? "auto"
        : "smooth";
      bodyRef.current
        ?.querySelector<HTMLElement>(`[data-report-section="${sectionId}"]`)
        ?.scrollIntoView({ behavior, block: "start" });
    },
    []
  );

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          FOCUSABLE_SELECTOR
        ) ?? []),
      ].filter((element) => element.getClientRects().length > 0);
      const [first] = focusable;
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) {
        previousFocus.focus();
      }
    };
  }, []);

  return (
    <div className="oc-report-reader-backdrop">
      <button
        aria-hidden="true"
        className="oc-report-reader-backdrop__dismiss"
        onClick={onClose}
        tabIndex={-1}
        type="button"
      />
      <section
        aria-describedby="report-reader-summary"
        aria-labelledby="report-reader-title"
        aria-modal="true"
        className="oc-report-reader"
        ref={dialogRef}
        role="dialog"
      >
        <header className="oc-report-reader__header">
          <div>
            <span className="oc-report-reader__eyebrow">Dedicated reader</span>
            <h2 id="report-reader-title">{title}</h2>
            <p id="report-reader-summary">
              {sections.length} {sections.length === 1 ? "section" : "sections"}
              {" · "}
              {lineCount} {lineCount === 1 ? "line" : "lines"}
              {" · "}
              {readingMinutes} min read
            </p>
          </div>
          <button
            aria-label="Close report reader"
            className="oc-report-reader__close"
            onClick={onClose}
            ref={closeRef}
            type="button"
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>

        <div className="oc-report-reader__layout">
          <nav aria-label="Report sections" className="oc-report-reader__nav">
            <span>Sections</span>
            {sections.map((section, index) => (
              <button
                data-report-section-target={section.id}
                key={section.id}
                onClick={scrollToSection}
                type="button"
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                {section.title}
              </button>
            ))}
          </nav>

          <div className="oc-report-reader__body oc-scroll" ref={bodyRef}>
            {sections.map((section) => (
              <article data-report-section={section.id} key={section.id}>
                <MarkdownPreview variant="report">
                  {section.markdown}
                </MarkdownPreview>
              </article>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
