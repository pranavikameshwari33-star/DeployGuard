/**
 * Stage 1: tenant isolation rules for Hindsight, enforced in ONE place.
 *
 * Every memory belongs to exactly one tenant: the immutable GitHub repository
 * id, as the tag `ghrepo:<id>`. All tenants share one bank (see
 * docs/SECURITY.md for the trade-off), so these rules are what keeps them apart:
 *
 *   retain  -- refused unless the item carries exactly one ghrepo: tag, a stable
 *              document_id and update_mode "replace".
 *   recall  -- refused unless it names at least one ghrepo: tag and uses
 *              tags_match "any_strict" (which never returns untagged memories).
 *              Caller-supplied filters can only NARROW the result: they are
 *              applied to what the tenant query returned, never added to it.
 *   results -- re-checked client-side: anything not carrying an allowed ghrepo:
 *              tag is dropped, even if the server returned it.
 *
 * Pure: no imports, so tests exercise exactly this logic.
 */

export const TENANT_TAG_PREFIX = "ghrepo:";

export class HindsightScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HindsightScopeError";
  }
}

export function tenantTag(githubRepositoryId: string | number): string {
  const id = String(githubRepositoryId);
  if (!/^\d{1,19}$/.test(id)) throw new HindsightScopeError(`Invalid GitHub repository id for a tenant tag.`);
  return `${TENANT_TAG_PREFIX}${id}`;
}

export function isTenantTag(tag: string): boolean {
  return /^ghrepo:\d{1,19}$/.test(tag);
}

type RetainItemShape = { tags?: string[]; document_id?: string; update_mode?: string };

/** Throws unless the memory item is correctly scoped to exactly one tenant. */
export function assertRetainScope(item: RetainItemShape): void {
  const tenants = (item.tags ?? []).filter(isTenantTag);
  if (tenants.length === 0) throw new HindsightScopeError("Refusing to retain a memory without a ghrepo: tenant tag.");
  if (tenants.length > 1) throw new HindsightScopeError("Refusing to retain a memory tagged with more than one tenant.");
  if ((item.tags ?? []).some((t) => t.startsWith(TENANT_TAG_PREFIX) && !isTenantTag(t))) {
    throw new HindsightScopeError("Refusing to retain a memory with a malformed ghrepo: tag.");
  }
  if (!item.document_id) throw new HindsightScopeError("Refusing to retain a memory without a stable document_id.");
  if (item.update_mode !== "replace") throw new HindsightScopeError('Refusing to retain a memory without update_mode "replace".');
}

export type ScopedRecall = {
  /** GitHub repository ids the caller is authorised for. Must not be empty. */
  githubRepositoryIds: (string | number)[];
  /** Optional extra tags; a result must carry ALL of them. Only narrows. */
  narrowTags?: string[];
};

/** The tag part of a recall request body, built only from authorised repository ids. */
export function recallTagFilter(scope: ScopedRecall): { tags: string[]; tags_match: "any_strict" } {
  const ids = [...new Set(scope.githubRepositoryIds.map(String))];
  if (ids.length === 0) throw new HindsightScopeError("Refusing to recall without a tenant scope.");
  return { tags: ids.map(tenantTag), tags_match: "any_strict" };
}

/** Upper bound on per-tenant calls for one narrowed recall. */
export const MAX_NARROWED_TENANTS = 10;

export type RecallTagRequest = { tags: string[]; tags_match: "any_strict" | "all_strict" };

/**
 * The tag filters to send for one recall.
 *  - No narrowing tags: ONE request, all authorised tenant tags, any_strict.
 *  - Narrowing tags: one request PER tenant, [ghrepo:<id>, ...narrowTags] with
 *    all_strict -- the tenant tag is still mandatory on the server side, and the
 *    narrowing happens in the search itself instead of after a top-N cut.
 * Narrowing tags that look like tenant tags are refused (they could only widen).
 */
export function recallTagRequests(scope: ScopedRecall): RecallTagRequest[] {
  const base = recallTagFilter(scope);
  const narrow = [...new Set((scope.narrowTags ?? []).filter(Boolean))];
  if (narrow.some((t) => t.startsWith(TENANT_TAG_PREFIX))) {
    throw new HindsightScopeError("A ghrepo: tag cannot be used as a narrowing filter.");
  }
  // Over the cap: one any_strict call, narrowed afterwards by filterRecallResults.
  // Isolation is identical; only recall precision is lower.
  if (narrow.length === 0 || base.tags.length > MAX_NARROWED_TENANTS) return [base];
  return base.tags.map((tenant) => ({ tags: [tenant, ...narrow], tags_match: "all_strict" as const }));
}

/** Drops every result outside the scope, and every result missing a narrowing tag. */
export function filterRecallResults<T extends { tags?: string[] }>(results: T[], scope: ScopedRecall): T[] {
  const allowed = new Set(recallTagFilter(scope).tags);
  const narrow = (scope.narrowTags ?? []).filter(Boolean);
  return results.filter((r) => {
    const tags = r.tags ?? [];
    const tenants = tags.filter(isTenantTag);
    // Exactly one tenant, and it is one of ours.
    if (tenants.length !== 1 || !allowed.has(tenants[0])) return false;
    return narrow.every((t) => tags.includes(t));
  });
}
