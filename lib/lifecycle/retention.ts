import { getPool } from "@/lib/db/client";
import { env } from "@/lib/env";
import { enqueue } from "@/lib/jobs/queue";
import { JOB_TYPES } from "@/lib/jobs/types";
import { purgeDeployments } from "@/lib/lifecycle/purge";
import { writeAudit } from "@/lib/audit/log";

/**
 * Stage 2: retention, enforced by the maintenance run in bounded batches.
 *
 *   DEPLOYGUARD_RETENTION_FAILURE_OUTPUT_DAYS (default 90, 0 = keep forever)
 *     Observed failure output (the redacted log tail) is cleared from the
 *     deployment and its incident after this many days. The deployment, its
 *     outcome, stage and job stay. The Hindsight memories are rewritten without
 *     the output (queued jobs, replace mode).
 *   DEPLOYGUARD_RETENTION_DEPLOYMENT_DAYS (default 0 = keep forever)
 *     Deployments older than this are purged entirely (PostgreSQL + Hindsight).
 */
export type RetentionReport = { failureOutputCleared: number; deploymentsPurged: number; errors: string[] };

export async function applyRetention(limits = { outputBatch: 200, purgeBatch: 50 }): Promise<RetentionReport> {
  const report: RetentionReport = { failureOutputCleared: 0, deploymentsPurged: 0, errors: [] };

  const outputDays = env.retentionFailureOutputDays();
  if (outputDays > 0) {
    const { rows } = await getPool().query<{ id: string; incident: boolean }>(
      `WITH old AS (
         SELECT id FROM deployments
         WHERE failure_message IS NOT NULL AND created_at < now() - make_interval(days => $1)
         ORDER BY created_at LIMIT $2
       ), cleared AS (
         UPDATE deployments d SET failure_message = NULL FROM old WHERE d.id = old.id RETURNING d.id
       ), inc AS (
         UPDATE incidents i SET error_message = NULL FROM cleared WHERE i.deployment_id = cleared.id RETURNING i.deployment_id
       )
       SELECT c.id::text, EXISTS (SELECT 1 FROM inc WHERE inc.deployment_id = c.id) AS incident FROM cleared c`,
      [outputDays, limits.outputBatch]
    );
    for (const r of rows) {
      await enqueue(JOB_TYPES.deploymentMemory, { deploymentId: r.id }, { dedupeKey: `memory.deployment:${r.id}:retention` });
      if (r.incident) await enqueue(JOB_TYPES.incidentMemory, { deploymentId: r.id }, { dedupeKey: `memory.incident:${r.id}:retention` });
    }
    report.failureOutputCleared = rows.length;
    if (rows.length) {
      console.log(`[DeployGuard][retention] Cleared failure output older than ${outputDays} days from ${rows.length} deployment(s).`);
      await writeAudit({ actor: "system", action: "retention.failure_output", outcome: "ok", detail: { deployments: rows.length, days: outputDays } });
    }
  }

  const deploymentDays = env.retentionDeploymentDays();
  if (deploymentDays > 0) {
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id::text FROM deployments WHERE created_at < now() - make_interval(days => $1) ORDER BY created_at LIMIT $2`,
      [deploymentDays, limits.purgeBatch]
    );
    if (rows.length) {
      const purge = await purgeDeployments(rows.map((r) => r.id));
      report.deploymentsPurged = purge.deployments;
      report.errors.push(...purge.errors);
      console.log(`[DeployGuard][retention] Purged ${purge.deployments} deployment(s) older than ${deploymentDays} days.`);
      await writeAudit({
        actor: "system",
        action: "retention.deployments",
        outcome: purge.errors.length ? "failed" : "ok",
        detail: { deployments: purge.deployments, documents: purge.documentsDeleted, days: deploymentDays },
      });
    }
  }
  return report;
}
