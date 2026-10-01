/**
 * Phase 7: the evidence bundle sent to Gemini, the assessment we accept back,
 * and the validator that stands between the two.
 *
 * Gemini's answer is untrusted input. It is accepted only if every rule below
 * holds; otherwise the whole answer is rejected (never silently patched into
 * something that looks valid). In particular, the model may only cite
 * deployments that were in the bundle, and may only state the outcome those
 * deployments actually recorded.
 *
 * Facts in the stored assessment (outcome, observed failure, incident id) are
 * copied from the bundle, not from the model's text.
 *
 * Pure: no imports, no I/O -- so the verification script can test it directly.
 */

export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const REASON_BASES = ["historical_evidence", "current_change", "pipeline", "inference"] as const;
export type ReasonBasis = (typeof REASON_BASES)[number];

// ---------------------------------------------------------------------------
// The evidence bundle (input to Gemini). Built from PostgreSQL + Phase 6 only.
// ---------------------------------------------------------------------------

export type EvidenceFailure = { stage: string | null; job: string | null; message: string | null };
export type EvidenceIncident = {
  id: string;
  failure_type: string;
  error_message: string | null;
  root_cause: string | null;
  resolution: string | null;
};

export type EvidenceMatch = {
  deployment_id: string;
  commit_sha: string;
  commit_message: string;
  created_at: string;
  status: string;
  changed_files: string[];
  change_categories: string[];
  affected_services: string[];
  failure: EvidenceFailure | null;
  incident: EvidenceIncident | null;
  similarity_score: number;
  relevance: string;
  matched_signals: string[];
};

export type RiskEvidence = {
  current_deployment: {
    deployment_id: string;
    repository: string;
    owner: string;
    branch: string;
    commit_sha: string;
    commit_message: string;
    author: string;
    recorded_at: string;
    added_files: string[];
    modified_files: string[];
    deleted_files: string[];
  };
  change_analysis: {
    change_categories: string[];
    affected_services: string[];
    files: { path: string; change_type: string; categories: string[]; service: string | null }[];
  };
  current_pipeline: {
    status: string;
    state: string;
    ci_run_url: string | null;
    started_at: string | null;
    finished_at: string | null;
    failure: EvidenceFailure | null;
    incident: EvidenceIncident | null;
  };
  historical_evidence: {
    available: boolean;
    match_count: number;
    outcome_counts: Record<string, number>;
    matches: EvidenceMatch[];
  };
  evidence_notes: string[];
};

// ---------------------------------------------------------------------------
// The accepted assessment (output).
// ---------------------------------------------------------------------------

export type RiskReason = {
  reason: string;
  basis: ReasonBasis;
  evidence_deployment_ids: string[];
};

export type CitedEvidence = {
  deployment_id: string;
  /** Copied from the database record, not from the model. */
  outcome: string;
  observed_failure: string | null;
  incident_id: string | null;
  /** The model's explanation of why this record is relevant (AI analysis). */
  relevance_note: string;
};

export type RiskAssessment = {
  risk_level: RiskLevel;
  /** The model's own confidence, 0-1. Self-reported; NOT statistically calibrated. */
  confidence: number;
  summary: string;
  historical_evidence_available: boolean;
  reasons: RiskReason[];
  historical_evidence: CitedEvidence[];
  missing_information: string[];
  recommended_checks: string[];
};

export type ValidationResult =
  | { ok: true; assessment: RiskAssessment }
  | { ok: false; errors: string[] };

/** The schema Gemini is asked to follow (OpenAPI subset used by generateContent). */
export const RISK_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    risk_level: { type: "STRING", enum: [...RISK_LEVELS] },
    confidence: { type: "NUMBER" },
    summary: { type: "STRING" },
    historical_evidence_available: { type: "BOOLEAN" },
    reasons: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          reason: { type: "STRING" },
          basis: { type: "STRING", enum: [...REASON_BASES] },
          evidence_deployment_ids: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["reason", "basis", "evidence_deployment_ids"],
      },
    },
    historical_evidence: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          deployment_id: { type: "STRING" },
          outcome: { type: "STRING" },
          relevance_note: { type: "STRING" },
        },
        required: ["deployment_id", "outcome", "relevance_note"],
      },
    },
    missing_information: { type: "ARRAY", items: { type: "STRING" } },
    recommended_checks: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: [
    "risk_level",
    "confidence",
    "summary",
    "historical_evidence_available",
    "reasons",
    "historical_evidence",
    "missing_information",
    "recommended_checks",
  ],
} as const;

const LIMITS = { summary: 1500, reason: 800, note: 500, check: 300, reasons: 10, checks: 10, missing: 10 };

export function validateRiskAssessment(raw: unknown, evidence: RiskEvidence): ValidationResult {
  const errors: string[] = [];
  const fail = (message: string): ValidationResult => ({ ok: false, errors: [...errors, message] });

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("response is not a JSON object");
  const r = raw as Record<string, unknown>;

  const supplied = new Map(evidence.historical_evidence.matches.map((m) => [m.deployment_id, m]));
  const available = evidence.historical_evidence.available;

  // --- scalar fields --------------------------------------------------------
  const riskLevel = r.risk_level;
  if (typeof riskLevel !== "string" || !(RISK_LEVELS as readonly string[]).includes(riskLevel)) {
    errors.push(`risk_level must be one of ${RISK_LEVELS.join("/")}`);
  }
  const confidence = r.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    errors.push("confidence must be a number from 0 to 1");
  }
  const summary = text(r.summary, LIMITS.summary);
  if (!summary) errors.push(`summary must be a non-empty string (max ${LIMITS.summary} chars)`);
  if (r.historical_evidence_available !== available) {
    errors.push(`historical_evidence_available must be ${available}, matching the supplied evidence`);
  }

  // --- reasons ----------------------------------------------------------------
  const reasons: RiskReason[] = [];
  if (!Array.isArray(r.reasons) || r.reasons.length === 0 || r.reasons.length > LIMITS.reasons) {
    errors.push(`reasons must be an array of 1-${LIMITS.reasons} items`);
  } else {
    r.reasons.forEach((item, i) => {
      const o = (item ?? {}) as Record<string, unknown>;
      const reason = text(o.reason, LIMITS.reason);
      const basis = o.basis;
      const ids = idList(o.evidence_deployment_ids);
      if (!reason) errors.push(`reasons[${i}].reason must be a non-empty string`);
      if (typeof basis !== "string" || !(REASON_BASES as readonly string[]).includes(basis)) {
        errors.push(`reasons[${i}].basis must be one of ${REASON_BASES.join("/")}`);
      }
      if (ids === null) {
        errors.push(`reasons[${i}].evidence_deployment_ids must be an array of ids`);
        return;
      }
      for (const id of ids) {
        if (!supplied.has(id)) errors.push(`reasons[${i}] cites deployment ${id}, which was not in the supplied evidence`);
      }
      if (basis === "historical_evidence" && ids.length === 0) {
        errors.push(`reasons[${i}] has basis historical_evidence but cites no deployment`);
      }
      if (reason && ids !== null && typeof basis === "string") {
        reasons.push({ reason, basis: basis as ReasonBasis, evidence_deployment_ids: ids });
      }
    });
  }

  // --- cited historical evidence -------------------------------------------------
  const cited: CitedEvidence[] = [];
  if (!Array.isArray(r.historical_evidence)) {
    errors.push("historical_evidence must be an array");
  } else {
    const seen = new Set<string>();
    r.historical_evidence.forEach((item, i) => {
      const o = (item ?? {}) as Record<string, unknown>;
      const id = idValue(o.deployment_id);
      const match = id !== null ? supplied.get(id) : undefined;
      if (id === null || !match) {
        errors.push(`historical_evidence[${i}] cites deployment ${String(o.deployment_id)}, which was not in the supplied evidence`);
        return;
      }
      if (seen.has(id)) {
        errors.push(`historical_evidence cites deployment ${id} twice`);
        return;
      }
      seen.add(id);
      if (String(o.outcome ?? "").toUpperCase() !== match.status) {
        errors.push(`historical_evidence[${i}] states outcome ${String(o.outcome)} for deployment ${id}, but the record says ${match.status}`);
        return;
      }
      cited.push({
        deployment_id: id,
        outcome: match.status,
        observed_failure: match.incident?.error_message ?? match.failure?.message ?? null,
        incident_id: match.incident?.id ?? null,
        relevance_note: text(o.relevance_note, LIMITS.note) ?? "",
      });
    });
  }

  // --- no history supplied => no history may be claimed -----------------------------
  if (!available) {
    if (cited.length > 0) errors.push("no historical evidence was supplied, but historical_evidence is not empty");
    if (reasons.some((x) => x.basis === "historical_evidence")) {
      errors.push("no historical evidence was supplied, but a reason is based on historical_evidence");
    }
  }

  // --- free text may not name deployments/incidents that were not supplied ------------
  const knownIds = new Set<string>([
    evidence.current_deployment.deployment_id,
    ...supplied.keys(),
    ...evidence.historical_evidence.matches.flatMap((m) => (m.incident ? [m.incident.id] : [])),
    ...(evidence.current_pipeline.incident ? [evidence.current_pipeline.incident.id] : []),
  ]);

  // --- lists ---------------------------------------------------------------------
  const missing = stringList(r.missing_information, LIMITS.missing, LIMITS.reason);
  if (missing === null) errors.push(`missing_information must be an array of at most ${LIMITS.missing} strings`);
  const checks = stringList(r.recommended_checks, LIMITS.checks, LIMITS.check);
  if (checks === null || checks.length === 0) {
    errors.push(`recommended_checks must be an array of 1-${LIMITS.checks} strings`);
  }

  // Stage 1: EVERY free-text field is checked, not only summary and reasons.
  const prose = [
    summary ?? "",
    ...reasons.map((x) => x.reason),
    ...cited.map((x) => x.relevance_note),
    ...(missing ?? []),
    ...(checks ?? []),
  ].join("\n");
  for (const id of referencedIds(prose)) {
    if (!knownIds.has(id)) errors.push(`text refers to deployment/incident #${id}, which was not in the supplied evidence`);
  }
  errors.push(...checkUntrustedProse(prose, evidence));

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    assessment: {
      risk_level: riskLevel as RiskLevel,
      confidence: Math.round((confidence as number) * 100) / 100,
      summary: summary as string,
      historical_evidence_available: available,
      reasons,
      historical_evidence: cited,
      missing_information: missing as string[],
      recommended_checks: checks as string[],
    },
  };
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() !== "" && value.length <= max ? value.trim() : null;
}

/** "12" or 12 -> "12"; anything else -> null. */
function idValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^#?\d{1,19}$/.test(value.trim())) return value.trim().replace(/^#/, "");
  return null;
}

function idList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.map(idValue);
  return ids.every((id) => id !== null) ? [...new Set(ids as string[])] : null;
}

function stringList(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const items = value.map((v) => text(v, maxLength));
  return items.every((v) => v !== null) ? (items as string[]) : null;
}

// ---------------------------------------------------------------------------
// Stage 1: checks on the model's free text (injection / hallucination defence)
// ---------------------------------------------------------------------------

/** Upper bound on all free text together, beyond the per-field limits. */
export const MAX_TOTAL_PROSE = 8000;

const HEDGE_OR_UNKNOWN =
  /\b(unknown|not known|not determined|not recorded|undetermined|unclear|unconfirmed|no (?:recorded |known )?root cause|null|may|might|could|possibly|potentially|perhaps|whether|if)\b/i;

/** Assertive claims about a cause or a fix. Allowed only when the bundle holds an attested one. */
const ROOT_CAUSE_CLAIMS: { kind: "root_cause" | "resolution"; pattern: RegExp }[] = [
  { kind: "root_cause", pattern: /\broot[- ]cause\s*(?:is|was|were|appears to be|:)/i },
  { kind: "root_cause", pattern: /\b(?:is|was|were|are)\s+(?:directly\s+|ultimately\s+)?caused\s+by\b/i },
  { kind: "resolution", pattern: /\b(?:was|were|is|has been)\s+(?:resolved|fixed)\s+by\b/i },
];

/**
 * Rejects free text that:
 *  - contains a URL that is not present verbatim in the bundle, or a non-http link scheme;
 *  - contains HTML markup or markdown links/images (output is shown to people);
 *  - asserts a root cause / resolution while the bundle holds no attested one
 *    (hedged or "unknown" statements are fine);
 *  - is excessively long overall.
 */
export function checkUntrustedProse(prose: string, evidence: RiskEvidence): string[] {
  const errors: string[] = [];
  const bundleText = JSON.stringify(evidence);

  if (prose.length > MAX_TOTAL_PROSE) errors.push(`free text is ${prose.length} characters; the limit is ${MAX_TOTAL_PROSE}`);

  for (const m of prose.matchAll(/\b(?:https?|ftp):\/\/[^\s<>"'`)\]]+/gi)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (!bundleText.includes(url)) errors.push(`text contains a URL that is not in the supplied evidence: ${url.slice(0, 100)}`);
  }
  if (/\b(?:javascript|data|vbscript|file):/i.test(prose)) errors.push("text contains a non-http link scheme");
  if (/<\s*\/?\s*(?:script|iframe|img|svg|a|style|object|embed|form|input|link|meta|base)\b/i.test(prose)) {
    errors.push("text contains HTML markup");
  }
  if (/!?\[[^\]\n]*\]\([^)\n]*\)/.test(prose)) errors.push("text contains a markdown link");

  const incidents = [
    evidence.current_pipeline.incident,
    ...evidence.historical_evidence.matches.map((m) => m.incident),
  ].filter((i): i is EvidenceIncident => i !== null);
  const attested = {
    root_cause: incidents.some((i) => Boolean(i.root_cause)),
    resolution: incidents.some((i) => Boolean(i.resolution)),
  };
  for (const sentence of prose.split(/(?<=[.!?])\s+|\n+/)) {
    if (HEDGE_OR_UNKNOWN.test(sentence)) continue;
    for (const claim of ROOT_CAUSE_CLAIMS) {
      if (!attested[claim.kind] && claim.pattern.test(sentence)) {
        errors.push(`text asserts a ${claim.kind.replace("_", " ")} that no attested record supplies: "${sentence.slice(0, 120)}"`);
        break;
      }
    }
  }
  return errors;
}

/** Ids written as "#12", "deployment 12", "deployments #12", "incident #5". */
function referencedIds(prose: string): Set<string> {
  const ids = new Set<string>();
  for (const m of prose.matchAll(/(?:\b(?:deployments?|incidents?)\s*#?\s*|#)(\d{1,19})\b/gi)) ids.add(m[1]);
  return ids;
}
