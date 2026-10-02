import { getPool, withConnectionRetry } from "@/lib/db/client";

/**
 * Stage 2: append-only audit log (table audit_log; UPDATE/DELETE are refused by
 * a database trigger). Entries hold who, what, which repository, when and the
 * outcome, plus counts/ids only -- never secrets or repository content.
 */
export type AuditEntry = {
  actor: string; // "user:<id>" | "internal" | "system"
  action: string;
  githubRepositoryId?: string | null;
  outcome: "ok" | "failed" | "refused";
  detail?: Record<string, string | number | boolean | null | string[]>;
};

export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await withConnectionRetry(() => getPool().query(
      `INSERT INTO audit_log (actor, action, github_repository_id, outcome, detail) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [entry.actor, entry.action, entry.githubRepositoryId ?? null, entry.outcome, JSON.stringify(entry.detail ?? {})]
    ));
  } catch (error) {
    // The action itself already happened; a lost audit row must be visible in the log.
    console.error(`[DeployGuard][audit] Could not write audit entry ${entry.action}: ${(error as Error).message}`);
  }
}
