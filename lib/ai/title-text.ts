import { sanitizeEvidenceText } from "@opencoven/agent-contracts";
import type { UIMessage } from "ai";

export const DEFAULT_CHAT_TITLE = "New chat";
const MAX_INPUT_LENGTH = 4096;
const MAX_TITLE_GRAPHEMES = 40;
const MAX_TITLE_LENGTH = 256;
const MAX_TITLE_WORDS = 7;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const words = new Intl.Segmenter("en", { granularity: "word" });

function boundedInput(value: string): string {
  if (value.length <= MAX_INPUT_LENGTH) {
    return value;
  }
  // Drop the cut token, rather than retaining a partial credential.
  return value.slice(0, MAX_INPUT_LENGTH).replace(/\S+$/u, "");
}

function safeTitleText(value: string): string {
  const input = boundedInput(value)
    .normalize("NFC")
    .replace(/[\p{Cf}\p{Cs}]/gu, "")
    .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*/gu, "")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/giu, "")
    .replace(/\bwww\.[^\s<>]+/giu, "")
    .replace(/\S+@\S+/gu, "")
    .replace(/\S+[?&](?:token|key|secret|password)=[^\s]*/giu, "")
    .replace(
      /\b(?:password|secret|token|api[-_ ]?key|access[-_ ]?token)\s*(?:\bis\b|:|=)\s*[^\r\n]*/giu,
      ""
    );
  const plainText = sanitizeEvidenceText(input)
    .replace(/\[[^\]\r\n]*redacted\]/giu, "")
    .replace(/<[^>]*>/gu, "")
    .replace(/^\s*\d+[.)]\s+/u, "")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, " ")
    .replace(/[`*#[\]<>~\\|{}()"]/gu, "")
    // Underscores within identifiers are credential delimiters, not emphasis.
    .replace(
      /(?<![\p{L}\p{N}_])(_{1,2})(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}_])/gu,
      "$2"
    );
  // Removing markup can rejoin a secret-shaped token; redact before truncation.
  return sanitizeEvidenceText(plainText)
    .replace(/\[[^\]\r\n]*redacted\]/giu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .normalize("NFC");
}

export function titleInputFromMessage(message: UIMessage): string {
  let text = "";
  for (const part of message.parts.slice(0, 64)) {
    if (part.type === "text") {
      text += `${part.text.slice(0, MAX_INPUT_LENGTH + 1)}\n`;
      if (text.length > MAX_INPUT_LENGTH) {
        break;
      }
    }
  }
  return boundedInput(safeTitleText(text)).trim();
}

export function normalizeChatTitle(value: string): string {
  const input = safeTitleText(value)
    .split(" ")
    .slice(0, MAX_TITLE_WORDS)
    .join(" ");
  let title = "";
  let wordCount = 0;
  for (const part of words.segment(input)) {
    if (part.isWordLike) {
      wordCount += 1;
    }
    if (wordCount > MAX_TITLE_WORDS) {
      break;
    }
    title += part.segment;
  }
  let bounded = "";
  let graphemeCount = 0;
  for (const part of graphemes.segment(title)) {
    if (
      graphemeCount === MAX_TITLE_GRAPHEMES ||
      bounded.length + part.segment.length > MAX_TITLE_LENGTH
    ) {
      if (/\s/u.test(bounded) && !/^\s/u.test(part.segment)) {
        bounded = bounded.replace(/\s+\S*$/u, "");
      }
      break;
    }
    bounded += part.segment;
    graphemeCount += 1;
  }
  title = bounded.replace(/^[\s:;,./!?'=-]+|[\s:;,./!?'=-]+$/gu, "").trim();
  return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(title) ? title : "";
}
