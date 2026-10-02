import { getPool } from "@/lib/db/client";
import type { Deployment, DeploymentScope } from "@/lib/db/deployments";
import { ACCURACY_RULE_VERSION, choosePrediction, scoreOutcome, type OutcomeScore, type PredictionCandidate } from "@/lib/learning/accuracy";
import { parseRevert } from "@/lib/learning/revert";

/**
 * Stage 4: the learning records. PostgreSQL only -- these are facts derived
 * from recorded rows, never from Hindsight or Gemini.
 */

/** Same scope rule as the dashboard: $1 = all?, $2 = owned repository ids, $3 = repository filter. */
export type LearningScope = { scope: DeploymentScope; githubRepositoryId: string | null };
const SCOPE_SQL = `($1::boolean OR d.repository_id = ANY($2::bigint[])) AND ($3::bigint IS NULL OR d.github_repository_id = $3::bigint)`;
const scopeParams = (v: LearningScope) => [v.scope.all, v.scope.all ? [] : v.scope.repositoryIds, v.githubRepositoryId];

// ---------------------------------------------------------------------------
// 4.2 Risk accuracy
// ---------------------------------------------------------------------------

/**
 * Records how the prediction for this deployment compares with its final CI
 * outcome. Append-only: a repeated report of the same outcome adds nothing; a
 * changed outcome (re-run) adds a new row. The deployment row lock serialises
 * concurrent reports.
 */
export async function recordRiskOutcome(deployment: Deployment): Promise<OutcomeScore | null> {
  if (deployment.status !== "SUCCESS" && deployment.status !== "FAILED") return null;
  const outcomeAt = deployment.ci_finished_at ?? deployment.updated_at;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM deployments WHERE id = $1 FOR UPDATE`, [deployment.id]);
    const last = await client.query<{ outcome_status: string }>(
      `SELECT outcome_status FROM risk_outcomes WHERE deployment_id = $1 ORDER BY scored_at DESC, id DESC LIMIT 1`,
      [deployment.id]
    );
    if (last.rows[0]?.outcome_status === deployment.status) {
      await client.query("COMMIT");
      return null;
    }
    const candidates = await client.query<PredictionCandidate>(
      `SELECT id, risk_level, risk_generated_at, evidence -> 'current_pipeline' ->> 'status' AS based_on_pipeline
       FROM risk_assessments WHERE deployment_id = $1`,
      [deployment.id]
    );
    const score = scoreOutcome(choosePrediction(candidates.rows, outcomeAt), deployment.status);
    await client.query(
      `INSERT INTO risk_outcomes (deployment_id, assessment_id, predicted_level, outcome_status, result,
                                  unscored_reason, rule_version, outcome_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (deployment_id, outcome_status, outcome_at) DO NOTHING`,
      [deployment.id, score.assessment_id, score.predicted_level, deployment.status, score.result,
       score.unscored_reason, ACCURACY_RULE_VERSION, outcomeAt]
    );
    await client.query("COMMIT");
    return score;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export type AccuracyRow = {
  deployment_id: string;
  repository: string;
  commit_sha: string;
  commit_message: string;
  assessment_id: string | null;
  predicted_level: string | null;
  outcome_status: "SUCCESS" | "FAILED";
  result: "hit" | "miss" | "false_alarm" | "unscored";
  unscored_reason: string | null;
  outcome_at: Date;
};

export type AccuracyRecord = {
  counts: { hit: number; miss: number; false_alarm: number; unscored: number; scored: number; total: number };
  /** predicted level (or "none") x outcome, raw counts. */
  matrix: Record<string, { SUCCESS: number; FAILED: number }>;
  rows: AccuracyRow[];
  ruleVersion: string;
};

/** The plain per-scope record: the newest outcome row of each deployment, counted. */
export async function getAccuracyRecord(v: LearningScope, listLimit = 25): Promise<AccuracyRecord> {
  const { rows } = await getPool().query<AccuracyRow>(
    `SELECT DISTINCT ON (o.deployment_id)
            o.deployment_id::text, d.owner || '/' || d.repository AS repository, d.commit_sha,
            split_part(d.commit_message, E'\\n', 1) AS commit_message,
            o.assessment_id::text, o.predicted_level, o.outcome_status, o.result, o.unscored_reason, o.outcome_at
     FROM risk_outcomes o JOIN deployments d ON d.id = o.deployment_id
     WHERE ${SCOPE_SQL}
     ORDER BY o.deployment_id, o.scored_at DESC, o.id DESC`,
    scopeParams(v)
  );
  const counts = { hit: 0, miss: 0, false_alarm: 0, unscored: 0, scored: 0, total: rows.length };
  const matrix: AccuracyRecord["matrix"] = {};
  for (const r of rows) {
    counts[r.result]++;
    if (r.result !== "unscored") counts.scored++;
    const key = r.predicted_level ?? "none";
    matrix[key] ??= { SUCCESS: 0, FAILED: 0 };
    matrix[key][r.outcome_status]++;
  }
  rows.sort((a, b) => b.outcome_at.getTime() - a.outcome_at.getTime());
  return { counts, matrix, rows: rows.slice(0, listLimit), ruleVersion: ACCURACY_RULE_VERSION };
}

// ---------------------------------------------------------------------------
// 4.5 Revert detection
// ---------------------------------------------------------------------------

export type RevertLink = { reverted_deployment_id: string; matched_by: "reverted_sha" | "revert_title"; hours_after: number };

/**
 * If this newly recorded deployment is a revert of an earlier deployment of the
 * SAME repository (ownership boundary included) recorded within the window,
 * attaches it to that deployment as an observed signal.
 */
export async function detectRevert(deployment: Deployment, windowHours: number): Promise<RevertLink | null> {
  const ref = parseRevert(deployment.commit_message);
  if (!ref || windowHours <= 0) return null;
  const { rows } = await getPool().query<{ id: string; matched_by: RevertLink["matched_by"]; hours_after: string }>(
    `SELECT d.id,
            CASE WHEN $5::text IS NOT NULL AND d.commit_sha LIKE $5 || '%' THEN 'reverted_sha' ELSE 'revert_title' END AS matched_by,
            round((extract(epoch FROM ($4::timestamptz - d.created_at)) / 3600)::numeric, 2) AS hours_after
     FROM deployments d
     WHERE d.owner = $1 AND d.repository = $2
       AND d.repository_id IS NOT DISTINCT FROM $3::bigint
       AND d.id <> $7
       AND d.created_at <= $4 AND d.created_at >= $4::timestamptz - make_interval(hours => $8)
       AND (($5::text IS NOT NULL AND d.commit_sha LIKE $5 || '%')
            OR ($5::text IS NULL AND $6::text IS NOT NULL AND split_part(d.commit_message, E'\\n', 1) = $6))
     ORDER BY d.created_at DESC, d.id DESC LIMIT 1`,
    [deployment.owner, deployment.repository, deployment.repository_id, deployment.created_at, ref.sha, ref.title, deployment.id, windowHours]
  );
  const target = rows[0];
  if (!target) return null;
  await getPool().query(
    `INSERT INTO deployment_reverts (reverted_deployment_id, reverting_deployment_id, matched_by, hours_after)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [target.id, deployment.id, target.matched_by, target.hours_after]
  );
  return { reverted_deployment_id: target.id, matched_by: target.matched_by, hours_after: Number(target.hours_after) };
}

export type RevertFacts = {
  /** This deployment was reverted by a later one. */
  reverted_by: { deployment_id: string; hours_after: number; matched_by: string } | null;
  /** This deployment is itself a revert of an earlier one. */
  reverts: { deployment_id: string; hours_after: number; matched_by: string } | null;
};

export async function getRevertFacts(deploymentId: string): Promise<RevertFacts> {
  const { rows } = await getPool().query<{ kind: "by" | "of"; deployment_id: string; hours_after: string; matched_by: string }>(
    `(SELECT 'by' AS kind, reverting_deployment_id::text AS deployment_id, hours_after, matched_by
      FROM deployment_reverts WHERE reverted_deployment_id = $1 ORDER BY detected_at LIMIT 1)
     UNION ALL
     (SELECT 'of', reverted_deployment_id::text, hours_after, matched_by
      FROM deployment_reverts WHERE reverting_deployment_id = $1 ORDER BY detected_at LIMIT 1)`,
    [deploymentId]
  );
  const pick = (kind: "by" | "of") => {
    const r = rows.find((x) => x.kind === kind);
    return r ? { deployment_id: r.deployment_id, hours_after: Number(r.hours_after), matched_by: r.matched_by } : null;
  };
  return { reverted_by: pick("by"), reverts: pick("of") };
}

/** Deployment ids (of the given ones) that were reverted, for history tables. */
export async function revertedDeploymentIds(deploymentIds: string[]): Promise<Set<string>> {
  if (deploymentIds.length === 0) return new Set();
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT DISTINCT reverted_deployment_id::text AS id FROM deployment_reverts WHERE reverted_deployment_id = ANY($1::bigint[])`,
    [deploymentIds]
  );
  return new Set(rows.map((r) => r.id));
}

/** Deployment ids (of the given ones) whose incident is a probable flake. */
export async function flakyDeploymentIds(deploymentIds: string[]): Promise<Set<string>> {
  if (deploymentIds.length === 0) return new Set();
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT deployment_id::text AS id FROM incidents WHERE deployment_id = ANY($1::bigint[]) AND flake_status IS NOT NULL`,
    [deploymentIds]
  );
  return new Set(rows.map((r) => r.id));
}

// ---------------------------------------------------------------------------
// 4.3 Recurring failure patterns
// ---------------------------------------------------------------------------

export type PatternDimension = "error_signature" | "failed_stage" | "component" | "category";

export type FailurePattern = {
  dimension: PatternDimension;
  value: string;
  github_repository_id: string | null;
  repository: string;
  /** Incidents in the window that are NOT probable flakes. */
  count: number;
  /** Probable flakes with the same value, left out of the count. */
  flakes_excluded: number;
  incident_ids: string[];
  deployment_ids: string[];
  first_at: Date;
  last_at: Date;
};

/** Change categories that say nothing about WHICH part of the system changed (same list as similarity). */
const UNINFORMATIVE = ["application_code", "tests", "documentation", "unknown"];

/**
 * Repeated failures within `windowDays`, grouped per repository by normalised
 * error signature, failed stage, component and change category. Computed by
 * PostgreSQL from incident and deployment rows; a pattern is an OBSERVATION
 * (these incidents share this value), never a statement about cause.
 */
export async function findFailurePatterns(v: LearningScope, options: { windowDays?: number; minCount?: number; limit?: number } = {}): Promise<FailurePattern[]> {
  const { rows } = await getPool().query<FailurePattern>(
    `WITH inc AS (
       SELECT i.id, i.deployment_id, i.failure_type, i.error_signature, i.affected_service,
              i.confirmed_revision, i.flake_status, i.created_at,
              d.github_repository_id, d.owner || '/' || d.repository AS repository,
              d.affected_services, d.change_categories
       FROM incidents i JOIN deployments d ON d.id = i.deployment_id
       WHERE ${SCOPE_SQL} AND i.created_at > now() - make_interval(days => $4)
     ),
     dims AS (
       SELECT 'error_signature' AS dimension, error_signature AS value, id, deployment_id, flake_status, created_at, github_repository_id, repository
       FROM inc WHERE error_signature IS NOT NULL
       UNION ALL
       SELECT 'failed_stage', failure_type, id, deployment_id, flake_status, created_at, github_repository_id, repository FROM inc
       UNION ALL
       -- A human-confirmed affected service wins over the path-derived components.
       SELECT 'component', s, id, deployment_id, flake_status, created_at, github_repository_id, repository
       FROM inc, unnest(CASE WHEN confirmed_revision IS NOT NULL AND affected_service IS NOT NULL
                             THEN ARRAY[affected_service] ELSE COALESCE(affected_services, '{}') END) AS s
       UNION ALL
       SELECT 'category', c, id, deployment_id, flake_status, created_at, github_repository_id, repository
       FROM inc, unnest(COALESCE(change_categories, '{}')) AS c
       WHERE NOT (c = ANY($6::text[]))
     )
     SELECT dimension, value, github_repository_id::text, min(repository) AS repository,
            count(*) FILTER (WHERE flake_status IS NULL)::int AS count,
            count(*) FILTER (WHERE flake_status IS NOT NULL)::int AS flakes_excluded,
            array_agg(id::text ORDER BY created_at DESC) FILTER (WHERE flake_status IS NULL) AS incident_ids,
            array_agg(deployment_id::text ORDER BY created_at DESC) FILTER (WHERE flake_status IS NULL) AS deployment_ids,
            min(created_at) FILTER (WHERE flake_status IS NULL) AS first_at,
            max(created_at) FILTER (WHERE flake_status IS NULL) AS last_at
     FROM dims
     GROUP BY dimension, value, github_repository_id
     HAVING count(*) FILTER (WHERE flake_status IS NULL) >= $5
     ORDER BY count DESC, last_at DESC
     LIMIT $7`,
    [...scopeParams(v), options.windowDays ?? 60, options.minCount ?? 2, UNINFORMATIVE, options.limit ?? 20]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// 4.6 Ask your history: the record search
// ---------------------------------------------------------------------------

export type HistorySearchRow = {
  deployment_id: string;
  repository: string;
  branch: string;
  commit_sha: string;
  commit_message: string;
  status: string;
  created_at: Date;
  failure_stage: string | null;
  incident_id: string | null;
  failure_type: string | null;
  error_message: string | null;
  root_cause: string | null;
  resolution: string | null;
  confirmed_by_login: string | null;
  confirmed_at: Date | null;
  flake_status: string | null;
  reverted_by: string | null;
  hits: number;
  matched: number[];
  nominated: boolean;
};

/**
 * Deployments (with their incident) in scope whose recorded text matches the
 * question's keyword groups. `patterns`/`groups` are parallel arrays (ILIKE
 * pattern, keyword group index). Every record needs `minHits` groups, whether
 * or not Hindsight nominated it: memory may rank a match, never create one.
 * Human-confirmed fields are searched only when confirmed.
 */
export async function searchHistory(
  v: LearningScope,
  q: { patterns: string[]; groups: number[]; minHits: number; nominatedDeployments: string[]; nominatedIncidents: string[]; limit: number }
): Promise<HistorySearchRow[]> {
  const { rows } = await getPool().query<HistorySearchRow>(
    `SELECT d.id::text AS deployment_id, d.owner || '/' || d.repository AS repository, d.branch, d.commit_sha,
            split_part(d.commit_message, E'\\n', 1) AS commit_message, d.status, d.created_at, d.failure_stage,
            i.id::text AS incident_id, i.failure_type, i.error_message,
            CASE WHEN i.confirmed_revision IS NOT NULL THEN i.root_cause END AS root_cause,
            CASE WHEN i.confirmed_revision IS NOT NULL THEN i.resolution END AS resolution,
            i.confirmed_by_login, i.confirmed_at, i.flake_status,
            rv.reverting_deployment_id::text AS reverted_by,
            m.hits, m.matched,
            (d.id = ANY($7::bigint[]) OR i.id = ANY($8::bigint[])) AS nominated
     FROM deployments d
     LEFT JOIN incidents i ON i.deployment_id = d.id
     LEFT JOIN LATERAL (
       SELECT r.reverting_deployment_id FROM deployment_reverts r WHERE r.reverted_deployment_id = d.id ORDER BY r.detected_at LIMIT 1
     ) rv ON true
     CROSS JOIN LATERAL (
       SELECT count(DISTINCT k.g)::int AS hits, COALESCE(array_agg(DISTINCT k.g), '{}') AS matched
       FROM unnest($4::text[], $5::int[]) AS k(p, g)
       WHERE concat_ws(' ', d.commit_message, d.branch, d.status, d.failure_stage, d.failure_job,
                       array_to_string(d.changed_files, ' '), array_to_string(d.affected_services, ' '),
                       array_to_string(d.change_categories, ' '), i.failure_type, i.failure_job, i.error_message,
                       i.error_signature, i.flake_status,
                       CASE WHEN i.confirmed_revision IS NOT NULL
                            THEN concat_ws(' ', i.root_cause, i.resolution, i.affected_service, i.downstream_effect) END,
                       CASE WHEN rv.reverting_deployment_id IS NOT NULL THEN 'reverted revert' END) ILIKE k.p
     ) m
     WHERE ${SCOPE_SQL}
       -- Every record must match the question itself; being nominated by memory only ranks it higher.
       AND m.hits >= $6
     ORDER BY m.hits DESC, nominated DESC, d.created_at DESC, d.id DESC
     LIMIT $9`,
    [...scopeParams(v), q.patterns, q.groups, q.minHits, q.nominatedDeployments, q.nominatedIncidents, q.limit]
  );
  return rows;
}

// ---------------------------------------------------------------------------
// 4.1 Re-evaluation after a confirmed cause changes
// ---------------------------------------------------------------------------

/**
 * Deployments whose LATEST assessment used this incident as evidence (as the
 * current failure or as a historical match), within the incident's own
 * repository, newest first, bounded. Only deployments under automatic analysis
 * (risk_analysis_status set) are re-evaluated, like the CI refresh.
 */
export async function dependentDeployments(incidentId: string, limit: number): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `WITH owner AS (
       SELECT d.repository_id, d.owner, d.repository FROM incidents i JOIN deployments d ON d.id = i.deployment_id WHERE i.id = $1
     )
     SELECT d.id::text FROM deployments d, owner o,
     LATERAL (SELECT a.evidence FROM risk_assessments a WHERE a.deployment_id = d.id
              ORDER BY a.risk_generated_at DESC, a.id DESC LIMIT 1) a
     WHERE d.repository_id IS NOT DISTINCT FROM o.repository_id AND d.owner = o.owner AND d.repository = o.repository
       AND d.risk_analysis_status IS NOT NULL
       AND (a.evidence -> 'current_pipeline' -> 'incident' ->> 'id' = $1::text
            OR EXISTS (SELECT 1 FROM jsonb_array_elements(a.evidence -> 'historical_evidence' -> 'matches') m
                       WHERE m -> 'incident' ->> 'id' = $1::text))
     ORDER BY d.created_at DESC, d.id DESC LIMIT $2`,
    [incidentId, limit]
  );
  return rows.map((r) => r.id);
}
