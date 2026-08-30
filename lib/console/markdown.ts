import { parse } from "@create-markdown/core";
import sanitizeHtml from "sanitize-html";

const MARKDOWN_TAGS = [
  "a",
  "blockquote",
  "code",
  "del",
  "div",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "input",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
] as const;

/**
 * Converts untrusted runner Markdown into the small HTML vocabulary used by
 * the console. Images are intentionally omitted so run output cannot trigger
 * third-party requests from a subscriber's browser.
 */
export async function renderConsoleMarkdown(markdown: string): Promise<string> {
  const { blocksToHTML } = await import("@create-markdown/preview");
  const rendered = blocksToHTML(parse(markdown), {
    classPrefix: "oc-md-",
    linkTarget: "_blank",
  });

  return sanitizeHtml(rendered, {
    allowedAttributes: {
      "*": ["class"],
      a: ["href", "rel", "target", "title"],
      div: ["role"],
      input: ["checked", "disabled", "type"],
      pre: ["data-language"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedTags: [...MARKDOWN_TAGS],
    allowProtocolRelative: false,
  });
}
