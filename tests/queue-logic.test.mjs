import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffSeconds, BACKOFF } from "../lib/jobs/backoff.ts";
import { aggregateRuns } from "../lib/github/aggregate-runs.ts";

/** Stage 2: pure parts of the queue and of workflow_run aggregation. */

test("backoff grows exponentially, is capped, and is jittered within 50-100%", () => {
  const max = (a) => backoffSeconds(a, () => 1);
  const min = (a) => backoffSeconds(a, () => 0);
  assert.equal(max(1), BACKOFF.baseSeconds);
  assert.equal(max(2), BACKOFF.baseSeconds * 2);
  assert.equal(max(3), BACKOFF.baseSeconds * 4);
  assert.equal(max(30), BACKOFF.maxSeconds);
  assert.equal(min(3), Math.round((BACKOFF.baseSeconds * 4) / 2));
  for (let a = 1; a < 12; a++) {
    const v = backoffSeconds(a);
    assert.ok(v >= min(a) && v <= max(a), `attempt ${a}: ${v}`);
  }
});

const run = (id, status, conclusion = null) => ({ id, status, conclusion });

test("several workflows for one push: BUILDING while any is active", () => {
  assert.equal(aggregateRuns([run(1, "completed", "success"), run(2, "in_progress")]).outcome, "BUILDING");
  assert.equal(aggregateRuns([run(1, "queued"), run(2, "completed", "skipped")]).outcome, "BUILDING");
});

test("FAILED as soon as any run failed, reporting that run (even if others still run)", () => {
  const r = aggregateRuns([run(1, "completed", "success"), run(2, "completed", "failure"), run(3, "in_progress")]);
  assert.equal(r.outcome, "FAILED");
  assert.equal(r.run.id, 2);
  assert.equal(aggregateRuns([run(1, "completed", "timed_out")]).outcome, "FAILED");
  assert.equal(aggregateRuns([run(1, "completed", "startup_failure")]).outcome, "FAILED");
});

test("SUCCESS only when all completed without failure and at least one succeeded", () => {
  assert.equal(aggregateRuns([run(1, "completed", "success"), run(2, "completed", "skipped")]).outcome, "SUCCESS");
  assert.equal(aggregateRuns([run(1, "completed", "skipped"), run(2, "completed", "neutral")]).outcome, "NONE");
  assert.equal(aggregateRuns([run(1, "completed", "cancelled"), run(2, "completed", "success")]).outcome, "NONE");
  assert.equal(aggregateRuns([]).outcome, "NONE");
});
