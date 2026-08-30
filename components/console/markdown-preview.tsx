"use client";

import { useEffect, useState } from "react";
import { renderConsoleMarkdown } from "@/lib/console/markdown";

export function MarkdownPreview({
  children,
  live = false,
}: {
  children: string;
  live?: boolean;
}) {
  const [preview, setPreview] = useState<{
    html: string;
    source: string;
  } | null>(null);

  useEffect(() => {
    let active = true;

    renderConsoleMarkdown(children)
      .then((generatedHtml) => {
        if (active) {
          setPreview({ html: generatedHtml, source: children });
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to render run Markdown.", error);
        if (active) {
          setPreview(null);
        }
      });

    return () => {
      active = false;
    };
  }, [children]);

  const renderedHtml = preview?.source === children ? preview.html : null;

  return (
    <div className={live ? "oc-markdown oc-markdown-live" : "oc-markdown"}>
      {renderedHtml === null ? (
        <span className="oc-markdown-fallback">{children}</span>
      ) : (
        <div
          // @create-markdown escapes source text and this final boundary applies
          // a strict tag, attribute, and URL allowlist before insertion.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized Markdown preview output
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      )}
      {live ? (
        <span aria-hidden="true" className="oc-caret oc-markdown-caret" />
      ) : null}
    </div>
  );
}
