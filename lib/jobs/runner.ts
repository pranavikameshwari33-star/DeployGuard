import { after } from "next/server";
import { claim, complete, fail, WORKER_ID, type Job } from "@/lib/jobs/queue";
import { handlers, RetryableJobError, PermanentJobError } from "@/lib/jobs/handlers";

/**
 * Stage 2: drains the job queue within a time budget.
 *
 * Who drains it (any of these is enough; together they are redundant on purpose):
 *   - kickQueue(): right after a webhook / CI response, via Next.js after();
 *   - the maintenance run (scheduled);
 *   - POST /api/jobs/run (internal token), for a frequent external scheduler.
 * SKIP LOCKED means concurrent drains never take the same job.
 */
export type DrainReport = { processed: number; succeeded: number; retried: number; dead: number; byType: Record<string, number> };

export async function drainQueue(options: { budgetMs?: number; maxJobs?: number; types?: string[] } = {}): Promise<DrainReport> {
  const started = Date.now();
  const budgetMs = options.budgetMs ?? 25_000;
  const maxJobs = options.maxJobs ?? 50;
  const report: DrainReport = { processed: 0, succeeded: 0, retried: 0, dead: 0, byType: {} };

  while (report.processed < maxJobs && Date.now() - started < budgetMs - 3_000) {
    const [job] = await claim(1, WORKER_ID, options.types);
    if (!job) break;
    report.processed++;
    report.byType[job.type] = (report.byType[job.type] ?? 0) + 1;
    const outcome = await runJob(job);
    report[outcome]++;
  }
  return report;
}

async function runJob(job: Job): Promise<"succeeded" | "retried" | "dead"> {
  const handler = handlers[job.type];
  const label = `job #${job.id} ${job.type} (attempt ${job.attempts}/${job.max_attempts})`;
  if (!handler) {
    await fail(job, `no handler for job type ${job.type}`, false);
    console.error(`[DeployGuard][jobs] ${label} dead-lettered: unknown type.`);
    return "dead";
  }
  console.log(`[DeployGuard][jobs] ${label} started.`);
  try {
    const result = await handler(job);
    await complete(job.id);
    console.log(`[DeployGuard][jobs] ${label} succeeded${result ? `: ${result}` : ""}.`);
    return "succeeded";
  } catch (error) {
    const message = (error as Error).message;
    const retryable = !(error instanceof PermanentJobError);
    const status = await fail(job, message, retryable);
    if (status === "dead") {
      console.error(`[DeployGuard][jobs] ${label} DEAD-LETTERED: ${message}`);
      return "dead";
    }
    console.warn(
      `[DeployGuard][jobs] ${label} failed, will retry${error instanceof RetryableJobError ? "" : " (unexpected error)"}: ${message}`
    );
    return "retried";
  }
}

/** Drains the queue after the current response has been sent. */
export function kickQueue(budgetMs = 25_000): void {
  try {
    after(async () => {
      try {
        const r = await drainQueue({ budgetMs });
        if (r.processed) {
          console.log(`[DeployGuard][jobs] Drain: ${r.processed} job(s), ${r.succeeded} ok, ${r.retried} retry, ${r.dead} dead.`);
        }
      } catch (error) {
        console.error(`[DeployGuard][jobs] Drain failed: ${(error as Error).message}`);
      }
    });
  } catch {
    // Outside a request (e.g. maintenance): the caller drains explicitly.
  }
}
