import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertRetainScope,
  filterRecallResults,
  recallTagFilter,
  recallTagRequests,
  MAX_NARROWED_TENANTS,
  tenantTag,
  HindsightScopeError,
} from "../lib/hindsight/scope.ts";

/**
 * Stage 1: automated cross-tenant test of the Hindsight client layer, using the
 * real tag logic that lib/hindsight/client.ts applies to every retain and
 * recall. Tenant A = GitHub repository 1001, tenant B = 2002.
 */
const A = "1001";
const B = "2002";
const mem = (tags, text = "m") => ({ id: text, text, tags });

test("retain is refused without exactly one well-formed ghrepo: tag, document_id and replace mode", () => {
  const ok = { tags: ["deployment", tenantTag(A)], document_id: "deployment/x", update_mode: "replace" };
  assert.doesNotThrow(() => assertRetainScope(ok));
  assert.throws(() => assertRetainScope({ ...ok, tags: ["deployment", "repo:acme/shop"] }), HindsightScopeError);
  assert.throws(() => assertRetainScope({ ...ok, tags: [tenantTag(A), tenantTag(B)] }), HindsightScopeError);
  assert.throws(() => assertRetainScope({ ...ok, tags: [tenantTag(A), "ghrepo:abc"] }), HindsightScopeError);
  assert.throws(() => assertRetainScope({ ...ok, document_id: undefined }), HindsightScopeError);
  assert.throws(() => assertRetainScope({ ...ok, update_mode: "append" }), HindsightScopeError);
  assert.throws(() => assertRetainScope({ ...ok, tags: undefined }), HindsightScopeError);
});

test("recall is refused without a tenant scope and always uses any_strict", () => {
  assert.throws(() => recallTagFilter({ githubRepositoryIds: [] }), HindsightScopeError);
  assert.throws(() => recallTagFilter({ githubRepositoryIds: ["not-a-number"] }), HindsightScopeError);
  assert.deepEqual(recallTagFilter({ githubRepositoryIds: [A, A] }), { tags: [`ghrepo:${A}`], tags_match: "any_strict" });
});

test("tenant A never receives tenant B's memories, even if the server returned them", () => {
  const serverSaid = [
    mem([tenantTag(A), "deployment"], "a1"),
    mem([tenantTag(B), "deployment"], "b1"),
    mem(["deployment"], "untagged"),
    mem([tenantTag(A), tenantTag(B)], "both"),
    mem([], "none"),
  ];
  const seenByA = filterRecallResults(serverSaid, { githubRepositoryIds: [A] }).map((m) => m.text);
  assert.deepEqual(seenByA, ["a1"]);
  const seenByB = filterRecallResults(serverSaid, { githubRepositoryIds: [B] }).map((m) => m.text);
  assert.deepEqual(seenByB, ["b1"]);
});

test("user-supplied tags can only NARROW the result, never widen it", () => {
  const serverSaid = [
    mem([tenantTag(A), "incident", "deployment:5"], "a-inc"),
    mem([tenantTag(A), "deployment", "deployment:6"], "a-dep"),
    mem([tenantTag(B), "incident", "deployment:9"], "b-inc"),
  ];
  // Asking for B's deployment tag from A's scope yields nothing.
  assert.deepEqual(filterRecallResults(serverSaid, { githubRepositoryIds: [A], narrowTags: ["deployment:9"] }), []);
  // Asking for B's tenant tag as a "filter" yields nothing either.
  assert.deepEqual(filterRecallResults(serverSaid, { githubRepositoryIds: [A], narrowTags: [tenantTag(B)] }), []);
  // A narrowing tag inside the scope works and requires ALL tags.
  assert.deepEqual(
    filterRecallResults(serverSaid, { githubRepositoryIds: [A], narrowTags: ["incident"] }).map((m) => m.text),
    ["a-inc"]
  );
  // The request itself only ever carries the authorised tenant tags.
  const filter = recallTagFilter({ githubRepositoryIds: [A], narrowTags: ["deployment:9", tenantTag(B)] });
  assert.deepEqual(filter.tags, [tenantTag(A)]);
});

test("narrowed recall: one all_strict request per tenant, each REQUIRING its tenant tag", () => {
  assert.deepEqual(recallTagRequests({ githubRepositoryIds: [A] }), [{ tags: [tenantTag(A)], tags_match: "any_strict" }]);
  assert.deepEqual(recallTagRequests({ githubRepositoryIds: [A, B], narrowTags: ["incident"] }), [
    { tags: [tenantTag(A), "incident"], tags_match: "all_strict" },
    { tags: [tenantTag(B), "incident"], tags_match: "all_strict" },
  ]);
  // A tenant tag can never be smuggled in as a "narrowing" filter.
  assert.throws(() => recallTagRequests({ githubRepositoryIds: [A], narrowTags: [tenantTag(B)] }), HindsightScopeError);
  // Large scopes fall back to one any_strict request (then client-side narrowing).
  const many = Array.from({ length: MAX_NARROWED_TENANTS + 1 }, (_, i) => String(5000 + i));
  const reqs = recallTagRequests({ githubRepositoryIds: many, narrowTags: ["incident"] });
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].tags_match, "any_strict");
  assert.ok(reqs[0].tags.every((t) => t.startsWith("ghrepo:")));
});
