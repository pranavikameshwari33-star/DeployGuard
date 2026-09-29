import { redirect } from "next/navigation";
import { getDashboardData } from "@/lib/dashboard/dashboard-data";
import { getViewer, scopeOf } from "@/lib/auth/session";
import { AutoRefresh } from "./_components/auto-refresh";
import { absoluteTime } from "./_components/format";
import {
  ChangeAnalysis,
  ConnectedRepositories,
  CurrentDeployment,
  DeploymentHistory,
  HistoricalEvidence,
  IncidentHistory,
  PipelinePanel,
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

/**
 * The DeployGuard dashboard (Phase 8, scoped per user since Phase 9).
 *
 * Server-rendered from getDashboardData(), which reads PostgreSQL only: no
 * credentials reach the browser, and loading or refreshing this page never
 * calls Gemini. A signed-in user sees only their connected repositories;
 * anonymous visitors are sent to /login. `?id=<deploymentId>` shows a
 * specific deployment.
 */
export default async function Dashboard({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const viewer = await getViewer();
  if (!viewer) redirect("/login");

  const params = await searchParams;
  const raw = params.id;
  const requested = typeof raw === "string" && /^\d{1,19}$/.test(raw) ? raw : undefined;
  const connect = typeof params.connect === "string" ? CONNECT_MESSAGES[params.connect] : undefined;

  const data = await getDashboardData({ deploymentId: requested, scope: scopeOf(viewer) });
  const selected = data.selected;
  const user = viewer.kind === "user" ? viewer : null;
  const hasRepositories = !user || user.repositories.length > 0;

  // Keep the page current while CI or risk analysis is still in progress.
  const inProgress =
    selected !== null &&
    (selected.deployment.status === "RECEIVED" ||
      selected.deployment.status === "BUILDING" ||
      selected.deployment.risk_analysis_status === "pending");

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <a href="/" className="brand" style={{ textDecoration: "none" }}>
            DeployGuard
          </a>
          <nav className="nav">
            <a href="#overview">Overview</a>
            <a href="#deployments">Deployments</a>
            <a href="#incidents">Incidents</a>
            {user ? <a href="#repositories">Repositories</a> : null}
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
      {inProgress ? <AutoRefresh /> : null}

      <main className="page">
        {connect ? <div className="note">{connect}</div> : null}

        {data.notFound ? (
          <section className="panel">
            <div className="empty">
              <strong>Deployment #{requested} not found.</strong>
              <a href="/">Show the latest deployment</a>
            </div>
          </section>
        ) : null}

        {!hasRepositories ? (
          <section className="panel" id="overview">
            <div className="empty">
              <strong>No repositories connected.</strong>
              <p style={{ margin: "2px 0 12px" }}>Connect a GitHub repository to begin monitoring deployments.</p>
              <a className="button button-primary" href="/auth/github/install">
                Connect GitHub repositories
              </a>
            </div>
          </section>
        ) : selected ? (
          <>
            <CurrentDeployment d={selected.deployment} isLatest={!requested || selected.deployment.id === data.history[0]?.id} />
            <div className="grid">
              <div className="stack">
                <RiskPanel risk={selected.risk} />
                <ChangeAnalysis d={selected.deployment} />
              </div>
              <div className="stack">
                <PipelinePanel d={selected.deployment} incident={selected.incident} />
                {user ? <ConnectedRepositories repositories={user.repositories} /> : null}
              </div>
            </div>
            <HistoricalEvidence evidence={selected.evidence} />
          </>
        ) : !data.notFound ? (
          <>
            <section className="panel" id="overview">
              <div className="empty">
                <strong>No deployments yet.</strong>
                Push a change to your connected repository to begin monitoring.
              </div>
            </section>
            {user ? <ConnectedRepositories repositories={user.repositories} /> : null}
          </>
        ) : null}

        {data.history.length ? (
          <DeploymentHistory rows={data.history} selectedId={selected?.deployment.id ?? null} />
        ) : null}
        {data.history.length ? <IncidentHistory rows={data.incidents} /> : null}
      </main>
    </>
  );
}
