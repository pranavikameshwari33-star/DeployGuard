import type { Job } from "@/lib/jobs/queue";
import { JOB_TYPES } from "@/lib/jobs/types";
import { getDeploymentById } from "@/lib/db/deployments";
import { getIncidentForDeployment } from "@/lib/db/incidents";
import { finishDelivery, getDeliveryPayload } from "@/lib/db/webhook-deliveries";
import { retain } from "@/lib/hindsight/client";
import { buildDeploymentMemory } from "@/lib/hindsight/deployment-memory";
import { buildIncidentMemory } from "@/lib/hindsight/incident-memory";
import { processWorkflowRun } from "@/lib/github/app-events";
import { reconcileInstallation } from "@/lib/github/installations";
import { runRiskAnalysis } from "@/lib/risk/auto-risk";

/**
 * Stage 2: what each job type does. Every handler is idempotent -- running it
 * twice (a retry after a lost acknowledgement, a reclaimed job) has the same
 * effect as running it once: memories use document_id + replace, lifecycle
 * updates are guarded by status/ordering checks, analyses reuse stored results.
 *
 * Throw RetryableJobError (or any error) to retry with backoff; throw
 * PermanentJobError to dead-letter at once.
 */
export class RetryableJobError extends Error {}
export class PermanentJobError extends Error {}

type Handler = (job: Job) => Promise<string | void>;

const str = (job: Job, key: string): string => {
  const value = job.payload[key];
  if (typeof value !== "string" || !value) throw new PermanentJobError(`job payload is missing ${key}`);
  return value;
};

export const handlers: Record<string, Handler> = {
  /** GitHub Actions progress -> the lifecycle. Waits for the push by retrying with backoff. */
  [JOB_TYPES.workflowRun]: async (job) => {
    const deliveryId = str(job, "deliveryId");
    const payload = await getDeliveryPayload(deliveryId);
    if (!payload) return "delivery already processed (payload cleared)";
    const result = await processWorkflowRun(payload as Parameters<typeof processWorkflowRun>[0], { waitForPush: false });
    if (result.includes("no deployment recorded") && job.attempts < job.max_attempts) {
      // The push webhook may not have been processed yet: retry later.
      throw new RetryableJobError(`deployment not recorded yet (${result})`);
    }
    await finishDelivery(deliveryId, result.startsWith("ignored") ? "ignored" : "processed");
    return result;
  },

  /** (Re)writes the deployment memory. document_id + replace: idempotent. */
  [JOB_TYPES.deploymentMemory]: async (job) => {
    const deployment = await getDeploymentById(str(job, "deploymentId"));
    if (!deployment) return "deployment no longer exists (purged)";
    await retain(buildDeploymentMemory(deployment));
    return `deployment #${deployment.id} memory stored (${deployment.status})`;
  },

  [JOB_TYPES.incidentMemory]: async (job) => {
    const deployment = await getDeploymentById(str(job, "deploymentId"));
    if (!deployment) return "deployment no longer exists (purged)";
    const incident = await getIncidentForDeployment(deployment.id);
    if (!incident) return "no incident";
    await retain(buildIncidentMemory(incident, deployment));
    return `incident #${incident.id} memory stored`;
  },

  /** Automatic risk analysis. Transient Gemini failures are retried with backoff (bounded). */
  [JOB_TYPES.riskAnalyze]: async (job) => {
    const deploymentId = str(job, "deploymentId");
    const finalAttempt = job.attempts >= job.max_attempts;
    const outcome = await runRiskAnalysis(deploymentId, str(job, "attempt"), String(job.payload.trigger ?? "queue"), finalAttempt);
    if (outcome.retryable && !finalAttempt) {
      throw new RetryableJobError(`risk analysis temporarily unavailable (${outcome.kind})`);
    }
    return outcome.summary;
  },

  /** Re-reads an installation and its repositories from GitHub (e.g. after unsuspend). */
  [JOB_TYPES.installationReconcile]: async (job) => {
    const id = Number(str(job, "installationId"));
    const result = await reconcileInstallation(id);
    return `installation ${id}: ${result.status}${result.repositories !== undefined ? `, ${result.repositories} repositories` : ""}`;
  },
};
