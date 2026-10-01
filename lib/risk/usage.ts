import { getPool } from "@/lib/db/client";
import { env } from "@/lib/env";

/**
 * Stage 2: per-tenant Gemini call caps (table gemini_usage).
 *
 * A "call" is one analysis request sent to Gemini (its internal retries on a
 * 5xx count as the same call). The tenant is the repository ("ghrepo:<id>"), or
 * "unowned" for plain-webhook deployments. Before each call a slot is reserved
 * atomically against the DAILY cap (row lock on today's row); the MONTHLY cap
 * is checked in the same statement. Under heavy concurrency the monthly total
 * can overshoot by at most the number of simultaneous requests (documented).
 * When a cap is reached nothing is sent and the refusal is counted.
 */
export type Reservation = { allowed: true } | { allowed: false; reason: "daily" | "monthly"; cap: number };

export function tenantOf(githubRepositoryId: string | null): string {
  return githubRepositoryId ? `ghrepo:${githubRepositoryId}` : "unowned";
}

export async function reserveGeminiCall(tenant: string): Promise<Reservation> {
  const daily = env.geminiDailyCap();
  const monthly = env.geminiMonthlyCap();
  const { rows } = await getPool().query<{ reserved: boolean; month_calls: number; day_calls: number }>(
    `WITH month AS (
       SELECT COALESCE(sum(calls), 0)::int AS n FROM gemini_usage
       WHERE tenant = $1 AND day >= date_trunc('month', current_date)::date
     ), up AS (
       INSERT INTO gemini_usage AS u (tenant, day, calls)
       SELECT $1, current_date, 1 FROM month WHERE month.n < $3 AND $2 > 0
       ON CONFLICT (tenant, day) DO UPDATE SET calls = u.calls + 1 WHERE u.calls < $2
       RETURNING calls
     )
     SELECT EXISTS (SELECT 1 FROM up) AS reserved,
            (SELECT n FROM month) AS month_calls,
            COALESCE((SELECT calls FROM gemini_usage WHERE tenant = $1 AND day = current_date), 0) AS day_calls`,
    [tenant, daily, monthly]
  );
  const r = rows[0];
  if (r.reserved) return { allowed: true };
  await getPool().query(
    `INSERT INTO gemini_usage AS u (tenant, day, refused) VALUES ($1, current_date, 1)
     ON CONFLICT (tenant, day) DO UPDATE SET refused = u.refused + 1`,
    [tenant]
  );
  return r.month_calls >= monthly ? { allowed: false, reason: "monthly", cap: monthly } : { allowed: false, reason: "daily", cap: daily };
}

export type Usage = { tenant: string; today: number; refusedToday: number; month: number; dailyCap: number; monthlyCap: number };

export async function usageFor(tenant: string): Promise<Usage> {
  const { rows } = await getPool().query<{ today: number; refused: number; month: number }>(
    `SELECT COALESCE(sum(calls) FILTER (WHERE day = current_date), 0)::int AS today,
            COALESCE(sum(refused) FILTER (WHERE day = current_date), 0)::int AS refused,
            COALESCE(sum(calls), 0)::int AS month
     FROM gemini_usage WHERE tenant = $1 AND day >= date_trunc('month', current_date)::date`,
    [tenant]
  );
  return {
    tenant,
    today: rows[0].today,
    refusedToday: rows[0].refused,
    month: rows[0].month,
    dailyCap: env.geminiDailyCap(),
    monthlyCap: env.geminiMonthlyCap(),
  };
}
