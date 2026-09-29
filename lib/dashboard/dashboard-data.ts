import type { FileAnalysis } from "@/lib/analysis/change-analysis";
import {
  getDeploymentById,
  listDeployments,
  type Deployment,
  type DeploymentScope,
  type DeploymentStatus,
  type RiskAnalysisStatus,
} from "@/lib/db/deployments";
import { getIncidentForDeployment, listIncidents, type Incident, type IncidentListItem } from "@/lib/db/incidents";
import {
  getLatestAssessment,
  getLatestRiskLevels,
  type StoredRiskAssessment,
} from "@/lib/db/risk-assessments";
import { toEvidenceMatch } from "@/lib/risk/evidence";
import type { EvidenceMatch, RiskLevel } from "@/lib/risk/validate";
import { findSimilarDeployments } from "@/lib/similarity/find-similar";

/**
 * Phase 8: everything the dashboard shows, read in one place.
 *
 * READ-ONLY and cheap by design: PostgreSQL only. It never calls Gemini and
 * never calls Hindsight, so loading or refreshing the dashboard cannot cost a
 * model call. Used by the dashboard page and by GET /api/dashboard.
 */

export type DashboardDeployment = {
  id: string;
  repository: string;
  branch: string;
  commit_sha: string;
  commit_message: string;
  author: string;
  created_at: string;
  status: DeploymentStatus;
  ci_run_id: string | null;
  ci_run_url: string | null;
  ci_started_at: string | null;
  ci_finished_at: string | null;
  failure: { stage: string | null; job: string | null; message: string | null } | null;
  change_categories: string[] | null;
  affected_services: string[] | null;
  file_analysis: FileAnalysis[] | null;
  risk_analysis_status: RiskAnalysisStatus | null;
  risk_analysis_error: string | null;
};

/** The risk panel's state. A risk level only ever comes from a stored, validated assessment. */
export type RiskView =
  | {
      state: "assessed";
      assessment: StoredRiskAssessment;
      /** The pipeline status the assessment was based on. */
      basedOnPipeline: string;
      /** Set when the assessment predates the current pipeline state or a refresh failed. */
      note: string | null;
    }
  | { state: "pending" }
  | { state: "unavailable"; error: string | null }
  | { state: "not_analysed" };

export type SelectedDeployment = {
  deployment: DashboardDeployment;
  risk: RiskView;
  incident: Incident | null;
  evidence: {
    /** "assessment": exactly what the risk analysis saw. "database": current structured matches (no analysis yet). */
    source: "assessment" | "database";
    matches: EvidenceMatch[];
  };
};

export type HistoryRow = {
  id: string;
  repository: string;
  branch: string;
  commit_sha: string;
  commit_message: string;
  affected_services: string[] | null;
  change_categories: string[] | null;
  status: DeploymentStatus;
  risk_level: RiskLevel | null;
  risk_analysis_status: RiskAnalysisStatus | null;
  created_at: string;
};

export type DashboardData = {
  selected: SelectedDeployment | null;
  /** True when a specific deployment was requested but does not exist. */
  notFound: boolean;
  history: HistoryRow[];
  incidents: IncidentListItem[];
};

export async function getDashboardData(
  options: {
    deploymentId?: string;
    historyLimit?: number;
    /** Phase 9: the viewer's scope. Everything below is limited to it. */
    scope?: DeploymentScope;
  } = {}
): Promise<DashboardData> {
  const scope: DeploymentScope = options.scope ?? { all: true };
  const [recent, incidents] = await Promise.all([
    listDeployments(options.historyLimit ?? 25, scope),
    listIncidents(20, scope),
  ]);
  const levels = await getLatestRiskLevels(recent.map((d) => d.id));

  const history: HistoryRow[] = recent.map((d) => ({
    id: d.id,
    repository: `${d.owner}/${d.repository}`,
    branch: d.branch,
    commit_sha: d.commit_sha,
    commit_message: firstLine(d.commit_message),
    affected_services: d.affected_services,
    change_categories: d.change_categories,
    status: d.status,
    risk_level: levels.get(d.id) ?? null,
    risk_analysis_status: d.risk_analysis_status,
    created_at: d.created_at.toISOString(),
  }));

  let current: Deployment | null = null;
  if (options.deploymentId) {
    current = await getDeploymentById(options.deploymentId);
    // Someone else's deployment is reported exactly like a missing one.
    if (current && !scope.all && (!current.repository_id || !scope.repositoryIds.includes(current.repository_id))) {
      current = null;
    }
  } else current = recent[0] ?? null;

  return {
    selected: current ? await describe(current) : null,
    notFound: Boolean(options.deploymentId) && !current,
    history,
    incidents,
  };
}

async function describe(d: Deployment): Promise<SelectedDeployment> {
  const [assessment, incident] = await Promise.all([
    getLatestAssessment(d.id),
    d.status === "FAILED" ? getIncidentForDeployment(d.id) : Promise.resolve(null),
  ]);

  // Historical evidence: exactly what the risk analysis saw, when there is one.
  // Otherwise the current structured matches -- database only, no Hindsight.
  let evidence: SelectedDeployment["evidence"];
  if (assessment) {
    evidence = { source: "assessment", matches: assessment.evidence.historical_evidence.matches };
  } else {
    const similar = await findSimilarDeployments(d.id, { useHindsight: false });
    evidence = { source: "database", matches: (similar?.matches ?? []).map(toEvidenceMatch) };
  }

  return { deployment: toDashboardDeployment(d), risk: riskView(d, assessment), incident, evidence };
}

function riskView(d: Deployment, assessment: StoredRiskAssessment | null): RiskView {
  if (!assessment) {
    if (d.risk_analysis_status === "pending") return { state: "pending" };
    if (d.risk_analysis_status === "unavailable") return { state: "unavailable", error: d.risk_analysis_error };
    return { state: "not_analysed" };
  }

  const basedOnPipeline = assessment.evidence.current_pipeline.status;
  let note: string | null = null;
  if (d.risk_analysis_status === "pending") {
    note = `An updated analysis for pipeline state ${d.status} is running.`;
  } else if (d.risk_analysis_status === "unavailable") {
    note = `The latest analysis attempt was unavailable (${d.risk_analysis_error ?? "no detail"}). Showing the most recent valid assessment.`;
  } else if (basedOnPipeline !== d.status) {
    note = `This assessment was made when the pipeline was ${basedOnPipeline}; it is now ${d.status}.`;
  }
  return { state: "assessed", assessment, basedOnPipeline, note };
}

function toDashboardDeployment(d: Deployment): DashboardDeployment {
  return {
    id: d.id,
    repository: `${d.owner}/${d.repository}`,
    branch: d.branch,
    commit_sha: d.commit_sha,
    commit_message: firstLine(d.commit_message),
    author: d.author,
    created_at: d.created_at.toISOString(),
    status: d.status,
    ci_run_id: d.ci_run_id,
    ci_run_url: d.ci_run_url,
    ci_started_at: d.ci_started_at?.toISOString() ?? null,
    ci_finished_at: d.ci_finished_at?.toISOString() ?? null,
    failure:
      d.status === "FAILED" ? { stage: d.failure_stage, job: d.failure_job, message: d.failure_message } : null,
    change_categories: d.change_categories,
    affected_services: d.affected_services,
    file_analysis: d.file_analysis,
    risk_analysis_status: d.risk_analysis_status,
    risk_analysis_error: d.risk_analysis_error,
  };
}

function firstLine(text: string): string {
  return text.split("\n")[0].trim();
}
