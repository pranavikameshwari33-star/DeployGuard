import crypto from "node:crypto";
import { getPool } from "@/lib/db/client";

/**
 * Phase 9: DeployGuard accounts, sessions, GitHub App installations and the
 * repositories they grant.
 *
 * Nothing in this module stores a GitHub token. Sessions store only a hash of
 * the random cookie token.
 */

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export type User = {
  id: string;
  github_user_id: string;
  github_login: string;
  display_name: string | null;
  avatar_url: string | null;
};

/** Creates the account on first login, refreshes display fields on later logins. Keyed by the immutable GitHub id. */
export async function upsertUser(github: {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string | null;
}): Promise<User> {
  const result = await getPool().query<User>(
    `INSERT INTO users (github_user_id, github_login, display_name, avatar_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (github_user_id) DO UPDATE SET
       github_login = EXCLUDED.github_login,
       display_name = EXCLUDED.display_name,
       avatar_url   = EXCLUDED.avatar_url,
       updated_at   = now()
     RETURNING id, github_user_id, github_login, display_name, avatar_url`,
    [github.id, github.login, github.name, github.avatar_url]
  );
  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export const SESSION_TTL_DAYS = 30;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

/** Returns the raw token for the cookie. Only its hash is stored. */
export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await getPool().query(
    `INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, hashToken(token), expiresAt]
  );
  // Opportunistic, bounded cleanup (the maintenance run does the rest).
  purgeExpiredSessions(200).catch(() => {});
  return { token, expiresAt };
}

/**
 * Phase 10: deletes up to `limit` EXPIRED sessions (never an active one).
 * Bounded so no single request does unbounded work; call repeatedly to drain.
 */
export async function purgeExpiredSessions(limit = 1000): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM sessions WHERE id IN (
       SELECT id FROM sessions WHERE expires_at < now() ORDER BY expires_at LIMIT $1)`,
    [limit]
  );
  return result.rowCount ?? 0;
}

export async function getSessionUser(token: string): Promise<User | null> {
  if (!token || token.length > 200) return null;
  const result = await getPool().query<User>(
    `SELECT u.id, u.github_user_id, u.github_login, u.display_name, u.avatar_url
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)]
  );
  return result.rows[0] ?? null;
}

export async function deleteSession(token: string): Promise<void> {
  if (!token) return;
  await getPool().query(`DELETE FROM sessions WHERE token_hash = $1`, [hashToken(token)]);
}

// ---------------------------------------------------------------------------
// GitHub App installations
// ---------------------------------------------------------------------------

export type InstallationStatus = "active" | "suspended" | "deleted";

export type InstallationInfo = {
  installationId: number;
  accountId: number | null;
  accountLogin: string | null;
  accountType: string | null;
};

/**
 * Records an installation (from a signed webhook or a verified API response).
 * `claimForUserId` assigns it to a DeployGuard user only if it is unclaimed or
 * already theirs -- an installation is never silently moved between accounts.
 */
export async function upsertInstallation(
  info: InstallationInfo,
  options: {
    status?: InstallationStatus;
    claimForUserId?: string | null;
    /** Phase 10: the GitHub user who installed the app (webhook sender / verified installer). Recorded once. */
    installedByGithubUserId?: number | null;
  } = {}
): Promise<{ userId: string | null; status: InstallationStatus; previousStatus: InstallationStatus | null }> {
  const result = await getPool().query<{
    user_id: string | null;
    status: InstallationStatus;
    previous_status: InstallationStatus | null;
  }>(
    `WITH prev AS (SELECT status FROM github_installations WHERE installation_id = $1)
     INSERT INTO github_installations
       (installation_id, user_id, github_account_id, github_account_login, account_type, status, installed_by_github_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $8)
     ON CONFLICT (installation_id) DO UPDATE SET
       user_id              = COALESCE(github_installations.user_id, EXCLUDED.user_id),
       github_account_id    = COALESCE(EXCLUDED.github_account_id, github_installations.github_account_id),
       github_account_login = COALESCE(EXCLUDED.github_account_login, github_installations.github_account_login),
       account_type         = COALESCE(EXCLUDED.account_type, github_installations.account_type),
       status               = COALESCE($7, github_installations.status),
       installed_by_github_user_id = COALESCE(github_installations.installed_by_github_user_id, EXCLUDED.installed_by_github_user_id),
       updated_at           = now()
     RETURNING user_id, status, (SELECT status FROM prev) AS previous_status`,
    [
      info.installationId,
      options.claimForUserId ?? null,
      info.accountId,
      info.accountLogin,
      info.accountType,
      options.status ?? "active",
      options.status ?? null,
      options.installedByGithubUserId ?? null,
    ]
  );
  const row = result.rows[0];
  return { userId: row.user_id, status: row.status, previousStatus: row.previous_status };
}

export type InstallationRecord = {
  installation_id: string;
  user_id: string | null;
  account_type: string | null;
  github_account_id: string | null;
  installed_by_github_user_id: string | null;
  status: InstallationStatus;
  last_synced_at: Date | null;
};

export async function getInstallation(installationId: number): Promise<InstallationRecord | null> {
  const result = await getPool().query<InstallationRecord>(
    `SELECT installation_id, user_id, account_type, github_account_id, installed_by_github_user_id, status, last_synced_at
     FROM github_installations WHERE installation_id = $1`,
    [installationId]
  );
  return result.rows[0] ?? null;
}

/** Installations to reconcile: not deleted, least recently synced first. */
export async function listInstallationsForReconcile(limit: number): Promise<InstallationRecord[]> {
  const result = await getPool().query<InstallationRecord>(
    `SELECT installation_id, user_id, account_type, github_account_id, installed_by_github_user_id, status, last_synced_at
     FROM github_installations WHERE status <> 'deleted'
     ORDER BY last_synced_at ASC NULLS FIRST LIMIT $1`,
    [limit]
  );
  return result.rows;
}

/** Stamps when an installation's repositories were last reconciled with GitHub. */
export async function markInstallationSynced(installationId: number): Promise<void> {
  await getPool().query(`UPDATE github_installations SET last_synced_at = now() WHERE installation_id = $1`, [installationId]);
}

export async function setInstallationStatus(installationId: number, status: InstallationStatus): Promise<void> {
  await getPool().query(
    `UPDATE github_installations SET status = $2, updated_at = now() WHERE installation_id = $1`,
    [installationId, status]
  );
  if (status === "deleted") {
    await getPool().query(
      `UPDATE repositories SET connected = false, disconnected_at = COALESCE(disconnected_at, now()), updated_at = now()
       WHERE installation_id = $1`,
      [installationId]
    );
  }
}

/** The DeployGuard user a GitHub account belongs to, if they have signed in. */
export async function findUserIdByGithubId(githubUserId: number): Promise<string | null> {
  const result = await getPool().query<{ id: string }>(`SELECT id FROM users WHERE github_user_id = $1`, [githubUserId]);
  return result.rows[0]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export type RepositoryInfo = {
  githubRepositoryId: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch?: string | null;
  private?: boolean | null;
};

/** Adds or reconnects repositories granted to an installation. Returns their DeployGuard ids by GitHub id. */
export async function upsertRepositories(installationId: number, repos: RepositoryInfo[]): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  for (const r of repos) {
    const result = await getPool().query<{ id: string }>(
      `INSERT INTO repositories (github_repository_id, installation_id, owner, name, full_name, default_branch, private)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (github_repository_id) DO UPDATE SET
         installation_id = EXCLUDED.installation_id,
         owner           = EXCLUDED.owner,
         name            = EXCLUDED.name,
         full_name       = EXCLUDED.full_name,
         default_branch  = COALESCE(EXCLUDED.default_branch, repositories.default_branch),
         private         = COALESCE(EXCLUDED.private, repositories.private),
         connected       = true,
         disconnected_at = NULL,
         updated_at      = now()
       RETURNING id`,
      [r.githubRepositoryId, installationId, r.owner, r.name, r.fullName, r.defaultBranch ?? null, r.private ?? null]
    );
    ids.set(r.githubRepositoryId, result.rows[0].id);
  }
  return ids;
}

/** Marks repositories as no longer monitored. History is kept. */
export async function disconnectRepositories(installationId: number, githubRepositoryIds: number[]): Promise<void> {
  if (githubRepositoryIds.length === 0) return;
  await getPool().query(
    `UPDATE repositories SET connected = false, disconnected_at = COALESCE(disconnected_at, now()), updated_at = now()
     WHERE installation_id = $1 AND github_repository_id = ANY($2::bigint[])`,
    [installationId, githubRepositoryIds]
  );
}

/**
 * Makes the stored list match GitHub's full, authoritative list for an
 * installation: listed repositories are (re)connected, everything else of this
 * installation is disconnected. History is never deleted.
 */
export async function replaceInstallationRepositories(installationId: number, repos: RepositoryInfo[]): Promise<void> {
  await upsertRepositories(installationId, repos);
  const keep = repos.map((r) => r.githubRepositoryId);
  await getPool().query(
    `UPDATE repositories SET connected = false, disconnected_at = COALESCE(disconnected_at, now()), updated_at = now()
     WHERE installation_id = $1 AND connected AND NOT (github_repository_id = ANY($2::bigint[]))`,
    [installationId, keep]
  );
  await markInstallationSynced(installationId);
}

/**
 * Phase 10: records a repository seen in an event ONLY if it is unknown. A
 * repository that was disconnected stays disconnected -- a late or redelivered
 * event must not silently re-enable monitoring. (Only an authoritative list
 * from GitHub, or an installation_repositories "added" event, reconnects.)
 */
export async function addRepositoryIfNew(installationId: number, repo: RepositoryInfo): Promise<{ id: string; connected: boolean }> {
  const result = await getPool().query<{ id: string; connected: boolean }>(
    `WITH ins AS (
       INSERT INTO repositories (github_repository_id, installation_id, owner, name, full_name, default_branch, private)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (github_repository_id) DO NOTHING
       RETURNING id, connected)
     SELECT id, connected FROM ins
     UNION ALL
     SELECT id, connected FROM repositories WHERE github_repository_id = $1 AND NOT EXISTS (SELECT 1 FROM ins)`,
    [repo.githubRepositoryId, installationId, repo.owner, repo.name, repo.fullName, repo.defaultBranch ?? null, repo.private ?? null]
  );
  return result.rows[0];
}

/**
 * The monitored repository for a push/workflow event, or null. Only a
 * connected repository of an ACTIVE installation counts as monitored.
 */
export async function findMonitoredRepository(
  installationId: number,
  githubRepositoryId: number
): Promise<{ id: string } | null> {
  const result = await getPool().query<{ id: string }>(
    `SELECT r.id FROM repositories r
     JOIN github_installations i ON i.installation_id = r.installation_id
     WHERE r.github_repository_id = $1 AND r.installation_id = $2
       AND r.connected AND i.status = 'active'`,
    [githubRepositoryId, installationId]
  );
  return result.rows[0] ?? null;
}

/** Who owns an installation in DeployGuard (null = unclaimed or unknown). */
export async function getInstallationOwner(installationId: number): Promise<string | null> {
  const result = await getPool().query<{ user_id: string | null }>(
    `SELECT user_id FROM github_installations WHERE installation_id = $1`,
    [installationId]
  );
  return result.rows[0]?.user_id ?? null;
}

export async function getInstallationStatus(installationId: number): Promise<InstallationStatus | null> {
  const result = await getPool().query<{ status: InstallationStatus }>(
    `SELECT status FROM github_installations WHERE installation_id = $1`,
    [installationId]
  );
  return result.rows[0]?.status ?? null;
}

/** Phase 10: the repositories an installation currently has monitored (for reconciliation). */
export async function listMonitoredRepositories(installationId: number): Promise<
  { id: string; github_repository_id: string; owner: string; name: string; full_name: string }[]
> {
  const result = await getPool().query<{ id: string; github_repository_id: string; owner: string; name: string; full_name: string }>(
    `SELECT r.id, r.github_repository_id, r.owner, r.name, r.full_name
     FROM repositories r JOIN github_installations i ON i.installation_id = r.installation_id
     WHERE r.installation_id = $1 AND r.connected AND i.status = 'active'
     ORDER BY r.updated_at DESC`,
    [installationId]
  );
  return result.rows;
}

export type UserRepository = {
  id: string;
  github_repository_id: string;
  full_name: string;
  private: boolean | null;
  default_branch: string | null;
  /** Connected to an active installation: DeployGuard is receiving its events. */
  monitoring: boolean;
  installation_status: InstallationStatus;
};

/** Every repository the user owns through their installations, monitored or not (history stays theirs). */
export async function listUserRepositories(userId: string): Promise<UserRepository[]> {
  const result = await getPool().query<UserRepository>(
    `SELECT r.id, r.github_repository_id, r.full_name, r.private, r.default_branch,
            (r.connected AND i.status = 'active') AS monitoring, i.status AS installation_status
     FROM repositories r JOIN github_installations i ON i.installation_id = r.installation_id
     WHERE i.user_id = $1
     ORDER BY (r.connected AND i.status = 'active') DESC, r.full_name`,
    [userId]
  );
  return result.rows;
}
