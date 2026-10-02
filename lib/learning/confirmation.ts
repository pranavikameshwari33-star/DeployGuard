/**
 * Stage 4.1: the input a person submits to confirm an incident's root cause,
 * resolution, affected service and downstream effect.
 *
 * Human input is still untrusted content: it is redacted (someone may paste a
 * log line with a token in it), stripped of control characters and capped,
 * exactly like ingested text. An empty field means "not known" and is stored
 * as NULL -- never as an empty claim.
 *
 * Pure apart from the redaction module (relative import, so tests load it).
 */
import { mergeSummaries, redact, type RedactionSummary } from "../security/redact.ts";

export const CONFIRMATION_LIMITS = {
  root_cause: 1000,
  resolution: 1000,
  affected_service: 100,
  downstream_effect: 1000,
} as const;

export type ConfirmationField = keyof typeof CONFIRMATION_LIMITS;
export const CONFIRMATION_FIELDS = Object.keys(CONFIRMATION_LIMITS) as ConfirmationField[];

export type ConfirmationInput = Record<ConfirmationField, string | null>;

export type ParsedConfirmation =
  | { ok: true; value: ConfirmationInput; redaction: RedactionSummary | null }
  | { ok: false; errors: string[] };

export function parseConfirmation(body: unknown): ParsedConfirmation {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: ["Body must be a JSON object."] };
  const raw = body as Record<string, unknown>;
  const errors: string[] = [];
  const value = {} as ConfirmationInput;
  const summaries: RedactionSummary[] = [];

  for (const key of Object.keys(raw)) {
    if (!(CONFIRMATION_FIELDS as string[]).includes(key)) errors.push(`Unknown field ${key.slice(0, 40)}.`);
  }
  for (const field of CONFIRMATION_FIELDS) {
    const v = raw[field];
    if (v === undefined || v === null) {
      value[field] = null;
      continue;
    }
    if (typeof v !== "string") {
      errors.push(`${field} must be text.`);
      continue;
    }
    const cleaned = v
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f​-‏‪-‮⁦-⁩﻿]/g, "")
      .replace(/\r\n?/g, "\n")
      .trim();
    if (cleaned.length > CONFIRMATION_LIMITS[field]) {
      errors.push(`${field} is longer than ${CONFIRMATION_LIMITS[field]} characters.`);
      continue;
    }
    if (field === "affected_service" && cleaned.includes("\n")) {
      errors.push("affected_service must be a single line.");
      continue;
    }
    const r = redact(cleaned);
    if (r.count) summaries.push(r);
    value[field] = r.text || null;
  }
  if (errors.length === 0 && CONFIRMATION_FIELDS.every((f) => value[f] === null)) {
    errors.push("Fill in at least one field. Leave a field empty when it is not known.");
  }
  if (errors.length) return { ok: false, errors };
  const merged = mergeSummaries(...summaries);
  return { ok: true, value, redaction: merged.count ? merged : null };
}
