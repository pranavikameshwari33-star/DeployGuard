import { listInstallationsForReconcile, listMonitoredRepositories, purgeExpiredSessions } from "@/lib/db/accounts";
import { listStaleOwnedDeployments, listStuckRiskAnalyses } from "@/lib/db/deployments";
import { getPool } from "@/lib/db/client";
import { claimRetry, finishDelivery, listRetryableDeliveries, pruneDeliveries } from "@/lib/db/webhook-deliveries";
import { processWorkflowRun, recoverMissedPushes, refreshDeploymentFromActions } from "@/lib/github/app-events";
import { reconcileInstallation } from "@/lib/github/installations";
import { startRiskAnalysis } from "@/lib/db/deployments";
import { runRiskAnalysis } from "@/lib/risk/auto-risk";

/**
 * Phase 10: the maintenance / reconciliation run.
 *
 * DeployGuard is event-driven, but events can be lost: GitHub does not
 * redeliver failed webhooks automatically, and after() work can be cut off by
 * a serverless time limit. This run repairs that, in bounded steps:
 *
 *   1. housekeeping      expired sessions, old rate-limit windows, old delivery logs
 *   2. retry deliveries  workflow_run work that never finished (payload kept in the log)
 *   3. installations     re-read status + repository list from GitHub (uninstall,
 *                        suspension, added/removed repositories)
 *   4. missed pushes     push-triggered workflow runs whose push never arrived
 *   5. stale pipelines   deployments stuck in RECEIVED/BUILDING -> state from GitHub Actions
 *   6. stuck analyses    automatic risk analyses left "pending" -> run again
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
  deliveriesRetried: { deliveryId: string; result: string }[];
  installations: { installationId: number; status: string; repositories?: number; note?: string }[];
  recoveredDeployments: string[];
  stalePipelines: { deploymentId: string; result: string }[];
  resumedRiskAnalyses: string[];
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
    deliveriesRetried: [],
    installations: [],
    recoveredDeployments: [],
    stalePipelines: [],
    resumedRiskAnalyses: [],
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

  // 2. unfinished deferred webhook work
  await step("retry deliveries", async () => {
    for (const d of await listRetryableDeliveries(LIMITS.deliveries)) {
      if (!timeLeft()) break;
      if (d.event !== "workflow_run" || !(await claimRetry(d.delivery_id))) continue;
      try {
        const result = await processWorkflowRun(d.payload as Parameters<typeof processWorkflowRun>[0]);
        await finishDelivery(d.delivery_id, result.startsWith("ignored") ? "ignored" : "processed");
        report.deliveriesRetried.push({ deliveryId: d.delivery_id, result });
      } catch (error) {
        await finishDelivery(d.delivery_id, "failed", (error as Error).message);
        report.deliveriesRetried.push({ deliveryId: d.delivery_id, result: `failed: ${(error as Error).message}` });
      }
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

  // 6. automatic risk analyses whose after() callback was lost. Runs inline
  // (awaited), so it is not lost again. The stored-assessment reuse means no
  // duplicate Gemini call if the lost attempt had actually finished.
  await step("stuck risk analyses", async () => {
    for (const id of await listStuckRiskAnalyses(LIMITS.stuckRiskMinutes, LIMITS.stuckRisk)) {
      if (!timeLeft()) break;
      const attempt = await startRiskAnalysis(id);
      await runRiskAnalysis(id, attempt, "maintenance resume");
      report.resumedRiskAnalyses.push(id);
    }
  });

  report.durationMs = Date.now() - started;
  console.log(
    `[DeployGuard][maintenance] Done in ${report.durationMs} ms: ${report.installations.length} installation(s), ` +
      `${report.recoveredDeployments.length} recovered push(es), ${report.stalePipelines.length} stale pipeline(s), ` +
      `${report.deliveriesRetried.length} retried delivery(ies), ${report.resumedRiskAnalyses.length} resumed analysis(es), ` +
      `${report.errors.length} error(s).`
  );
  return report;
}
