import crypto from "node:crypto";
import { getDeploymentById, type Deployment } from "@/lib/db/deployments";
import { getIncidentForDeployment, type Incident } from "@/lib/db/incidents";
import { findSimilarDeployments, type HistoricalEvidence } from "@/lib/similarity/find-similar";
import type { EvidenceFailure, EvidenceIncident, EvidenceMatch, RiskEvidence } from "@/lib/risk/validate";
import { redactDeep } from "@/lib/security/redact";
import { MODEL_FIELD_LIMITS as L, sanitizeForModel, sanitizeNullable } from "@/lib/security/untrusted";

/**
 * Phase 7: gathers the evidence bundle for one deployment.
 *
 * Every field comes from PostgreSQL (the deployment, its Phase 5 analysis, its
 * pipeline state and incident) or from Phase 6's similarity engine, which is
 * reused unchanged -- Gemini never searches history itself. Hindsight's
 * recalled text is deliberately NOT forwarded: it is Hindsight's paraphrase of
 * our records and has been seen to add causal wording ("failed due to ...")
 * that the records do not contain. Hindsight still contributes through Phase 6,
 * which uses it to find and rank matches.
 */

/** Bump when the prompt or bundle shape changes, so cached assessments are regenerated. */
// risk-v3 (Stage 1): untrusted fields sanitised, instructions state that field contents are data.
export const RISK_PROMPT_VERSION = "risk-v3";

const MAX_TEXT = 1000;

export type RiskEvidenceResult = {
  deployment: Deployment;
  evidence: RiskEvidence;
  /** Changes only when the facts change (see fingerprintOf). Used to reuse stored assessments. */
  fingerprint: string;
};

export async function buildRiskEvidence(deploymentId: string): Promise<RiskEvidenceResult | null> {
  const deployment = await getDeploymentById(deploymentId);
  if (!deployment) return null;

  const [similar, incident] = await Promise.all([
    findSimilarDeployments(deploymentId),
    deployment.status === "FAILED" ? getIncidentForDeployment(deploymentId) : Promise.resolve(null),
  ]);
  if (!similar) return null;

  const matches: EvidenceMatch[] = similar.matches.map(toEvidenceMatch);

  const outcomeCounts: Record<string, number> = {};
  for (const m of matches) outcomeCounts[m.status] = (outcomeCounts[m.status] ?? 0) + 1;

  const evidence: RiskEvidence = {
    current_deployment: {
      deployment_id: deployment.id,
      repository: `${deployment.owner}/${deployment.repository}`,
      owner: deployment.owner,
      branch: deployment.branch,
      commit_sha: deployment.commit_sha,
      commit_message: deployment.commit_message.split("\n")[0].trim(),
      author: deployment.author,
      recorded_at: deployment.created_at.toISOString(),
      added_files: deployment.added_files,
      modified_files: deployment.modified_files,
      deleted_files: deployment.deleted_files,
    },
    change_analysis: {
      change_categories: similar.deployment.change_categories,
      affected_services: similar.deployment.affected_services,
      files: (deployment.file_analysis ?? []).map((f) => ({
        path: f.path,
        change_type: f.change_type,
        categories: f.categories,
        service: f.service,
      })),
    },
    current_pipeline: {
      status: deployment.status,
      state: pipelineState(deployment),
      ci_run_url: deployment.ci_run_url,
      started_at: deployment.ci_started_at?.toISOString() ?? null,
      finished_at: deployment.ci_finished_at?.toISOString() ?? null,
      failure:
        deployment.status === "FAILED"
          ? { stage: deployment.failure_stage, job: deployment.failure_job, message: clip(deployment.failure_message) }
          : null,
      incident: incident ? toEvidenceIncident(incident) : null,
    },
    historical_evidence: {
      available: matches.length > 0,
      match_count: matches.length,
      outcome_counts: outcomeCounts,
      matches,
    },
    evidence_notes: [
      "historical_evidence.matches is the COMPLETE list of past deployments available for this analysis. No other deployments exist for you.",
      "similarity_score is DeployGuard's rule-based ranking heuristic (see matched_signals). It is not a probability.",
      "root_cause, resolution = null means NOT KNOWN. Do not fill them in or guess them.",
      "A recorded SUCCESS means the GitHub Actions pipeline completed install, tests, build and a simulated deployment.",
      "Pipeline status RECEIVED means CI has not reported yet; BUILDING means CI is running. No test or build result exists yet in either case.",
      ...(matches.length === 0
        ? [
            "NO SIMILAR HISTORY: historical_evidence.matches is empty. Do NOT write any reason with basis \"historical_evidence\". State the absence of history in the summary and in missing_information instead.",
          ]
        : []),
    ],
  };

  const safe = protectEvidence(evidence);
  return { deployment, evidence: safe, fingerprint: fingerprintOf(safe) };
}

/**
 * Stage 1: every repository-derived string in the bundle (commit messages,
 * author, branch, file paths, CI output, job/step names, incident text) is
 * attacker-controlled. Each is redacted, stripped of control characters and
 * prompt-like delimiters, and length-capped; it then travels only as a JSON
 * string value. A final deep redaction pass covers anything missed.
 */
export function protectEvidence(e: RiskEvidence): RiskEvidence {
  const path = (p: string) => sanitizeForModel(p, L.path);
  const failure = (f: EvidenceFailure | null): EvidenceFailure | null =>
    f && {
      stage: sanitizeNullable(f.stage, L.short),
      job: sanitizeNullable(f.job, L.short),
      message: sanitizeNullable(f.message, L.failureOutput, "end"),
    };
  const incident = (i: EvidenceIncident | null): EvidenceIncident | null =>
    i && {
      ...i,
      failure_type: sanitizeForModel(i.failure_type, L.short),
      error_message: sanitizeNullable(i.error_message, L.failureOutput, "end"),
      root_cause: sanitizeNullable(i.root_cause, L.failureOutput),
      resolution: sanitizeNullable(i.resolution, L.failureOutput),
    };
  const protectedBundle: RiskEvidence = {
    ...e,
    current_deployment: {
      ...e.current_deployment,
      repository: sanitizeForModel(e.current_deployment.repository, L.short),
      owner: sanitizeForModel(e.current_deployment.owner, L.short),
      branch: sanitizeForModel(e.current_deployment.branch, L.branch),
      commit_message: sanitizeForModel(e.current_deployment.commit_message, L.commitMessage),
      author: sanitizeForModel(e.current_deployment.author, L.author),
      added_files: e.current_deployment.added_files.map(path),
      modified_files: e.current_deployment.modified_files.map(path),
      deleted_files: e.current_deployment.deleted_files.map(path),
    },
    change_analysis: {
      ...e.change_analysis,
      affected_services: e.change_analysis.affected_services.map((x) => sanitizeForModel(x, L.short)),
      files: e.change_analysis.files.map((f) => ({ ...f, path: path(f.path), service: sanitizeNullable(f.service, L.short) })),
    },
    current_pipeline: {
      ...e.current_pipeline,
      failure: failure(e.current_pipeline.failure),
      incident: incident(e.current_pipeline.incident),
    },
    historical_evidence: {
      ...e.historical_evidence,
      matches: e.historical_evidence.matches.map((m) => ({
        ...m,
        commit_message: sanitizeForModel(m.commit_message, L.commitMessage),
        changed_files: m.changed_files.map(path),
        affected_services: m.affected_services.map((x) => sanitizeForModel(x, L.short)),
        failure: failure(m.failure),
        incident: incident(m.incident),
        matched_signals: m.matched_signals.map((x) => sanitizeForModel(x, L.short)),
      })),
    },
  };
  return redactDeep(protectedBundle).value;
}

/** One Phase 6 match in the evidence-bundle shape. Also used by the dashboard (Phase 8). */
export function toEvidenceMatch(m: HistoricalEvidence): EvidenceMatch {
  return {
    deployment_id: m.deployment_id,
    commit_sha: m.commit_sha,
    commit_message: m.commit_message,
    created_at: m.created_at,
    status: m.status,
    changed_files: m.changed_files,
    change_categories: m.change_categories,
    affected_services: m.affected_services,
    failure: m.failure,
    incident: m.incident,
    similarity_score: m.similarity_score,
    relevance: m.relevance,
    matched_signals: m.matched_signals.map((s) => `${s.signal}: ${s.value} (+${s.points})`),
  };
}

/** What CI has told us so far, in words that cannot be mistaken for a result. */
function pipelineState(d: Deployment): string {
  switch (d.status) {
    case "RECEIVED":
      return "pending: CI has not started or not reported yet; no build/test results are available";
    case "BUILDING":
      return "running: CI has started; no build/test results are available yet";
    case "SUCCESS":
      return "completed: install, tests, build and simulated deployment succeeded";
    case "FAILED":
      return `completed: failed at the ${d.failure_stage ?? "unknown"} stage`;
    default:
      return d.status.toLowerCase();
  }
}

function toEvidenceIncident(i: Incident): EvidenceIncident {
  return {
    id: i.id,
    failure_type: i.failure_type,
    error_message: clip(i.error_message),
    root_cause: i.root_cause,
    resolution: i.resolution,
  };
}

function clip(text: string | null): string | null {
  if (!text) return null;
  return text.length <= MAX_TEXT ? text : `... ${text.slice(-MAX_TEXT)}`;
}

/**
 * A hash of the FACTS in the bundle: the current deployment's files, analysis
 * and pipeline result, and which past deployments matched with what outcome.
 * Scores and Hindsight's contribution are left out on purpose -- recall can
 * vary slightly between calls and should not by itself trigger a new (paid)
 * Gemini call. A new pipeline result, a new incident or a new matching
 * deployment does change it.
 */
function fingerprintOf(e: RiskEvidence): string {
  const facts = {
    version: RISK_PROMPT_VERSION,
    current: e.current_deployment,
    analysis: e.change_analysis,
    pipeline: { status: e.current_pipeline.status, failure: e.current_pipeline.failure, incident: e.current_pipeline.incident?.id ?? null },
    matches: e.historical_evidence.matches
      .map((m) => ({ id: m.deployment_id, status: m.status, incident: m.incident?.id ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  return crypto.createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}
