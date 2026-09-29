import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * A switch for demonstrating a FAILED deployment on purpose.
 *
 * The CI workflow sets DEPLOYGUARD_DEMO_FAILURE=1 only when the pushed commit's
 * message contains [demo-fail]. Every other time this test is skipped (it shows
 * as "skipped", not as a pass), so it never hides a real result.
 */
const enabled = process.env.DEPLOYGUARD_DEMO_FAILURE === "1";

test("demo failure switch ([demo-fail] in the commit message)", { skip: !enabled }, () => {
  assert.fail(
    "Intentional demo failure: the commit message contains [demo-fail]. " +
      "Push a commit without [demo-fail] to get a passing pipeline again."
  );
});
