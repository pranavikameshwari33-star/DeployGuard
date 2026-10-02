import { writeAudit } from "@/lib/audit/log";
import { confirmIncident, getIncidentById, type ConfirmResult } from "@/lib/db/incidents";
import { dependentDeployments } from "@/lib/db/learning";
import { enqueue } from "@/lib/jobs/queue";
import { kickQueue } from "@/lib/jobs/runner";
import { JOB_TYPES } from "@/lib/jobs/types";
import type { ConfirmationInput } from "@/lib/learning/confirmation";
import { scheduleRiskAnalysis } from "@/lib/risk/auto-risk";
import type { RedactionSummary } from "@/lib/security/redact";

/**
 * Stage 4.1: recording a human-confirmed root cause / resolution, and what
 * follows from it:
 *
 *   1. append a revision + mirror it on the incident (PostgreSQL, attributed)
 *   2. audit-log it (ids and revision only, never the text)
 *   3. queue the incident memory rewrite (Hindsight, same document_id, replace)
 *   4. queue ONE re-evaluation job for this revision, delayed so that a burst
 *      of edits collapses into a single re-evaluation (older revisions' jobs
 *      see they were superseded and do nothing)
 */

/** Seconds to wait before re-evaluating, so quick successive edits are evaluated once. */
export const REEVALUATE_DELAY_SECONDS = 120;
/** Upper bound on deployments re-analysed per confirmation change. */
export const REEVALUATE_MAX_DEPLOYMENTS = 5;

export async function recordConfirmation(input: {
  incidentId: string;
  value: ConfirmationInput;
  redaction: RedactionSummary | null;
  user: { id: string; login: string };
  githubRepositoryId: string | null;
  deploymentId: string;
  baseRevision?: number;
}): Promise<ConfirmResult> {
  const result = await confirmIncident(input.incidentId, input.value, { userId: input.user.id, login: input.user.login }, input.redaction, input.baseRevision);
  const actor = `user:${input.user.id}`;
  if (result.outcome !== "confirmed") {
    if (result.outcome === "conflict") {
      await writeAudit({ actor, action: "incident.confirm", githubRepositoryId: input.githubRepositoryId, outcome: "refused", detail: { incident_id: input.incidentId, reason: "revision conflict" } });
    }
    return result;
  }

  await writeAudit({
    actor,
    action: "incident.confirm",
    githubRepositoryId: input.githubRepositoryId,
    outcome: "ok",
    detail: {
      incident_id: input.incidentId,
      revision: result.revision,
      fields: (Object.keys(input.value) as (keyof ConfirmationInput)[]).filter((k) => input.value[k] !== null),
      redacted: input.redaction?.count ?? 0,
    },
  });

  try {
    await enqueue(JOB_TYPES.incidentMemory, { deploymentId: input.deploymentId }, {
      dedupeKey: `memory.incident:${input.deploymentId}:confirmed:${result.revision}`,
      maxAttempts: 6,
    });
    await enqueue(JOB_TYPES.learningReevaluate, { incidentId: input.incidentId, revision: String(result.revision) }, {
      dedupeKey: `learning.reevaluate:incident:${input.incidentId}:${result.revision}`,
      maxAttempts: 3,
      delaySeconds: REEVALUATE_DELAY_SECONDS,
    });
  } catch (error) {
    // The confirmation itself is stored; the follow-ups can be re-queued by saving again.
    console.error(`[DeployGuard][learning] Could not queue follow-ups for incident #${input.incidentId}: ${(error as Error).message}`);
  }
  kickQueue();
  return result;
}

/** The re-evaluation job: superseded revisions do nothing; otherwise a bounded set of dependents is re-analysed. */
export async function runReevaluation(incidentId: string, revision: number): Promise<string> {
  const incident = await getIncidentById(incidentId);
  if (!incident) return "incident no longer exists";
  if (incident.confirmed_revision !== revision) return `superseded by revision ${incident.confirmed_revision}`;
  const deployments = await dependentDeployments(incidentId, REEVALUATE_MAX_DEPLOYMENTS);
  let scheduled = 0;
  for (const id of deployments) {
    // The normal controlled path: queued, deduplicated, usage caps apply, and the
    // changed evidence fingerprint means one new assessment per deployment.
    if (await scheduleRiskAnalysis(id, `confirmed cause changed (incident #${incidentId} r${revision})`)) scheduled++;
  }
  return `revision ${revision}: ${scheduled} dependent deployment(s) re-evaluated (max ${REEVALUATE_MAX_DEPLOYMENTS})`;
}
