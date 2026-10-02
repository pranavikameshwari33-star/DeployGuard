/**
 * Turns GitHub's raw `push` webhook payload into the small, predictable shape
 * DeployGuard actually cares about.
 *
 * Everything downstream (the database in Phase 2, the file classifier in
 * Phase 5, the similarity search in Phase 6) reads THIS shape, never GitHub's
 * raw JSON. That keeps the rest of the system independent of GitHub's payload
 * format.
 */

/** A single commit as GitHub sends it inside a push payload. */
type GithubCommit = {
  id: string;
  message: string;
  timestamp: string;
  url: string;
  author?: { name?: string; email?: string; username?: string };
  added?: string[];
  removed?: string[];
  modified?: string[];
};

/** Only the fields of GitHub's push payload that we read. */
type GithubPushPayload = {
  ref?: string;
  before?: string;
  after?: string;
  created?: boolean;
  deleted?: boolean;
  forced?: boolean;
  compare?: string;
  repository?: {
    id?: number;
    name?: string;
    full_name?: string;
    html_url?: string;
    default_branch?: string;
    owner?: { name?: string; login?: string };
  };
  pusher?: { name?: string; email?: string };
  head_commit?: GithubCommit | null;
  commits?: GithubCommit[];
  /** Present when the push was delivered to the GitHub App (Phase 9). */
  installation?: { id?: number };
};

/** The normalized push event that the rest of DeployGuard works with. */
export type PushEvent = {
  deliveryId: string;
  receivedAt: string;

  repository: string;
  owner: string;
  repositoryFullName: string;
  branch: string;
  ref: string;

  commitSha: string;
  commitMessage: string;
  author: string;
  authorEmail: string;
  pusher: string;
  timestamp: string;

  commitCount: number;
  compareUrl: string;

  addedFiles: string[];
  modifiedFiles: string[];
  deletedFiles: string[];
  changedFiles: string[];

  /** Phase 9: GitHub's immutable repository id, and the App installation that delivered the push (null for a plain repo webhook). */
  githubRepositoryId: number | null;
  installationId: number | null;

  /** Stage 1: set by redactPushEvent when the commit message had something masked (counts only). */
  commitMessageRedaction?: { count: number; categories: string[] };
};

/**
 * `refs/heads/main` -> `main`. Tag pushes look like `refs/tags/v1.0.0`, and we
 * deliberately return an empty branch for those so the caller can ignore them.
 */
export function branchFromRef(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
}

/**
 * A push can contain many commits. We merge the per-commit file lists into one
 * set of added / modified / deleted files for the whole push.
 *
 * The merge rules read in commit order, so the LAST thing that happened to a
 * file wins: a file that was added and then deleted in the same push ends up
 * as deleted, and a file added and then modified stays "added" because from
 * the repository's point of view it is new.
 */
function mergeFileLists(commits: GithubCommit[]) {
  const state = new Map<string, "added" | "modified" | "deleted">();

  for (const commit of commits) {
    for (const file of commit.added ?? []) {
      state.set(file, "added");
    }
    for (const file of commit.modified ?? []) {
      // If we already saw this file as added in this push, it stays "added".
      if (state.get(file) !== "added") {
        state.set(file, "modified");
      }
    }
    for (const file of commit.removed ?? []) {
      state.set(file, "deleted");
    }
  }

  const addedFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const deletedFiles: string[] = [];

  for (const [file, kind] of state) {
    if (kind === "added") addedFiles.push(file);
    else if (kind === "modified") modifiedFiles.push(file);
    else deletedFiles.push(file);
  }

  return {
    addedFiles: addedFiles.sort(),
    modifiedFiles: modifiedFiles.sort(),
    deletedFiles: deletedFiles.sort(),
    changedFiles: [...state.keys()].sort(),
  };
}

export function parsePushEvent(
  payload: unknown,
  deliveryId: string
): PushEvent {
  const push = (payload ?? {}) as GithubPushPayload;

  const ref = push.ref ?? "";
  const commits = push.commits ?? [];
  const head = push.head_commit ?? commits[commits.length - 1] ?? null;
  const files = mergeFileLists(commits);

  return {
    deliveryId,
    receivedAt: new Date().toISOString(),

    repository: push.repository?.name ?? "unknown",
    owner: push.repository?.owner?.login ?? push.repository?.owner?.name ?? "unknown",
    repositoryFullName: push.repository?.full_name ?? "unknown",
    branch: branchFromRef(ref),
    ref,

    commitSha: push.after ?? head?.id ?? "",
    commitMessage: head?.message ?? "",
    author: head?.author?.username ?? head?.author?.name ?? push.pusher?.name ?? "unknown",
    authorEmail: head?.author?.email ?? push.pusher?.email ?? "",
    pusher: push.pusher?.name ?? "unknown",
    timestamp: head?.timestamp ?? new Date().toISOString(),

    commitCount: commits.length,
    compareUrl: push.compare ?? "",

    ...files,

    githubRepositoryId: typeof push.repository?.id === "number" ? push.repository.id : null,
    installationId: typeof push.installation?.id === "number" ? push.installation.id : null,
  };
}
