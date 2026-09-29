import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/client";
import { getViewer } from "@/lib/auth/session";
import { countPendingDeliveries } from "@/lib/db/webhook-deliveries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health  (Phase 10)
 *
 * Public: { status, application, database } -- nothing else, no secrets, no
 * configuration details. 200 when healthy, 503 when the database is unreachable.
 *
 * Internal tooling (Bearer DEPLOYGUARD_STATUS_TOKEN) also gets operational
 * counters: deferred webhook work not yet processed, automatic analyses still
 * pending, and when installations were last reconciled.
 */
export async function GET() {
  let database: "ok" | "unavailable" = "ok";
  try {
    await Promise.race([
      getPool().query("SELECT 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000)),
    ]);
  } catch {
    database = "unavailable";
  }

  const body: Record<string, unknown> = {
    status: database === "ok" ? "ok" : "degraded",
    application: "ok",
    database,
    time: new Date().toISOString(),
  };

  if (database === "ok") {
    const viewer = await getViewer().catch(() => null);
    if (viewer?.kind === "internal") {
      try {
        const [pendingDeliveries, stats] = await Promise.all([
          countPendingDeliveries(),
          getPool().query<{ pending_risk: number; last_reconciled: Date | null; active_installations: number }>(
            `SELECT (SELECT count(*)::int FROM deployments WHERE risk_analysis_status = 'pending') AS pending_risk,
                    (SELECT max(last_synced_at) FROM github_installations) AS last_reconciled,
                    (SELECT count(*)::int FROM github_installations WHERE status = 'active') AS active_installations`
          ),
        ]);
        body.operations = {
          pendingWebhookDeliveries: pendingDeliveries,
          pendingRiskAnalyses: stats.rows[0].pending_risk,
          activeInstallations: stats.rows[0].active_installations,
          lastReconciledAt: stats.rows[0].last_reconciled,
        };
      } catch (error) {
        body.operations = { error: (error as Error).message };
      }
    }
  }

  return NextResponse.json(body, { status: database === "ok" ? 200 : 503 });
}
