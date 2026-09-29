import { getPool } from "@/lib/db/client";

/**
 * Phase 10: the GitHub webhook delivery log (github_webhook_deliveries).
 *
 * GitHub identifies each delivery with a GUID (X-GitHub-Delivery) that stays
 * the same on redelivery. Recording it makes processing idempotent across all
 * event types, and keeps the payload of deferred work until it has run, so a
 * lost after() callback can be retried by the maintenance run.
 *
 * Only event metadata and (for deferred work) GitHub's own payload are stored.
 * No header, token or secret is ever written here.
 */

export type DeliveryStatus = "received" | "processing" | "processed" | "failed" | "ignored";

/** Deliveries stuck in 'processing' longer than this are considered lost and may run again. */
const PROCESSING_STALE_MINUTES = 5;
export const MAX_DELIVERY_ATTEMPTS = 5;

export type BeginResult =
  | { proceed: true; attempt: number }
  | { proceed: false; status: DeliveryStatus };

/**
 * Registers a delivery and decides whether to process it:
 *   new                          -> process
 *   received / failed            -> process again (a redelivery of something that did not finish)
 *   processing, recently started -> skip (the first copy is still running)
 *   processed / ignored          -> skip (duplicate)
 */
export async function beginDelivery(input: {
  deliveryId: string;
  event: string;
  action: string | null;
  installationId: number | null;
  githubRepositoryId: number | null;
  payload?: unknown;
}): Promise<BeginResult> {
  const result = await getPool().query<{ status: DeliveryStatus; attempts: number; stale: boolean; inserted: boolean }>(
    `WITH prev AS (
       SELECT status, updated_at < now() - make_interval(mins => $7) AS stale
       FROM github_webhook_deliveries WHERE delivery_id = $1
     ), upsert AS (
       INSERT INTO github_webhook_deliveries (delivery_id, event, action, installation_id, github_repository_id, payload, status, attempts)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'processing', 1)
       ON CONFLICT (delivery_id) DO UPDATE SET
         attempts   = github_webhook_deliveries.attempts
                      + CASE WHEN github_webhook_deliveries.status IN ('received', 'failed')
                               OR (github_webhook_deliveries.status = 'processing'
                                   AND github_webhook_deliveries.updated_at < now() - make_interval(mins => $7))
                             THEN 1 ELSE 0 END,
         status     = CASE WHEN github_webhook_deliveries.status IN ('received', 'failed')
                             OR (github_webhook_deliveries.status = 'processing'
                                 AND github_webhook_deliveries.updated_at < now() - make_interval(mins => $7))
                           THEN 'processing' ELSE github_webhook_deliveries.status END,
         payload    = COALESCE(EXCLUDED.payload, github_webhook_deliveries.payload),
         updated_at = now()
       RETURNING (xmax = 0) AS inserted, attempts
     )
     SELECT u.inserted, u.attempts, p.status, COALESCE(p.stale, false) AS stale
     FROM upsert u LEFT JOIN prev p ON true`,
    [
      input.deliveryId,
      input.event,
      input.action,
      input.installationId,
      input.githubRepositoryId,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      PROCESSING_STALE_MINUTES,
    ]
  );
  const row = result.rows[0];
  if (row.inserted) return { proceed: true, attempt: row.attempts };
  if (row.status === "received" || row.status === "failed" || (row.status === "processing" && row.stale)) {
    return { proceed: true, attempt: row.attempts };
  }
  return { proceed: false, status: row.status };
}

/** Records the outcome. The stored payload is dropped once it is no longer needed. */
export async function finishDelivery(deliveryId: string, status: DeliveryStatus, error?: string): Promise<void> {
  await getPool().query(
    `UPDATE github_webhook_deliveries
     SET status = $2, last_error = $3, updated_at = now(),
         payload = CASE WHEN $2 IN ('processed', 'ignored') THEN NULL ELSE payload END
     WHERE delivery_id = $1`,
    [deliveryId, status, error ? error.slice(0, 500) : null]
  );
}

export type RetryableDelivery = { delivery_id: string; event: string; attempts: number; payload: unknown };

/** Deferred deliveries that did not finish (crash, timeout, transient error) and still have attempts left. */
export async function listRetryableDeliveries(limit: number): Promise<RetryableDelivery[]> {
  const result = await getPool().query<RetryableDelivery>(
    `SELECT delivery_id, event, attempts, payload FROM github_webhook_deliveries
     WHERE payload IS NOT NULL AND attempts < $2
       AND (status IN ('received', 'failed')
            OR (status = 'processing' AND updated_at < now() - make_interval(mins => $3)))
       AND updated_at < now() - interval '2 minutes'
     ORDER BY received_at LIMIT $1`,
    [limit, MAX_DELIVERY_ATTEMPTS, PROCESSING_STALE_MINUTES]
  );
  return result.rows;
}

/** Marks a delivery as being retried (so two maintenance runs do not both take it). */
export async function claimRetry(deliveryId: string): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE github_webhook_deliveries SET status = 'processing', attempts = attempts + 1, updated_at = now()
     WHERE delivery_id = $1 AND status <> 'processing' OR (delivery_id = $1 AND updated_at < now() - make_interval(mins => $2))`,
    [deliveryId, PROCESSING_STALE_MINUTES]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Bounded pruning: finished deliveries after 14 days, failed ones after 30. */
export async function pruneDeliveries(limit = 2000): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM github_webhook_deliveries WHERE delivery_id IN (
       SELECT delivery_id FROM github_webhook_deliveries
       WHERE (status IN ('processed', 'ignored') AND received_at < now() - interval '14 days')
          OR received_at < now() - interval '30 days'
       LIMIT $1)`,
    [limit]
  );
  return result.rowCount ?? 0;
}

/** Deliveries still waiting to be processed (for the health report). */
export async function countPendingDeliveries(): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM github_webhook_deliveries WHERE status IN ('received', 'processing', 'failed') AND payload IS NOT NULL`
  );
  return result.rows[0].n;
}
