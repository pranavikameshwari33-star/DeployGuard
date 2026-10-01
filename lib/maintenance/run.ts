import { listInstallationsForReconcile, listMonitoredRepositories, purgeExpiredSessions } from "@/lib/db/accounts";
import { listStaleOwnedDeployments, listStuckRiskAnalyses } from "@/lib/db/deployments";
import { getPool } from "@/lib/db/client";
import { listOrphanedDeliveries, pruneDeliveries } from "@/lib/db/webhook-deliveries";
import { recoverMissedPushes, refreshDeploymentFromActions } from "@/lib/github/app-events";
import { reconcileInstallation } from "@/lib/github/installations";
import { scheduleRiskAnalysis } from "@/lib/risk/auto-risk";
import { enqueue, pruneSucceeded, queueStats, reclaimStuck, type QueueStats } from "@/lib/jobs/queue";
import { JOB_TYPES } from "@/lib/jobs/types";
import { drainQueue, type DrainReport } from "@/lib/jobs/runner";
import { applyRetention, type RetentionReport } from "@/lib/lifecycle/retention";

/**
 * Phase 10: the maintenance / reconciliation run.
 *
 * DeployGuard is event-driven, but events can be lost: GitHub does not
 * redeliver failed webhooks automatically, and after() work can be cut off by
 * a serverless time limit. This run repairs that, in bounded steps:
 *
 *   1. housekeeping      expired sessions, old rate-limit windows, old delivery logs
 *   2. queue             reclaim jobs of dead workers; re-queue deliveries whose job was lost
 *                        (Stage 2: deferred work runs as jobs with retries + dead-letter)
 *   3. installations     re-read status + repository list from GitHub (uninstall,
 *                        suspension, added/removed repositories)
 *   4. missed pushes     push-triggered workflow runs whose push never arrived
 *   5. stale pipelines   deployments stuck in RECEIVED/BUILDING -> state from GitHub Actions
 *   6. stuck analyses    automatic risk analyses left "pending" with no live job -> queued again
 *   7. retention         failure output / old deployments past their retention period
 *   8. drain             process queued jobs with the remaining time budget
 *
 * Every step has a count limit and the whole run a time budget, so it fits a
 * serverless invocation; the next run continues where this one stopped. It is
 * safe to run concurrently or repeatedly: every write it makes is idempotent.
 * It only ever uses the GitHub App's installation tokens, so it never reads a
 * repository outside what each installation was granted.
 *
 * Triggered by POST /api/maintenance/run (internal token), e.g. from a scheduler.
 */

export type MaintenanceReport = {
  startedAt: string;
  durationMs: number;
  budgetExhausted: boolean;
  sessionsPurged: number;
  rateLimitRowsPurged: number;
  deliveriesPruned: number;
  jobsReclaimed: { requeued: number; dead: number };
  jobsPruned: number;
  deliveriesRequeued: string[];
  installations: { installationId: number; status: string; repositories?: number; note?: string }[];
  recoveredDeployments: string[];
  stalePipelines: { deploymentId: string; result: string }[];
  resumedRiskAnalyses: string[];
  retention: RetentionReport | null;
  drain: DrainReport | null;
  queue: QueueStats | null;
  errors: string[];
};

const LIMITS = {
  deliveries: 10,
  installations: 10,
  reposPerInstallation: 10,
  recoverHours: 24,
  recoverPerRepo: 5,
  staleMinutes: 15,
  staleMaxAgeHours: 72,
  stalePipelines: 10,
  stuckRiskMinutes: 10,
  stuckRisk: 3,
};

export async function runMaintenance(options: { budgetMs?: number } = {}): Promise<MaintenanceReport> {
  const started = Date.now();
  const budgetMs = options.budgetMs ?? 50_000;
  const timeLeft = () => budgetMs - (Date.now() - started) > 5_000;
  const report: MaintenanceReport = {
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    budgetExhausted: false,
    sessionsPurged: 0,
    rateLimitRowsPurged: 0,
    deliveriesPruned: 0,
    jobsReclaimed: { requeued: 0, dead: 0 },
    jobsPruned: 0,
    deliveriesRequeued: [],
    installations: [],
    recoveredDeployments: [],
    stalePipelines: [],
    resumedRiskAnalyses: [],
    retention: null,
    drain: null,
    queue: null,
    errors: [],
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    if (!timeLeft()) {
      report.budgetExhausted = true;
      return;
    }
    try {
      await fn();
    } catch (error) {
      report.errors.push(`${name}: ${(error as Error).message}`);
      console.error(`[DeployGuard][maintenance] ${name} failed: ${(error as Error).message}`);
    }
  };

  // 1. housekeeping
  await step("sessions", async () => {
    for (let i = 0; i < 5; i++) {
      const n = await purgeExpiredSessions(1000);
      report.sessionsPurged += n;
      if (n < 1000) break;
    }
  });
  await step("rate limits", async () => {
    const r = await getPool().query(
      `DELETE FROM rate_limits WHERE ctid IN (SELECT ctid FROM rate_limits WHERE window_start < now() - interval '1 day' LIMIT 5000)`
    );
    report.rateLimitRowsPurged = r.rowCount ?? 0;
  });
  await step("delivery log", async () => {
    report.deliveriesPruned = await pruneDeliveries();
  });

  await step("jobs housekeeping", async () => {
    report.jobsPruned = await pruneSucceeded();
  });

  // 2. the queue: jobs of workers that died, deliveries whose job was lost
  await step("reclaim jobs", async () => {
    report.jobsReclaimed = await reclaimStuck();
  });
  await step("orphaned deliveries", async () => {
    for (const d of await listOrphanedDeliveries(LIMITS.deliveries)) {
      if (d.event !== "workflow_run") continue;
      await enqueue(JOB_TYPES.workflowRun, { deliveryId: d.delivery_id }, { dedupeKey: `webhook:${d.delivery_id}`, maxAttempts: 8 });
      report.deliveriesRequeued.push(d.delivery_id);
    }
  });

  // 3-4. installations, repositories, missed pushes
  await step("installations", async () => {
    for (const inst of await listInstallationsForReconcile(LIMITS.installations)) {
      if (!timeLeft()) break;
      const installationId = Number(inst.installation_id);
      const result = await reconcileInstallation(installationId);
      report.installations.push(result);
      if (result.status !== "active") continue;

      for (const repo of (await listMonitoredRepositories(installationId)).slice(0, LIMITS.reposPerInstallation)) {
        if (!timeLeft()) break;
        try {
          const { recovered } = await recoverMissedPushes(installationId, repo, {
            sinceHours: LIMITS.recoverHours,
            maxPushes: LIMITS.recoverPerRepo,
          });
          report.recoveredDeployments.push(...recovered);
        } catch (error) {
          report.errors.push(`recover ${repo.full_name}: ${(error as Error).message}`);
        }
      }
    }
  });

  // 5. pipelines whose outcome never arrived
  await step("stale pipelines", async () => {
    for (const d of await listStaleOwnedDeployments(LIMITS.staleMinutes, LIMITS.staleMaxAgeHours, LIMITS.stalePipelines)) {
      if (!timeLeft()) break;
      try {
        const result = await refreshDeploymentFromActions(d, Number(d.installation_id), d.full_name);
        report.stalePipelines.push({ deploymentId: d.id, result });
      } catch (error) {
        report.stalePipelines.push({ deploymentId: d.id, result: `failed: ${(error as Error).message}` });
      }
    }
  });

  // 6. automatic risk analyses left "pending" with no queued/running job
  // (their job was lost or dead-lettered). A fresh attempt is queued; stored
  // assessment reuse means no duplicate Gemini call if the lost one finished.
  await step("stuck risk analyses", async () => {
    for (const id of await listStuckRiskAnalyses(LIMITS.stuckRiskMinutes, LIMITS.stuckRisk)) {
      if (!timeLeft()) break;
      if (await scheduleRiskAnalysis(id, "maintenance resume")) report.resumedRiskAnalyses.push(id);
    }
  });

  // 7. retention
  await step("retention", async () => {
    report.retention = await applyRetention();
  });

  // 8. drain the queue with whatever budget is left
  await step("drain queue", async () => {
    const remaining = budgetMs - (Date.now() - started);
    report.drain = await drainQueue({ budgetMs: Math.max(0, remaining - 2_000), maxJobs: 100 });
  });
  await step("queue stats", async () => {
    report.queue = await queueStats();
  });

  report.durationMs = Date.now() - started;
  console.log(
    `[DeployGuard][maintenance] Done in ${report.durationMs} ms: ${report.installations.length} installation(s), ` +
      `${report.recoveredDeployments.length} recovered push(es), ${report.stalePipelines.length} stale pipeline(s), ` +
      `${report.deliveriesRequeued.length} re-queued delivery(ies), ${report.drain?.processed ?? 0} job(s) run, ` +
      `${report.queue?.dead ?? 0} dead-lettered job(s), ${report.resumedRiskAnalyses.length} resumed analysis(es), ` +
      `${report.errors.length} error(s).`
  );
  return report;
}
