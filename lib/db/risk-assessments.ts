import { getPool } from "@/lib/db/client";
import type { RiskAssessment, RiskEvidence, RiskLevel } from "@/lib/risk/validate";

/** One row of the `risk_assessments` table (Phase 7). */
export type StoredRiskAssessment = {
  id: string;
  deployment_id: string;
  risk_level: RiskLevel;
  /** NUMERIC comes back from node-postgres as a string; converted to a number below. */
  risk_confidence: number;
  risk_summary: string;
  risk_reasons: RiskAssessment["reasons"];
  historical_evidence: RiskAssessment["historical_evidence"];
  missing_information: string[];
  recommended_checks: string[];
  evidence: RiskEvidence;
  evidence_fingerprint: string;
  model: string;
  risk_generated_at: Date;
  /** Derived from `evidence`; validation guaranteed the model agreed with it. */
  historical_evidence_available: boolean;
};

const COLUMNS = `
  id, deployment_id, risk_level, risk_confidence, risk_summary, risk_reasons,
  historical_evidence, missing_information, recommended_checks, evidence,
  evidence_fingerprint, model, risk_generated_at
`;

function fromRow(row: StoredRiskAssessment): StoredRiskAssessment {
  return {
    ...row,
    risk_confidence: Number(row.risk_confidence),
    historical_evidence_available: row.evidence.historical_evidence.available,
  };
}

/** The stored assessment for exactly these facts, if one exists. */
export async function findAssessmentByFingerprint(
  deploymentId: string,
  fingerprint: string
): Promise<StoredRiskAssessment | null> {
  const result = await getPool().query<StoredRiskAssessment>(
    `SELECT ${COLUMNS} FROM risk_assessments WHERE deployment_id = $1 AND evidence_fingerprint = $2`,
    [deploymentId, fingerprint]
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

/** The newest stored assessment for a deployment, whatever evidence it was based on. */
export async function getLatestAssessment(deploymentId: string): Promise<StoredRiskAssessment | null> {
  const result = await getPool().query<StoredRiskAssessment>(
    `SELECT ${COLUMNS} FROM risk_assessments WHERE deployment_id = $1
     ORDER BY risk_generated_at DESC, id DESC LIMIT 1`,
    [deploymentId]
  );
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}

/** Phase 8: the latest risk level of each given deployment (for the history table). */
export async function getLatestRiskLevels(deploymentIds: string[]): Promise<Map<string, RiskLevel>> {
  if (deploymentIds.length === 0) return new Map();
  const result = await getPool().query<{ deployment_id: string; risk_level: RiskLevel }>(
    `SELECT DISTINCT ON (deployment_id) deployment_id, risk_level
     FROM risk_assessments WHERE deployment_id = ANY($1::bigint[])
     ORDER BY deployment_id, risk_generated_at DESC, id DESC`,
    [deploymentIds]
  );
  return new Map(result.rows.map((r) => [r.deployment_id, r.risk_level]));
}

/**
 * Stores a VALIDATED assessment. Two identical requests racing each other both
 * land on the unique (deployment_id, evidence_fingerprint) index; the second
 * one keeps the first row, so there is never a duplicate.
 */
export async function saveAssessment(input: {
  deploymentId: string;
  assessment: RiskAssessment;
  evidence: RiskEvidence;
  fingerprint: string;
  model: string;
}): Promise<{ stored: StoredRiskAssessment; isNew: boolean }> {
  const { assessment: a } = input;
  const inserted = await getPool().query<StoredRiskAssessment>(
    `INSERT INTO risk_assessments (
       deployment_id, risk_level, risk_confidence, risk_summary, risk_reasons,
       historical_evidence, missing_information, recommended_checks, evidence,
       evidence_fingerprint, model
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11)
     ON CONFLICT (deployment_id, evidence_fingerprint) DO NOTHING
     RETURNING ${COLUMNS}`,
    [
      input.deploymentId,
      a.risk_level,
      a.confidence,
      a.summary,
      JSON.stringify(a.reasons),
      JSON.stringify(a.historical_evidence),
      JSON.stringify(a.missing_information),
      JSON.stringify(a.recommended_checks),
      JSON.stringify(input.evidence),
      input.fingerprint,
      input.model,
    ]
  );
  if (inserted.rows[0]) return { stored: fromRow(inserted.rows[0]), isNew: true };

  const existing = await findAssessmentByFingerprint(input.deploymentId, input.fingerprint);
  if (!existing) throw new Error("Risk assessment conflicted on insert but could not be read back.");
  return { stored: existing, isNew: false };
}
