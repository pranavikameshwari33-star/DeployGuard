import { redirect } from "next/navigation";
import { getDashboardData } from "@/lib/dashboard/dashboard-data";
import { getIncidentDetail, listRepositoryOptions, type RepositoryOption } from "@/lib/dashboard/queries";
import { recallForDeployment, type RecalledMemory as RecalledMemoryData } from "@/lib/dashboard/recalled";
import { getDeploymentById } from "@/lib/db/deployments";
import { getViewer, scopeOf } from "@/lib/auth/session";
import { askHistory, type AskResult } from "@/lib/learning/ask-history";
import { AutoRefresh } from "./_components/auto-refresh";
import { absoluteTime } from "./_components/format";
import { makeLinks } from "./_components/links";
import {
  AccuracyRecordPanel,
  AskHistory,
  ChangeAnalysis,
  FailurePatterns,
  ConnectedRepositories,
  CurrentDeployment,
  DeploymentHistory,
  HistoricalEvidence,
  IncidentDetail,
  IncidentHistory,
  PipelinePanel,
  RecalledMemory,
  RepositorySwitcher,
  RiskPanel,
} from "./_components/sections";

// Always render from the latest database state.
export const dynamic = "force-dynamic";

const CONNECT_MESSAGES: Record<string, string> = {
  done: "Repositories connected. DeployGuard will analyse the next push to them.",
  requested: "Installation requested. An organisation owner must approve it on GitHub before monitoring starts.",
  account_mismatch: "That installation was authorised by a different GitHub account than the one you are signed in with.",
  taken: "That installation is already connected to another DeployGuard account.",
  unverified: "GitHub did not confirm that installation for your account, so it was not connected.",
  error: "The repository connection could not be completed. Please try again.",
};

const isId = (v: unknown): v is string => typeof v === "string" && /^\d{1,19}$/.test(v);

/**
 * The DeployGuard dashboard (Phase 8; scoped per user since Phase 9; Stage 3
 * adds the repository switcher, evidence trace, incident detail and states).
 *
 * Server-rendered from PostgreSQL: no credentials reach the browser, and
 * loading or refreshing this page never calls Gemini. Hindsight is only asked
 * when the user explicitly clicks "Show recalled memory" (?memory=1).
 *
 *   ?repo=<GitHub repository id>   narrow everything to one of YOUR repositories
 *   ?id=<deployment id>            show a specific deployment
 *   ?incident=<incident id>        incident detail
 *   ?offset=<n>                    history paging
 *   ?ask=<question>                Stage 4.6: ask your history (explicit; the only page load that asks Hindsight besides ?memory=1)
 */
export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");

  const params = await searchParams;
  const user = viewer.kind === "user" ? viewer : null;
  const scope = scopeOf(viewer);

  // Repository switcher: options are the viewer's own repositories (users) or every known repository (internal).
  const options: RepositoryOption[] = user
    ? user.repositories.map((r) => ({ github_repository_id: String(r.github_repository_id), full_name: r.full_name }))
    : await listRepositoryOptions();
  const requestedRepo = isId(params.repo) ? params.repo : null;
  // A repository that is not one of the viewer's is ignored (and said so), never shown.
  const repo = requestedRepo && options.some((o) => o.github_repository_id === requestedRepo) ? requestedRepo : null;
  const repoName = repo ? options.find((o) => o.github_repository_id === repo)?.full_name ?? null : null;
  const links = makeLinks(repo);

  const requested = isId(params.id) ? params.id : undefined;
  const incidentId = isId(params.incident) ? params.incident : undefined;
  const offset = isId(params.offset) ? Math.min(Number(params.offset), 100_000) : 0;
  const connect = typeof params.connect === "string" ? CONNECT_MESSAGES[params.connect] : undefined;
  const hasRepositories = !user || user.repositories.length > 0;

  const incident = incidentId ? await getIncidentDetail(incidentId, { scope, githubRepositoryId: repo }) : null;
  const data = incidentId
    ? null
    : await getDashboardData({ deploymentId: requested, scope, githubRepositoryId: repo, historyOffset: offset });
  const selected = data?.selected ?? null;

  // Recalled memory: only on explicit request, only for a deployment the viewer can see.
  let memory: RecalledMemoryData | null = null;
  if (params.memory === "1" && selected) {
    const raw = await getDeploymentById(selected.deployment.id);
    if (raw) memory = await recallForDeployment(raw, user ? `user:${user.user.id}` : "internal");
  }

  // Stage 4.6: answered only when the user submitted a question. Scope = the
  // viewer's repositories (narrowed by the switcher), in SQL and in Hindsight.
  let ask: AskResult | null = null;
  if (typeof params.ask === "string" && hasRepositories && !incidentId) {
    const githubRepositoryIds = repo ? [repo] : options.map((o) => o.github_repository_id);
    ask = await askHistory({
      question: params.ask,
      scope: { scope, githubRepositoryId: repo },
      githubRepositoryIds,
      actorKey: user ? `user:${user.user.id}` : "internal",
    });
  }

  const currentRepository =
    user && selected ? user.repositories.find((r) => String(r.github_repository_id) === selected.deployment.github_repository_id) ?? null : null;
  const allDisconnected = user ? user.repositories.length > 0 && user.repositories.every((r) => r.connection_state !== "CONNECTED") : false;

  // Keep the page current while CI or risk analysis is still in progress.
  const inProgress =
    selected !== null &&
    (selected.deployment.status === "RECEIVED" ||
      selected.deployment.status === "BUILDING" ||
      selected.deployment.risk_analysis_status === "pending");

  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="topbar">
        <div className="topbar-inner">
          <a href="/" className="brand">DeployGuard</a>
          <nav className="nav" aria-label="Sections">
            <a href={`${links.home()}#overview`}>Overview</a>
            <a href={`${links.home()}#deployments`}>Deployments</a>
            <a href={`${links.home()}#incidents`}>Incidents</a>
            <a href={`${links.home()}#ask`}>Ask</a>
            <a href={`${links.home()}#patterns`}>Learning</a>
            {user ? <a href={`${links.home()}#repositories`}>Connections</a> : null}
          </nav>
          <span className="topbar-meta">
            {inProgress ? "Updating automatically · " : ""}Loaded {absoluteTime(new Date())}
          </span>
          {user ? (
            <div className="identity">
              {user.user.avatar_url ? <img src={user.user.avatar_url} alt="" /> : null}
              <span>@{user.user.github_login}</span>
              <form action="/auth/logout" method="post">
                <button type="submit" className="button-link">
                  Log out
                </button>
              </form>
            </div>
          ) : null}
        </div>
      </header>
      {inProgress && !incidentId ? <AutoRefresh /> : null}

      <main className="page" id="main">
        {connect ? <div className="note" role="status">{connect}</div> : null}

        {hasRepositories ? (
          <div className="context-bar">
            <RepositorySwitcher options={options} current={repo} />
            <span className="muted small">
              {repoName ? <>Showing <strong>{repoName}</strong>. </> : "Showing all your repositories. "}
              {requestedRepo && !repo ? "The requested repository is not one of yours, so it is not shown." : null}
            </span>
          </div>
        ) : null}

        {!hasRepositories ? (
          <section className="panel" id="overview" aria-labelledby="welcome-title">
            <div className="panel-body">
              <h2 id="welcome-title">Welcome to DeployGuard</h2>
              <p>DeployGuard watches the repositories you choose, remembers what happened to past deployments, and warns you with reasons when a new change looks risky. It is advisory: it never blocks or changes anything.</p>
              <ol className="checks">
                <li>Connect one or more GitHub repositories (read-only access you choose on GitHub).</li>
                <li>Push a change. DeployGuard records it, analyses which files changed, and follows its GitHub Actions run.</li>
                <li>Open the dashboard to see the risk, the evidence behind it, and the outcome.</li>
              </ol>
              <a className="button button-primary" href="/auth/github/install">
                Connect GitHub repositories
              </a>
            </div>
          </section>
        ) : incidentId ? (
          incident ? (
            <IncidentDetail data={incident} links={links} canConfirm={Boolean(user)} />
          ) : (
            <section className="panel">
              <div className="empty">
                <strong>Incident #{incidentId} not found.</strong>
                <a href={links.home()}>Back to the dashboard</a>
              </div>
            </section>
          )
        ) : data?.notFound ? (
          <section className="panel">
            <div className="empty">
              <strong>Deployment #{requested} not found.</strong>
              <a href={links.home()}>Show the latest deployment</a>
            </div>
          </section>
        ) : selected ? (
          <>
            <CurrentDeployment
              d={selected.deployment}
              isLatest={!requested || selected.deployment.id === data?.history[0]?.id}
              links={links}
              repository={currentRepository}
            />
            <div className="grid">
              <div className="stack">
                <RiskPanel
                  risk={selected.risk}
                  reanalyze={selected.reanalyze}
                  deploymentId={selected.deployment.id}
                  links={links}
                  canAct={Boolean(user)}
                  memoryHref={memory ? null : links.memory(selected.deployment.id)}
                />
                {memory ? <RecalledMemory data={memory} links={links} closeHref={links.deployment(selected.deployment.id)} /> : null}
                <ChangeAnalysis d={selected.deployment} />
              </div>
              <div className="stack">
                <PipelinePanel d={selected.deployment} incident={selected.incident} reverts={selected.reverts} links={links} />
                {user ? <ConnectedRepositories repositories={user.repositories} links={links} /> : null}
              </div>
            </div>
            <HistoricalEvidence evidence={selected.evidence} links={links} />
          </>
        ) : (
          <>
            <section className="panel" id="overview">
              <div className="empty">
                <strong>{repoName ? `No deployments recorded for ${repoName} yet.` : "No deployments yet."}</strong>
                {allDisconnected
                  ? "None of your repositories is currently monitored. Reconnect one on GitHub to record new pushes."
                  : "Push a change to a connected repository. It appears here within seconds of GitHub delivering the push."}
              </div>
            </section>
            {user ? <ConnectedRepositories repositories={user.repositories} links={links} /> : null}
          </>
        )}

        {data && data.history.length ? (
          <DeploymentHistory rows={data.history} selectedId={selected?.deployment.id ?? null} counts={data.counts} page={data.page} links={links} />
        ) : null}
        {data && data.history.length ? <IncidentHistory rows={data.incidents} links={links} /> : null}
        {data && hasRepositories ? <AskHistory result={ask} repo={repo} links={links} /> : null}
        {data && data.history.length ? (
          <FailurePatterns patterns={data.learning.patterns} windowDays={data.learning.windowDays} links={links} />
        ) : null}
        {data && data.history.length ? <AccuracyRecordPanel record={data.learning.accuracy} links={links} /> : null}
      </main>
    </>
  );
}
