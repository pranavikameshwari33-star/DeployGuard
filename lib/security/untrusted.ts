/**
 * Stage 1: handling repository-derived text (commit messages, branch names,
 * file paths, author names, CI output) as ATTACKER-CONTROLLED data.
 *
 * Pure: no imports from the app, so tests can load it directly.
 */
import { redactText } from "./redact.ts";

/** Length caps for untrusted fields placed in a Gemini evidence bundle. */
export const MODEL_FIELD_LIMITS = {
  commitMessage: 300,
  branch: 200,
  author: 100,
  path: 300,
  failureOutput: 1000,
  short: 200,
};

/**
 * Prepares one untrusted string for the model: redacted, control characters
 * removed, instruction-like delimiters neutralised, length capped. It is then
 * placed in a JSON string field (JSON.stringify quotes it), never concatenated
 * into the instructions.
 *
 * Neutralising delimiters stops text from imitating the structure of a prompt
 * (fake "```" blocks, chat-role markers, XML-ish system tags). The words are
 * left readable; the model is told separately that field contents are data.
 */
export function sanitizeForModel(value: string | null | undefined, max: number, keep: "start" | "end" = "start"): string {
  if (!value) return "";
  let text = redactText(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f​-‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/```+/g, "'''")
    .replace(/<\|[^|>]{0,40}\|>/g, "[delimiter removed]")
    .replace(/<\/?\s*(system|assistant|user|instructions?|prompt|tool|im_start|im_end)\b[^>]*>/gi, "[tag removed]")
    .replace(/\[\/?(INST|SYS)\]/g, "[marker removed]");
  if (text.length > max) {
    text = keep === "end" ? `... ${text.slice(-max)}` : `${text.slice(0, max)} ...`;
  }
  return text;
}

/** Same as sanitizeForModel, keeping null as null. */
export function sanitizeNullable(value: string | null | undefined, max: number, keep: "start" | "end" = "start"): string | null {
  return value == null ? null : sanitizeForModel(value, max, keep);
}

/**
 * A link that came from GitHub data (e.g. a workflow run URL) is rendered only
 * if it is an https link to github.com. Anything else (javascript:, data:,
 * another host) is dropped, so a crafted value can never become an active link.
 */
export function safeGithubUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
