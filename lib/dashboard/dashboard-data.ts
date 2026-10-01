import type { FileAnalysis } from "@/lib/analysis/change-analysis";
import { redactDeep, redactNullable, redactText } from "@/lib/security/redact";
import { safeGithubUrl } from "@/lib/security/untrusted";
import {
  getDeploymentById,
  type Deployment,
  type DeploymentScope,
  type DeploymentStatus,
  type RiskAnalysisStatus,
} from "@/lib/db/deployments";
import { getIncidentForDeployment, type Incident, type IncidentListItem } from "@/lib/db/incidents";
import { historyCounts, listDeploymentsPage, listIncidentsScoped, type HistoryCounts, type ViewScope } from "@/lib/dashboard/queries";
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
  /** Stage 3: the immutable GitHub repository id (switcher context, connection state). */
  github_repository_id: string | null;
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
  | { state: "unavailable"; error: string | null; kind: UnavailableKind }
  | { state: "not_analysed" };

/** Stage 3: why an analysis is unavailable, in words a user can act on. */
export type UnavailableKind = "usage_limit" | "invalid_answer" | "model_unavailable" | "other";

export function unavailableKind(error: string | null): UnavailableKind {
  if (!error) return "other";
  if (/usage limit/i.test(error)) return "usage_limit";
  if (/failed validation|not valid JSON|no output/i.test(error)) return "invalid_answer";
  if (/gemini|could not reach|did not answer|timeout|responded 5dd|rate/i.test(error)) return "model_unavailable";
  return "other";
}

export type SelectedDeployment = {
  deployment: DashboardDeployment;
  risk: RiskView;
  /**
   * Stage 3: whether to OFFER Re-analyze. Only when the result is missing,
   * unavailable or older than the current pipeline state, and the change
   * analysis exists (there is evidence to analyse). Never automatic.
   */
  reanalyze: { offered: boolean; why: string };
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
  /** Stage 3: plain counts over every deployment in the current scope. */
  counts: HistoryCounts;
  /** Stage 3: history paging. */
  page: { offset: number; limit: number; hasMore: boolean };
};

export async function getDashboardData(
  options: {
    deploymentId?: string;
    historyLimit?: number;
    /** Phase 9: the viewer's scope. Everything below is limited to it. */
    scope?: DeploymentScope;
    /** Stage 3: repository switcher -- narrows the scope to one repository (ANDed in SQL). */
    githubRepositoryId?: string | null;
    /** Stage 3: history paging. */
    historyOffset?: number;
  } = {}
): Promise<DashboardData> {
  const scope: DeploymentScope = options.scope ?? { all: true };
  const view: ViewScope = { scope, githubRepositoryId: options.githubRepositoryId ?? null };
  const limit = options.historyLimit ?? 25;
  const offset = Math.max(0, options.historyOffset ?? 0);
  // One extra row tells whether there is an older page.
  const [page, incidents, counts, latest] = await Promise.all([
    listDeploymentsPage(view, limit + 1, offset),
    listIncidentsScoped(view, 20),
    historyCounts(view),
    offset > 0 && !options.deploymentId ? listDeploymentsPage(view, 1, 0) : Promise.resolve(null),
  ]);
  const recent = page.slice(0, limit);
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
  } else current = (latest ?? recent)[0] ?? null;

  // Stage 1: one last redaction pass over everything the page will render
  // (incident output, historical matches, assessment text), covering rows
  // stored before redaction existed.
  return redactDeep({
    selected: current ? await describe(current) : null,
    notFound: Boolean(options.deploymentId) && !current,
    history,
    incidents,
    counts,
    page: { offset, limit, hasMore: page.length > limit },
  }).value;
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

  const risk = riskView(d, assessment);
  return { deployment: toDashboardDeployment(d), risk, incident, evidence, reanalyze: reanalyzeOffer(d, risk) };
}

function reanalyzeOffer(d: Deployment, risk: RiskView): SelectedDeployment["reanalyze"] {
  if (!d.file_analysis) return { offered: false, why: "No change analysis is recorded for this deployment, so there is nothing to analyse." };
  if (d.risk_analysis_status === "pending" || risk.state === "pending") return { offered: false, why: "An analysis is already running." };
  if (risk.state === "not_analysed") return { offered: true, why: "This deployment has not been analysed." };
  if (risk.state === "unavailable") {
    return risk.kind === "usage_limit"
      ? { offered: false, why: "The usage limit for this repository has been reached." }
      : { offered: true, why: "The last analysis attempt was unavailable." };
  }
  if (d.risk_analysis_status === "unavailable" && unavailableKind(d.risk_analysis_error) !== "usage_limit") {
    return { offered: true, why: "The latest refresh was unavailable; the assessment shown is older." };
  }
  if (risk.basedOnPipeline !== d.status) return { offered: true, why: `The assessment was made when the pipeline was ${risk.basedOnPipeline}; it is now ${d.status}.` };
  return { offered: false, why: "The assessment is current for this evidence." };
}

function riskView(d: Deployment, assessment: StoredRiskAssessment | null): RiskView {
  if (!assessment) {
    if (d.risk_analysis_status === "pending") return { state: "pending" };
    if (d.risk_analysis_status === "unavailable") {
      return { state: "unavailable", error: d.risk_analysis_error, kind: unavailableKind(d.risk_analysis_error) };
    }
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
    github_repository_id: d.github_repository_id,
    branch: d.branch,
    commit_sha: d.commit_sha,
    commit_message: firstLine(d.commit_message),
    author: d.author,
    created_at: d.created_at.toISOString(),
    status: d.status,
    ci_run_id: d.ci_run_id,
    // Stage 1: only an https://github.com link can become a link on the page.
    ci_run_url: safeGithubUrl(d.ci_run_url),
    ci_started_at: d.ci_started_at?.toISOString() ?? null,
    ci_finished_at: d.ci_finished_at?.toISOString() ?? null,
    failure:
      d.status === "FAILED"
        ? { stage: redactNullable(d.failure_stage), job: redactNullable(d.failure_job), message: redactNullable(d.failure_message) }
        : null,
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
