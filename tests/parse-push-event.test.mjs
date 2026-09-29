import { test } from "node:test";
import assert from "node:assert/strict";
import { branchFromRef, parsePushEvent } from "../lib/github/parse-push-event.ts";

const commit = (id, files) => ({
  id,
  message: `commit ${id}`,
  timestamp: "2026-01-01T00:00:00Z",
  url: "",
  author: { name: "Dev", email: "dev@example.com", username: "dev" },
  added: files.added ?? [],
  modified: files.modified ?? [],
  removed: files.removed ?? [],
});

test("branchFromRef keeps branches and drops tags", () => {
  assert.equal(branchFromRef("refs/heads/main"), "main");
  assert.equal(branchFromRef("refs/heads/feature/login"), "feature/login");
  assert.equal(branchFromRef("refs/tags/v1.0.0"), "");
});

test("parsePushEvent reads the repository, branch and head commit", () => {
  const event = parsePushEvent(
    {
      ref: "refs/heads/main",
      after: "b".repeat(40),
      repository: { name: "demo", full_name: "acme/demo", owner: { login: "acme" } },
      head_commit: commit("b".repeat(40), { modified: ["src/app.ts"] }),
      commits: [commit("b".repeat(40), { modified: ["src/app.ts"] })],
    },
    "delivery-1"
  );

  assert.equal(event.owner, "acme");
  assert.equal(event.repository, "demo");
  assert.equal(event.branch, "main");
  assert.equal(event.commitSha, "b".repeat(40));
  assert.equal(event.author, "dev");
  assert.deepEqual(event.changedFiles, ["src/app.ts"]);
});

test("parsePushEvent merges file lists across commits, last change wins", () => {
  const event = parsePushEvent(
    {
      ref: "refs/heads/main",
      commits: [
        commit("1", { added: ["new.ts", "temp.ts"], modified: ["a.ts"] }),
        commit("2", { modified: ["new.ts"], removed: ["temp.ts"] }),
      ],
    },
    "delivery-2"
  );

  assert.deepEqual(event.addedFiles, ["new.ts"]); // added then modified stays added
  assert.deepEqual(event.modifiedFiles, ["a.ts"]);
  assert.deepEqual(event.deletedFiles, ["temp.ts"]); // added then deleted ends deleted
  assert.deepEqual(event.changedFiles, ["a.ts", "new.ts", "temp.ts"]);
});
