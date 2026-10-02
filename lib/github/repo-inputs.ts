import { getPool } from "@/lib/db/client";
import { getRepositoryFile, installationGet, GitHubApiError } from "@/lib/github/app";
import { enqueue } from "@/lib/jobs/queue";
import { JOB_TYPES } from "@/lib/jobs/types";
import { CODEOWNERS_PATHS, parseCodeowners, type CodeownersRule } from "@/lib/config/codeowners";
import { CONFIG_PATH, MAX_CONFIG_BYTES, parseRepoConfig, type RepoConfig } from "@/lib/config/repo-config";
import { redactText } from "@/lib/security/redact";

/**
 * Stage 5.2 / 5.3: the repository's own inputs -- `.deployguard.yml` and
 * CODEOWNERS -- read from the DEFAULT branch through the GitHub API (Contents:
 * read, already granted), validated, and cached in `repository_inputs`.
 *
 * The push webhook never waits for GitHub: it uses the cached row and, when
 * the row is missing or old (or the push changed one of the files on the
 * default branch), queues a refresh job. Each deployment records which config
 * shaped its analysis (`deployments.analysis_config`).
 */

export type RepositoryInputs = {
  github_repository_id: string;
  default_branch: string | null;
  config_status: "absent" | "valid" | "invalid" | "unavailable";
  config: RepoConfig | null;
  config_errors: string[] | null;
  config_sha: string | null;
  codeowners_status: "absent" | "valid" | "unavailable";
  codeowners_path: string | null;
  codeowners: CodeownersRule[] | null;
  codeowners_emails_dropped: number;
  fetched_at: Date | null;
};

/** How old the cached inputs may be before a push queues a refresh. */
export const INPUTS_MAX_AGE_HOURS = 6;
const MAX_CODEOWNERS_BYTES = 128 * 1024;

export async function getRepositoryInputs(githubRepositoryId: string | null): Promise<RepositoryInputs | null> {
  if (!githubRepositoryId) return null;
  const { rows } = await getPool().query<RepositoryInputs>(
    `SELECT github_repository_id::text, default_branch, config_status, config, config_errors, config_sha,
            codeowners_status, codeowners_path, codeowners, codeowners_emails_dropped, fetched_at
     FROM repository_inputs WHERE github_repository_id = $1`,
    [githubRepositoryId]
  );
  return rows[0] ?? null;
}

/** The config that applies now: the validated one, or none (= defaults) when absent/invalid/unavailable. */
export function effectiveConfig(inputs: RepositoryInputs | null): RepoConfig | null {
  return inputs?.config_status === "valid" ? inputs.config : null;
}

/**
 * Queues a refresh when the cached inputs are missing or stale, or when this
 * push changed .deployguard.yml / CODEOWNERS on the default branch. Never throws.
 */
export async function maybeQueueInputsRefresh(
  githubRepositoryId: string | null,
  push: { branch: string; commitSha: string; changedFiles: string[] },
  inputs: RepositoryInputs | null
): Promise<boolean> {
  if (!githubRepositoryId) return false;
  const touched = push.changedFiles.some((f) => f === CONFIG_PATH || CODEOWNERS_PATHS.includes(f));
  const onDefault = inputs?.default_branch ? push.branch === inputs.default_branch : true;
  const stale = !inputs?.fetched_at || Date.now() - inputs.fetched_at.getTime() > INPUTS_MAX_AGE_HOURS * 3600_000;
  if (!(stale || (touched && onDefault))) return false;
  const bucket = touched && onDefault ? `sha:${push.commitSha}` : `h:${Math.floor(Date.now() / (INPUTS_MAX_AGE_HOURS * 3600_000))}`;
  try {
    const job = await enqueue(JOB_TYPES.repoInputsRefresh, { githubRepositoryId }, { dedupeKey: `repo.inputs:${githubRepositoryId}:${bucket}`, maxAttempts: 4 });
    return job.created;
  } catch (error) {
    console.error(`[DeployGuard][inputs] Could not queue an inputs refresh for ghrepo:${githubRepositoryId}: ${(error as Error).message}`);
    return false;
  }
}

/** Reads both files from GitHub and stores the validated result. Returns a short summary. */
export async function refreshRepositoryInputs(githubRepositoryId: string): Promise<string> {
  const { rows } = await getPool().query<{ installation_id: string; full_name: string; default_branch: string | null; connected: boolean }>(
    `SELECT installation_id, full_name, default_branch, connected FROM repositories WHERE github_repository_id = $1`,
    [githubRepositoryId]
  );
  const repo = rows[0];
  if (!repo || !repo.connected) return "repository not connected";
  const installationId = Number(repo.installation_id);

  let defaultBranch = repo.default_branch;
  if (!defaultBranch) {
    const info = await installationGet<{ default_branch?: string }>(installationId, `/repos/${repo.full_name}`);
    defaultBranch = info.default_branch ?? null;
  }

  // --- .deployguard.yml -----------------------------------------------------
  let config: { status: RepositoryInputs["config_status"]; config: RepoConfig | null; errors: string[] | null; sha: string | null };
  try {
    const file = await getRepositoryFile(installationId, repo.full_name, CONFIG_PATH, defaultBranch, MAX_CONFIG_BYTES);
    if (!file) config = { status: "absent", config: null, errors: null, sha: null };
    else {
      const parsed = parseRepoConfig(file.text);
      config = parsed.ok
        ? { status: "valid", config: parsed.config, errors: null, sha: file.sha }
        : { status: "invalid", config: null, errors: parsed.errors.map((e) => redactText(e).slice(0, 300)), sha: file.sha };
    }
  } catch (error) {
    config = { status: "unavailable", config: null, errors: [readError(error)], sha: null };
  }

  // --- CODEOWNERS (first location that exists) ---------------------------------
  let owners: { status: RepositoryInputs["codeowners_status"]; path: string | null; rules: CodeownersRule[] | null; dropped: number } = {
    status: "absent", path: null, rules: null, dropped: 0,
  };
  try {
    for (const path of CODEOWNERS_PATHS) {
      const file = await getRepositoryFile(installationId, repo.full_name, path, defaultBranch, MAX_CODEOWNERS_BYTES);
      if (!file) continue;
      const parsed = parseCodeowners(file.text);
      owners = { status: "valid", path, rules: parsed.rules, dropped: parsed.emailsDropped };
      break;
    }
  } catch {
    owners = { status: "unavailable", path: null, rules: null, dropped: 0 };
  }

  await getPool().query(
    `INSERT INTO repository_inputs (github_repository_id, default_branch, config_status, config, config_errors, config_sha,
       codeowners_status, codeowners_path, codeowners, codeowners_emails_dropped, fetched_at, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb, $10, now(), now())
     ON CONFLICT (github_repository_id) DO UPDATE SET
       default_branch = EXCLUDED.default_branch, config_status = EXCLUDED.config_status, config = EXCLUDED.config,
       config_errors = EXCLUDED.config_errors, config_sha = EXCLUDED.config_sha, codeowners_status = EXCLUDED.codeowners_status,
       codeowners_path = EXCLUDED.codeowners_path, codeowners = EXCLUDED.codeowners,
       codeowners_emails_dropped = EXCLUDED.codeowners_emails_dropped, fetched_at = now(), updated_at = now()`,
    [
      githubRepositoryId, defaultBranch, config.status, config.config ? JSON.stringify(config.config) : null,
      config.errors ? JSON.stringify(config.errors) : null, config.sha, owners.status, owners.path,
      owners.rules ? JSON.stringify(owners.rules) : null, owners.dropped,
    ]
  );
  return `config ${config.status}, CODEOWNERS ${owners.status}`;
}

function readError(error: unknown): string {
  if (error instanceof GitHubApiError && error.kind === "forbidden") return "DeployGuard may not read this file (Contents: read permission).";
  return "The file could not be read from GitHub right now.";
}
