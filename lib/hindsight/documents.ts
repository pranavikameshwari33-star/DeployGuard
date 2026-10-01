import { getPool } from "@/lib/db/client";
import { isTenantTag } from "@/lib/hindsight/scope";

/**
 * Stage 2: the list of Hindsight documents DeployGuard has written
 * (table memory_documents). A purge deletes exactly these, then verifies each
 * is gone. Memories written before Stage 2 are not in the table; the purge
 * also derives their document ids from the database rows (see lib/lifecycle/purge.ts).
 */
export async function trackRetainedDocument(item: {
  document_id?: string;
  tags?: string[];
  metadata?: Record<string, string>;
}): Promise<void> {
  const tenant = (item.tags ?? []).find(isTenantTag);
  if (!item.document_id || !tenant) return;
  const meta = item.metadata ?? {};
  const kind = meta.kind ?? item.document_id.split("/")[0];
  const id = (v: string | undefined) => (v && /^\d{1,19}$/.test(v) ? v : null);
  await getPool().query(
    `INSERT INTO memory_documents (document_id, kind, github_repository_id, deployment_id, incident_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (document_id) DO UPDATE SET retained_at = now(), deleted_at = NULL,
       deployment_id = COALESCE(EXCLUDED.deployment_id, memory_documents.deployment_id),
       incident_id   = COALESCE(EXCLUDED.incident_id, memory_documents.incident_id)`,
    [item.document_id, kind, tenant.slice("ghrepo:".length), id(meta.deployment_id), id(meta.incident_id)]
  );
}

export async function listTrackedDocuments(githubRepositoryId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ document_id: string }>(
    `SELECT document_id FROM memory_documents WHERE github_repository_id = $1 AND deleted_at IS NULL`,
    [githubRepositoryId]
  );
  return rows.map((r) => r.document_id);
}

export async function listTrackedDocumentsForDeployments(deploymentIds: string[]): Promise<string[]> {
  if (deploymentIds.length === 0) return [];
  const { rows } = await getPool().query<{ document_id: string }>(
    `SELECT document_id FROM memory_documents WHERE deployment_id = ANY($1::bigint[]) AND deleted_at IS NULL`,
    [deploymentIds]
  );
  return rows.map((r) => r.document_id);
}

export async function markDocumentsDeleted(documentIds: string[]): Promise<void> {
  if (documentIds.length === 0) return;
  await getPool().query(`UPDATE memory_documents SET deleted_at = now() WHERE document_id = ANY($1::text[])`, [documentIds]);
}
