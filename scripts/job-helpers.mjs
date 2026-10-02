/**
 * Stage 2: helpers for verification scripts that need to wait for queued work
 * (Hindsight writes, workflow_run processing, risk analysis are jobs now).
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls the jobs table until the job finishes. Returns { status, attempts, last_error } or null on timeout. */
export async function waitForJob(client, jobId, timeoutMs = 60_000) {
  if (!jobId) return null;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    let rows;
    try {
      ({ rows } = await client.query(`SELECT status, attempts, last_error FROM jobs WHERE id = $1`, [jobId]));
    } catch (error) {
      // A hosted pooler can drop an idle connection; the next poll uses a fresh one.
      if (!/Connection terminated|ECONNRESET|timeout/i.test(error.message)) throw error;
      await sleep(1000);
      continue;
    }
    if (!rows[0]) return { status: "missing" };
    if (rows[0].status === "succeeded" || rows[0].status === "dead") return rows[0];
    await sleep(1000);
  }
  return null;
}

/** Drains the queue once through the internal endpoint (if the after() drain has not run yet). */
export async function runQueue(base, fetchFn) {
  const r = await fetchFn(`${base}/api/jobs/run`, { method: "POST" });
  return r.json().catch(() => ({}));
}
