import {
  getInstallation,
  markInstallationSynced,
  replaceInstallationRepositories,
  setInstallationStatus,
  upsertInstallation,
  type InstallationStatus,
  type User,
} from "@/lib/db/accounts";
import {
  GitHubApiError,
  forgetInstallationToken,
  getAppInstallation,
  listInstallationRepositories,
  listUserInstallations,
  type GitHubRepo,
} from "@/lib/github/app";

/**
 * Phase 9/10: linking GitHub App installations to DeployGuard users, and
 * keeping them in step with GitHub.
 *
 * An installation is attached to a user only when GitHub itself confirms,
 * through the user's own token, that the user can access it. An
 * installation_id arriving in a redirect URL is a hint, never proof.
 *
 * Organisation installations (Phase 10): many people can "access" an org
 * installation, so access alone is not enough to own it in DeployGuard. An
 * unclaimed installation is linked to a user only if
 *   - it is the user's own personal account, or
 *   - GitHub told us this user installed it (installation webhook `sender`), or
 *   - the user just completed DeployGuard's install flow for it.
 * An installation already linked to someone is never moved.
 */

export function toRepositoryInfo(r: GitHubRepo) {
  return {
    githubRepositoryId: r.id,
    owner: r.owner?.login ?? r.full_name.split("/")[0],
    name: r.name,
    fullName: r.full_name,
    defaultBranch: r.default_branch ?? null,
    private: r.private ?? null,
  };
}

/** Pulls the installation's current repository list from GitHub and stores it (authoritative). */
export async function syncInstallationRepositories(installationId: number): Promise<number> {
  const repos = await listInstallationRepositories(installationId);
  await replaceInstallationRepositories(installationId, repos.map(toRepositoryInfo));
  return repos.length;
}

export type ReconcileInstallationResult = {
  installationId: number;
  status: InstallationStatus | "unchanged-error";
  repositories?: number;
  note?: string;
};

/**
 * Phase 10: brings one installation back in line with GitHub, for when
 * webhooks were missed.
 *   uninstalled on GitHub  -> deleted, repositories disconnected (history kept)
 *   suspended              -> suspended, no monitoring
 *   active                 -> active, repository list replaced by GitHub's
 * A transient GitHub error changes nothing.
 */
export async function reconcileInstallation(installationId: number): Promise<ReconcileInstallationResult> {
  let remote;
  try {
    remote = await getAppInstallation(installationId);
  } catch (error) {
    if (error instanceof GitHubApiError && error.kind === "not_found") {
      await setInstallationStatus(installationId, "deleted");
      forgetInstallationToken(installationId);
      console.log(`[DeployGuard][reconcile] Installation ${installationId} no longer exists on GitHub -- marked deleted.`);
      return { installationId, status: "deleted" };
    }
    return { installationId, status: "unchanged-error", note: (error as Error).message };
  }

  const info = {
    installationId,
    accountId: remote.account?.id ?? null,
    accountLogin: remote.account?.login ?? null,
    accountType: remote.account?.type ?? null,
  };

  if (remote.suspended_at) {
    await upsertInstallation(info, { status: "suspended" });
    forgetInstallationToken(installationId);
    await markInstallationSynced(installationId);
    return { installationId, status: "suspended" };
  }

  const { previousStatus } = await upsertInstallation(info, { status: "active" });
  try {
    const repositories = await syncInstallationRepositories(installationId);
    if (previousStatus && previousStatus !== "active") {
      console.log(`[DeployGuard][reconcile] Installation ${installationId} is active again (${repositories} repositories).`);
    }
    return { installationId, status: "active", repositories };
  } catch (error) {
    return { installationId, status: "active", note: `repository sync failed: ${(error as Error).message}` };
  }
}

export type ClaimResult = {
  /** Installations now owned by this user (including ones they already owned). */
  owned: number[];
  /** Installations the user can access but that another DeployGuard account already owns. */
  ownedByOthers: number[];
  /** Organisation installations this user can access but did not install (left unlinked). */
  notClaimable: number[];
  /** Whether the installation_id from the redirect (if any) was confirmed for this user. */
  requestedConfirmed: boolean | null;
};

export async function claimUserInstallations(
  userToken: string,
  user: User,
  requestedInstallationId?: number
): Promise<ClaimResult> {
  const installations = await listUserInstallations(userToken);
  const result: ClaimResult = { owned: [], ownedByOthers: [], notClaimable: [], requestedConfirmed: null };
  const githubUserId = Number(user.github_user_id);

  for (const inst of installations) {
    const existing = await getInstallation(inst.id);
    const justInstalledByUser = inst.id === requestedInstallationId;
    const personal = inst.account?.type === "User" && inst.account.id === githubUserId;
    const recordedInstaller = existing?.installed_by_github_user_id === String(githubUserId);

    if (!existing?.user_id && !personal && !recordedInstaller && !justInstalledByUser) {
      result.notClaimable.push(inst.id);
      continue;
    }

    const { userId } = await upsertInstallation(
      {
        installationId: inst.id,
        accountId: inst.account?.id ?? null,
        accountLogin: inst.account?.login ?? null,
        accountType: inst.account?.type ?? null,
      },
      {
        claimForUserId: user.id,
        status: "active",
        installedByGithubUserId: justInstalledByUser || personal ? githubUserId : null,
      }
    );

    if (userId !== user.id) {
      result.ownedByOthers.push(inst.id);
      continue;
    }
    result.owned.push(inst.id);

    if (existing?.user_id !== user.id || justInstalledByUser || !existing?.last_synced_at) {
      try {
        await syncInstallationRepositories(inst.id);
      } catch (error) {
        // Webhooks and the maintenance run keep the list in sync too.
        console.error(`[DeployGuard][github] Repository sync failed for installation ${inst.id}: ${(error as Error).message}`);
      }
    }
  }

  if (requestedInstallationId !== undefined) {
    result.requestedConfirmed = result.owned.includes(requestedInstallationId);
  }
  return result;
}
