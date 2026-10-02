import { getPool, withConnectionRetry } from "@/lib/db/client";
import { deleteDocument, documentExists, recall } from "@/lib/hindsight/client";
import {
  listTrackedDocuments,
  listTrackedDocumentsForDeployments,
  markDocumentsDeleted,
} from "@/lib/hindsight/documents";

/**
 * Stage 2: deleting a tenant's data from BOTH stores, then proving it is gone.
 *
 * Order matters:
 *   1. Hindsight first. Every document DeployGuard wrote (tracked in
 *      memory_documents, plus ids derived from the rows for memories written
 *      before tracking existed) is deleted and then checked to be absent.
 *      If any deletion fails, the purge STOPS before touching PostgreSQL, so
 *      the rows needed to find the documents again still exist and the purge
 *      can simply be repeated.
 *   2. PostgreSQL, in one transaction: queued jobs for these deployments, the
 *      deployments (their incidents and risk assessments go with them), the
 *      webhook delivery log rows of the repository.
 *   3. Verification: no deployment row left, no tracked document left, and a
 *      recall scoped to the repository returns nothing.
 *
 * Disconnecting a repository never calls this. It is an explicit action.
 */

export type PurgeReport = {
  deployments: number;
  documentsDeleted: number;
  documentsAlreadyAbsent: number;
  deliveriesDeleted: number;
  verified: { postgres: boolean; hindsightDocuments: boolean; hindsightRecallEmpty: boolean | null };
  remainingRecallMemories: number | null;
  errors: string[];
};

type Row = { id: string; owner: string; repository: string; branch: string; commit_sha: string; incident_id: string | null };

function derivedDocumentIds(rows: Row[]): string[] {
  return rows.flatMap((r) => [
    `deployment/${r.owner}/${r.repository}/${r.branch}/${r.commit_sha}`,
    `risk/${r.id}`,
    ...(r.incident_id ? [`incident/${r.incident_id}`] : []),
  ]);
}

async function deleteAndVerify(documentIds: string[], report: PurgeReport): Promise<string[]> {
  const deleted: string[] = [];
  const one = async (id: string) => {
    try {
      const result = await deleteDocument(id);
      if (result === "deleted") report.documentsDeleted++;
      else report.documentsAlreadyAbsent++;
      if (await documentExists(id)) report.errors.push(`document ${id} still exists after deletion`);
      else deleted.push(id);
    } catch (error) {
      report.errors.push(`document ${id}: ${(error as Error).message}`);
    }
  };
  // A few at a time: fast enough for hundreds of documents, gentle on the API.
  for (let i = 0; i < documentIds.length; i += 8) await Promise.all(documentIds.slice(i, i + 8).map(one));
  return deleted;
}

async function loadRows(where: string, params: unknown[]): Promise<Row[]> {
  const { rows } = await getPool().query<Row>(
    `SELECT d.id, d.owner, d.repository, d.branch, d.commit_sha, i.id AS incident_id
     FROM deployments d LEFT JOIN incidents i ON i.deployment_id = d.id
     WHERE ${where}`,
    params
  );
  return rows;
}

async function deleteRows(deploymentIds: string[], githubRepositoryId: string | null, report: PurgeReport): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM jobs WHERE status IN ('queued', 'dead') AND payload->>'deploymentId' = ANY($1::text[])`,
      [deploymentIds]
    );
    const d = await client.query(`DELETE FROM deployments WHERE id = ANY($1::bigint[])`, [deploymentIds]);
    report.deployments = d.rowCount ?? 0;
    if (githubRepositoryId) {
      const w = await client.query(`DELETE FROM github_webhook_deliveries WHERE github_repository_id = $1`, [githubRepositoryId]);
      report.deliveriesDeleted = w.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const emptyReport = (): PurgeReport => ({
  deployments: 0,
  documentsDeleted: 0,
  documentsAlreadyAbsent: 0,
  deliveriesDeleted: 0,
  verified: { postgres: false, hindsightDocuments: false, hindsightRecallEmpty: null },
  remainingRecallMemories: null,
  errors: [],
});

/** Purges specific deployments (retention uses this). */
export async function purgeDeployments(deploymentIds: string[]): Promise<PurgeReport> {
  const report = emptyReport();
  if (deploymentIds.length === 0) {
    report.verified = { postgres: true, hindsightDocuments: true, hindsightRecallEmpty: null };
    return report;
  }
  const rows = await loadRows(`d.id = ANY($1::bigint[])`, [deploymentIds]);
  const documents = [...new Set([...(await listTrackedDocumentsForDeployments(deploymentIds)), ...derivedDocumentIds(rows)])];
  const deleted = await deleteAndVerify(documents, report);
  await markDocumentsDeleted(deleted);
  if (report.errors.length) return report; // stop: rows are kept so the purge can be repeated
  await withConnectionRetry(() => deleteRows(rows.map((r) => r.id), null, report));
  const left = await getPool().query(`SELECT count(*)::int AS n FROM deployments WHERE id = ANY($1::bigint[])`, [deploymentIds]);
  report.verified = { postgres: left.rows[0].n === 0, hindsightDocuments: true, hindsightRecallEmpty: null };
  return report;
}

/** Purges everything DeployGuard holds for one repository (by immutable GitHub id). */
export async function purgeRepository(githubRepositoryId: string): Promise<PurgeReport> {
  const report = emptyReport();
  const where = `d.github_repository_id = $1 OR d.repository_id IN (SELECT id FROM repositories WHERE github_repository_id = $1)`;
  const rows = await loadRows(where, [githubRepositoryId]);
  const documents = [...new Set([...(await listTrackedDocuments(githubRepositoryId)), ...derivedDocumentIds(rows)])];

  const deleted = await deleteAndVerify(documents, report);
  await markDocumentsDeleted(deleted);
  if (report.errors.length) return report;

  await withConnectionRetry(() => deleteRows(rows.map((r) => r.id), githubRepositoryId, report));

  // --- verification ---
  const left = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM deployments d WHERE ${where}`,
    [githubRepositoryId]
  );
  const tracked = await listTrackedDocuments(githubRepositoryId);
  report.verified.postgres = left.rows[0].n === 0;
  report.verified.hindsightDocuments = tracked.length === 0;
  try {
    const { results } = await recall("deployment incident risk failure change", { githubRepositoryIds: [githubRepositoryId] });
    report.remainingRecallMemories = results.length;
    report.verified.hindsightRecallEmpty = results.length === 0;
  } catch (error) {
    report.errors.push(`verification recall failed: ${(error as Error).message}`);
  }
  return report;
}

/** Purges a user's repositories, then the account itself (sessions, installation links, user row). */
export async function purgeUser(userId: string): Promise<{ repositories: Record<string, PurgeReport>; accountDeleted: boolean; errors: string[] }> {
  const { rows: repos } = await getPool().query<{ github_repository_id: string }>(
    `SELECT r.github_repository_id::text FROM repositories r
     JOIN github_installations i ON i.installation_id = r.installation_id
     WHERE i.user_id = $1`,
    [userId]
  );
  const out: Record<string, PurgeReport> = {};
  const errors: string[] = [];
  for (const r of repos) {
    out[r.github_repository_id] = await purgeRepository(r.github_repository_id);
    errors.push(...out[r.github_repository_id].errors.map((e) => `${r.github_repository_id}: ${e}`));
  }
  if (errors.length) return { repositories: out, accountDeleted: false, errors };

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const installs = await client.query<{ installation_id: string }>(
      `SELECT installation_id FROM github_installations WHERE user_id = $1`,
      [userId]
    );
    const ids = installs.rows.map((i) => i.installation_id);
    await client.query(`DELETE FROM repositories WHERE installation_id = ANY($1::bigint[])`, [ids]);
    await client.query(`DELETE FROM github_installations WHERE installation_id = ANY($1::bigint[])`, [ids]);
    await client.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return { repositories: out, accountDeleted: false, errors: [`account deletion failed: ${(error as Error).message}`] };
  } finally {
    client.release();
  }
  return { repositories: out, accountDeleted: true, errors };
}

/** The user's own records for one repository, in a portable JSON shape. Text is already redacted. */
export async function exportRepository(githubRepositoryId: string) {
  const pool = getPool();
  const [repo, deployments, incidents, assessments, confirmations, outcomes, reverts] = await Promise.all([
    pool.query(`SELECT github_repository_id::text, full_name, default_branch, private, connected, disconnected_at, created_at
                FROM repositories WHERE github_repository_id = $1`, [githubRepositoryId]),
    pool.query(`SELECT id::text, owner, repository, branch, commit_sha, commit_message, author, changed_files, added_files,
                       modified_files, deleted_files, status, created_at, updated_at, ci_run_url, ci_started_at, ci_finished_at,
                       failure_stage, failure_job, failure_message, change_categories, affected_services, file_analysis,
                       risk_analysis_status, redaction
                FROM deployments WHERE github_repository_id = $1 ORDER BY created_at`, [githubRepositoryId]),
    pool.query(`SELECT i.id::text, i.deployment_id::text, i.failure_type, i.failure_job, i.error_message, i.affected_service,
                       i.downstream_effect, i.root_cause, i.resolution, i.created_at, i.confirmed_revision,
                       i.confirmed_by_login, i.confirmed_at, i.flake_status, i.flake_passing_run_url, i.error_signature
                FROM incidents i JOIN deployments d ON d.id = i.deployment_id
                WHERE d.github_repository_id = $1 ORDER BY i.created_at`, [githubRepositoryId]),
    pool.query(`SELECT a.id::text, a.deployment_id::text, a.risk_level, a.risk_confidence, a.risk_summary, a.risk_reasons,
                       a.historical_evidence, a.missing_information, a.recommended_checks, a.model, a.risk_generated_at
                FROM risk_assessments a JOIN deployments d ON d.id = a.deployment_id
                WHERE d.github_repository_id = $1 ORDER BY a.risk_generated_at`, [githubRepositoryId]),
    // Stage 4: learning records.
    pool.query(`SELECT c.incident_id::text, c.revision, c.root_cause, c.resolution, c.affected_service, c.downstream_effect,
                       c.confirmed_by_login, c.confirmed_at
                FROM incident_confirmations c JOIN incidents i ON i.id = c.incident_id JOIN deployments d ON d.id = i.deployment_id
                WHERE d.github_repository_id = $1 ORDER BY c.incident_id, c.revision`, [githubRepositoryId]),
    pool.query(`SELECT o.deployment_id::text, o.assessment_id::text, o.predicted_level, o.outcome_status, o.result,
                       o.unscored_reason, o.rule_version, o.outcome_at
                FROM risk_outcomes o JOIN deployments d ON d.id = o.deployment_id
                WHERE d.github_repository_id = $1 ORDER BY o.outcome_at`, [githubRepositoryId]),
    pool.query(`SELECT r.reverted_deployment_id::text, r.reverting_deployment_id::text, r.matched_by, r.hours_after, r.detected_at
                FROM deployment_reverts r JOIN deployments d ON d.id = r.reverted_deployment_id
                WHERE d.github_repository_id = $1 ORDER BY r.detected_at`, [githubRepositoryId]),
  ]);
  return {
    format: "deployguard-export/1",
    exported_at: new Date().toISOString(),
    repository: repo.rows[0] ?? { github_repository_id: githubRepositoryId },
    deployments: deployments.rows,
    incidents: incidents.rows,
    risk_assessments: assessments.rows,
    incident_confirmations: confirmations.rows,
    risk_outcomes: outcomes.rows,
    deployment_reverts: reverts.rows,
    notes: [
      "Recalled Hindsight memories are not included: they are derived from these records.",
      "Ingested text (commit messages, CI output) was redacted before it was stored.",
    ],
  };
}
