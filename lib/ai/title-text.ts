import { sanitizeEvidenceText } from "@opencoven/agent-contracts";
import type { UIMessage } from "ai";

export const DEFAULT_CHAT_TITLE = "New chat";
const MAX_INPUT_LENGTH = 4096;
const MAX_TITLE_GRAPHEMES = 40;
const MAX_TITLE_LENGTH = 256;
const MAX_TITLE_WORDS = 7;
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const words = new Intl.Segmenter("en", { granularity: "word" });
const bidiAndSurrogateCharacters = /[\p{Cf}\p{Cs}]/gu;
const controlCharacters = /[\p{Cc}\p{Cf}\p{Cs}]/gu;
const redactedPlaceholder = /\[[^\]\r\n]*redacted\]/giu;
const privateKeyBlock = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*/gu;
const credentialUrl = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/giu;
const webUrl = /\bwww\.[^\s<>]+/giu;
const emailAddress = /\S+@\S+/gu;
const sensitiveQueryValue = /\S+[?&](?:token|key|secret|password)=[^\s]*/giu;
const sensitiveLabelValue =
  /\b(?:password|secret|token|api[-_ ]?key|access[-_ ]?token)\s*(?:\bis\b|:|=)\s*[^\r\n]*/giu;
const htmlTag = /<[^>]*>/gu;
const orderedListPrefix = /^\s*\d+[.)]\s+/u;
const markdownDecoration = /[`*#[\]<>~\\|{}()"]/gu;
const underscoreEmphasis =
  /(?<![\p{L}\p{N}_])(_{1,2})(?=\S)([\s\S]*?\S)\1(?![\p{L}\p{N}_])/gu;

function boundedInput(value: string): string {
  if (value.length <= MAX_INPUT_LENGTH) {
    return value;
  }
  // Drop the cut token, rather than retaining a partial credential.
  return value.slice(0, MAX_INPUT_LENGTH).replace(/\S+$/u, "");
}

function redactSensitiveTitleText(value: string): string {
  return value
    .replace(privateKeyBlock, "")
    .replace(credentialUrl, "")
    .replace(webUrl, "")
    .replace(emailAddress, "")
    .replace(sensitiveQueryValue, "")
    .replace(sensitiveLabelValue, "");
}

function stripTitleMarkup(value: string): string {
  return (
    value
      .replace(redactedPlaceholder, "")
      .replace(htmlTag, "")
      .replace(orderedListPrefix, "")
      .replace(controlCharacters, " ")
      .replace(markdownDecoration, "")
      // Underscores within identifiers are credential delimiters, not emphasis.
      .replace(underscoreEmphasis, "$2")
  );
}

function safeTitleText(value: string): string {
  const input = redactSensitiveTitleText(
    boundedInput(value).normalize("NFC").replace(bidiAndSurrogateCharacters, "")
  );
  const plainText = stripTitleMarkup(sanitizeEvidenceText(input));
  // Removing markup can rejoin a secret-shaped token; repeat title-specific
  // redaction before truncation.
  return redactSensitiveTitleText(sanitizeEvidenceText(plainText))
    .replace(redactedPlaceholder, "")
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
