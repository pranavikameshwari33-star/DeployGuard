import type { ReactNode } from "react";
import type {
  DashboardDeployment,
  HistoryRow,
  RiskView,
  SelectedDeployment,
} from "@/lib/dashboard/dashboard-data";
import type { HistoryCounts, IncidentDetail as IncidentDetailData, RepositoryOption } from "@/lib/dashboard/queries";
import type { RecalledMemory as RecalledMemoryData } from "@/lib/dashboard/recalled";
import type { Incident, IncidentListItem } from "@/lib/db/incidents";
import type { UserRepository } from "@/lib/db/accounts";
import type { EvidenceMatch } from "@/lib/risk/validate";
import {
  NOT_DETERMINED,
  absoluteTime,
  basisLabel,
  categoryLabel,
  lastLine,
  relativeTime,
  riskTone,
  groupedSignals,
  shortSha,
  signalLabel,
  statusTone,
  type Tone,
} from "./format";
import type { Links } from "./links";
import { ReanalyzeButton } from "./reanalyze-button";

/**
 * Dashboard sections (Phase 8; Stage 3 adds provenance, the evidence trace,
 * incident detail, the repository switcher and connection states).
 * Presentational server components: they render the data they are given and
 * add nothing to it. Unknown values are shown as "Not determined". Every
 * piece of content is labelled with where it comes from:
 *   OBSERVED FACT        recorded by DeployGuard from GitHub (database)
 *   HISTORICAL EVIDENCE  past deployments and their recorded outcomes (database)
 *   RECALLED MEMORY      Hindsight's paraphrase, for people only (never sent to the AI)
 *   AI REASONING         Gemini's validated answer, based only on the evidence bundle
 */

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge tone-${tone}`}>{children}</span>;
}

export type ProvenanceKind = "observed" | "history" | "memory" | "ai";
const PROVENANCE: Record<ProvenanceKind, string> = {
  observed: "Observed fact",
  history: "Historical evidence",
  memory: "Recalled memory",
  ai: "AI reasoning",
};

/** A text label (never colour alone) saying where a piece of content comes from. */
export function Prov({ kind }: { kind: ProvenanceKind }) {
  return <span className={`prov prov-${kind}`}>{PROVENANCE[kind]}</span>;
}

function Time({ iso }: { iso: string | Date }) {
  return (
    <time dateTime={new Date(iso).toISOString()} title={absoluteTime(iso)} className="nowrap">
      {relativeTime(iso)}
    </time>
  );
}

function Panel({ title, aside, children, id, prov }: { title: string; aside?: ReactNode; children: ReactNode; id?: string; prov?: ProvenanceKind }) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className="panel" id={id} aria-labelledby={headingId}>
      <div className="panel-head">
        <h2 id={headingId}>{title}</h2>
        {prov ? <Prov kind={prov} /> : null}
        {aside ? <div className="aside">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

const Unknown = () => <span className="faint">{NOT_DETERMINED}</span>;

// ---------------------------------------------------------------------------
// Repository switcher (Stage 3)
// ---------------------------------------------------------------------------

export function RepositorySwitcher({ options, current }: { options: RepositoryOption[]; current: string | null }) {
  if (options.length === 0) return null;
  return (
    <form className="switcher" method="get" action="/">
      <label htmlFor="repo-switcher">Repository</label>
      <select id="repo-switcher" name="repo" defaultValue={current ?? ""}>
        <option value="">All repositories ({options.length})</option>
        {options.map((o) => (
          <option key={o.github_repository_id} value={o.github_repository_id}>
            {o.full_name}
          </option>
        ))}
      </select>
      <button type="submit" className="button">Show</button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 1. Deployment detail
// ---------------------------------------------------------------------------

const CI_TEXT: Record<string, string> = {
  RECEIVED: "Waiting for CI to start",
  BUILDING: "CI running",
  SUCCESS: "CI passed",
  FAILED: "CI failed",
  ROLLED_BACK: "Rolled back",
};

export function CurrentDeployment({
  d,
  isLatest,
  links,
  repository,
}: {
  d: DashboardDeployment;
  isLatest: boolean;
  links: Links;
  repository: UserRepository | null;
}) {
  const waitingMinutes =
    d.status === "RECEIVED" || d.status === "BUILDING"
      ? Math.floor((Date.now() - new Date(d.ci_started_at ?? d.created_at).getTime()) / 60000)
      : 0;
  return (
    <Panel
      id="overview"
      title={isLatest ? "Current deployment" : `Deployment #${d.id}`}
      prov="observed"
      aside={isLatest ? `Deployment #${d.id}` : <a href={links.home()}>Show latest deployment</a>}
    >
      <div className="panel-body">
        {repository && repository.connection_state !== "CONNECTED" ? (
          <div className="note" role="note">
            Monitoring is {repository.connection_state === "SUSPENDED" ? "paused (the GitHub App installation is suspended)" : "off (this repository is disconnected)"} for{" "}
            {repository.full_name}. Its history is kept and still shown here; new pushes are not recorded.
          </div>
        ) : null}
        <div>
          <div className="deploy-head">
            <span className="repo">{d.repository}</span>
            <span className="muted">{d.branch}</span>
            <span className="muted num" title={d.commit_sha}>{shortSha(d.commit_sha)}</span>
            <span className="deploy-status">
              <Badge tone={statusTone(d.status)}>{d.status}</Badge>
            </span>
          </div>
          <div className="deploy-message">{d.commit_message || <span className="muted">(no commit message)</span>}</div>
          <div className="deploy-meta">
            <span>{d.author}</span>
            <span className="sep">·</span>
            <span>
              Received <Time iso={d.created_at} />
            </span>
            <span className="sep">·</span>
            <span>{absoluteTime(d.created_at)}</span>
          </div>
        </div>
        <dl className="facts">
          <dt>Commit</dt>
          <dd className="num">{d.commit_sha}</dd>
          <dt>CI status</dt>
          <dd>
            {CI_TEXT[d.status] ?? d.status}
            {d.ci_run_url ? (
              <>
                {" · "}
                <a href={d.ci_run_url} target="_blank" rel="noreferrer">
                  GitHub Actions run #{d.ci_run_id ?? "view"}
                </a>
              </>
            ) : null}
          </dd>
        </dl>
        {waitingMinutes >= 15 ? (
          <div className="note" role="note">
            No CI result for {waitingMinutes} minutes. Either the pipeline is still running, or GitHub did not deliver
            its result (for example during a GitHub API or webhook outage). DeployGuard&apos;s maintenance run reconciles
            missed results with GitHub automatically; nothing is assumed in the meantime.
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 2 + 3. Risk: "Why did DeployGuard give me this risk?" (evidence trace)
// ---------------------------------------------------------------------------

const UNAVAILABLE_TEXT: Record<string, string> = {
  usage_limit: "The analysis usage limit for this repository has been reached, so no new analysis was made. It resets with the next day or month.",
  invalid_answer: "The AI answer did not pass validation against the recorded evidence, so it was rejected and nothing was stored.",
  model_unavailable: "The AI service could not be reached or did not answer in time.",
  other: "The analysis could not produce a valid result.",
};

function ReanalyzeArea({ reanalyze, deploymentId, canAct }: { reanalyze: SelectedDeployment["reanalyze"]; deploymentId: string; canAct: boolean }) {
  if (!reanalyze.offered) return <p className="footnote">{reanalyze.why}</p>;
  return (
    <div>
      <p className="footnote">{reanalyze.why}</p>
      {canAct ? <ReanalyzeButton deploymentId={deploymentId} /> : null}
    </div>
  );
}

function signalsWithPoints(signals: string[]): string[] {
  return signals.map((s) => {
    const points = /\(\+([\d.]+)\)$/.exec(s)?.[1];
    return points ? `${signalLabel(s)} (+${points})` : signalLabel(s);
  });
}

export function RiskPanel({
  risk,
  reanalyze,
  deploymentId,
  links,
  canAct,
  memoryHref,
}: {
  risk: RiskView;
  reanalyze: SelectedDeployment["reanalyze"];
  deploymentId: string;
  links: Links;
  canAct: boolean;
  memoryHref: string | null;
}) {
  if (risk.state !== "assessed") {
    const content =
      risk.state === "pending" ? (
        <>
          <strong>Risk analysis pending</strong>
          <p>The analysis is running. This page refreshes automatically.</p>
        </>
      ) : risk.state === "unavailable" ? (
        <>
          <strong>Risk analysis unavailable</strong>
          <p>{UNAVAILABLE_TEXT[risk.kind]} No risk level is shown, because none was validated.</p>
          {risk.error ? <p className="small">Detail: {risk.error}</p> : null}
        </>
      ) : (
        <>
          <strong>Not analysed</strong>
          <p>No risk analysis has been run for this deployment.</p>
        </>
      );
    return (
      <Panel title="Why this risk?" id="risk">
        <div className="panel-body">
          <div className="state-box">{content}</div>
          <ReanalyzeArea reanalyze={reanalyze} deploymentId={deploymentId} canAct={canAct} />
        </div>
      </Panel>
    );
  }

  const a = risk.assessment;
  const bundle = a.evidence;
  const matchById = new Map(bundle.historical_evidence.matches.map((m) => [m.deployment_id, m]));
  return (
    <Panel
      title="Why this risk?"
      id="risk"
      aside={
        <>
          Generated <Time iso={a.risk_generated_at} /> · {a.model}
          <br />
          Based on pipeline state {risk.basedOnPipeline}
        </>
      }
    >
      <div className="panel-body">
        <div className="risk-head">
          <span className={`risk-level tone-${riskTone(a.risk_level)}`}>{a.risk_level}</span>
          <span className="muted">
            Model-reported confidence <span className="num">{Math.round(a.risk_confidence * 100)}%</span>
          </span>
          <Prov kind="ai" />
        </div>

        {risk.note ? <div className="note">{risk.note}</div> : null}

        <div className="trace">
          <div className="trace-head">
            <span className="label">Why</span>
            <Prov kind="ai" />
          </div>
          <p className="risk-summary">{a.risk_summary}</p>
          <ul className="reasons">
            {a.risk_reasons.map((r, i) => (
              <li key={i}>
                <span className="basis">{basisLabel(r.basis)}</span>
                <span>
                  {r.reason}
                  {r.evidence_deployment_ids.length ? (
                    <span className="cite">
                      {r.evidence_deployment_ids.map((id, j) => (
                        <span key={id}>
                          {j ? ", " : ""}
                          <a href={links.deployment(id)}>#{id}</a>
                        </span>
                      ))}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="trace">
          <div className="trace-head">
            <span className="label">Historical evidence the analysis relied on</span>
            <Prov kind="history" />
          </div>
          {a.historical_evidence.length === 0 ? (
            <p className="muted">
              {bundle.historical_evidence.available
                ? "The analysis cited none of the matching past deployments."
                : "No similar past deployments were found, so no history was available to the analysis."}
            </p>
          ) : (
            <ul className="evidence-list">
              {a.historical_evidence.map((h) => {
                const m = matchById.get(h.deployment_id);
                return (
                  <li key={h.deployment_id}>
                    <div>
                      <a href={links.deployment(h.deployment_id)}>#{h.deployment_id}</a>{" "}
                      <Badge tone={statusTone(h.outcome)}>{h.outcome}</Badge>
                      {h.incident_id ? (
                        <>
                          {" "}
                          <a href={links.incident(h.incident_id)}>Incident #{h.incident_id}</a>
                        </>
                      ) : null}
                      {m ? <span className="muted small"> · match score {m.similarity_score}</span> : null}
                    </div>
                    {h.observed_failure ? <div className="small">Observed failure: {lastLine(h.observed_failure)}</div> : null}
                    {m?.matched_signals.length ? (
                      <div className="small muted">Matched signals: {signalsWithPoints(m.matched_signals).join(" · ")}</div>
                    ) : null}
                    {h.relevance_note ? (
                      <div className="small">
                        <span className="faint">Why it is relevant (AI): </span>
                        {h.relevance_note}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="footnote">
            Outcomes, failures and incident ids are copied from the database, not from the model. Match score is a
            rule-based ranking (points per shared signal), not a probability.
          </p>
        </div>

        <div className="two-col">
          <div className="trace">
            <div className="trace-head">
              <span className="label">Current changes</span>
              <Prov kind="observed" />
            </div>
            <div className="small">
              {bundle.change_analysis.files.length} file(s) ·{" "}
              {bundle.change_analysis.change_categories.map(categoryLabel).join(", ") || "no category"}
              {bundle.change_analysis.affected_services.length ? ` · components: ${bundle.change_analysis.affected_services.join(", ")}` : ""}
            </div>
          </div>
          <div className="trace">
            <div className="trace-head">
              <span className="label">Pipeline evidence</span>
              <Prov kind="observed" />
            </div>
            <div className="small">
              {bundle.current_pipeline.status}: {bundle.current_pipeline.state}
            </div>
          </div>
        </div>

        <div className="trace">
          <div className="trace-head">
            <span className="label">Recommended checks</span>
            <Prov kind="ai" />
          </div>
          <ol className="checks">
            {a.recommended_checks.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ol>
        </div>

        {a.missing_information.length ? (
          <div className="trace">
            <div className="trace-head">
              <span className="label">Missing information</span>
              <Prov kind="ai" />
            </div>
            <ul className="plain-list">
              {a.missing_information.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="footnote">
          The AI saw only the evidence bundle summarised above, built from database records. It did not see recalled
          memory, source code, or anything else. Its answer was validated against that evidence before it was stored;
          confidence is reported by the model and is not statistically calibrated. Checks are recommendations only.
          {memoryHref ? (
            <>
              {" "}
              <a href={memoryHref}>Show recalled memory</a> (for reference; not used by the analysis).
            </>
          ) : null}
        </p>
        <ReanalyzeArea reanalyze={reanalyze} deploymentId={deploymentId} canAct={canAct} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Recalled memory (Stage 3) -- only on explicit request
// ---------------------------------------------------------------------------

export function RecalledMemory({ data, links, closeHref }: { data: RecalledMemoryData; links: Links; closeHref: string }) {
  return (
    <Panel title="Recalled memory" id="memory" prov="memory" aside={<a href={closeHref}>Hide</a>}>
      <div className="panel-body">
        <p className="footnote">
          What Hindsight associates with this deployment, in its own words. It is a paraphrase of DeployGuard&apos;s records,
          is not verified, may be incomplete, and is never sent to the AI analysis. Open the linked deployment for the
          recorded facts.
        </p>
        {data.state === "unavailable" ? (
          <p className="muted">{data.reason}</p>
        ) : data.memories.length === 0 ? (
          <p className="muted">Nothing recalled for this repository.</p>
        ) : (
          <ul className="evidence-list">
            {data.memories.map((m, i) => (
              <li key={i}>
                <div className="small">{m.text}</div>
                {m.deploymentId ? (
                  <div className="small faint">
                    Record: <a href={links.deployment(m.deploymentId)}>deployment #{m.deploymentId}</a>
                    {m.kind ? ` (${m.kind})` : ""}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 4. Change analysis
// ---------------------------------------------------------------------------

const CHANGE_LABEL: Record<string, string> = { added: "Added", modified: "Modified", deleted: "Deleted" };

export function ChangeAnalysis({ d }: { d: DashboardDeployment }) {
  if (!d.file_analysis || !d.change_categories) {
    return (
      <Panel title="Change analysis" prov="observed">
        <div className="empty">This deployment was recorded before change analysis existed.</div>
      </Panel>
    );
  }
  return (
    <Panel title="Change analysis" prov="observed" aside={`${d.file_analysis.length} file(s)`}>
      <div className="panel-body">
        <div className="two-col">
          <div>
            <span className="label">Categories</span>
            <div className="tags">
              {d.change_categories.map((c) => (
                <span className="tag" key={c}>{categoryLabel(c)}</span>
              ))}
            </div>
          </div>
          <div>
            <span className="label">Affected components</span>
            {d.affected_services?.length ? (
              <div className="tags">
                {d.affected_services.map((s) => (
                  <span className="tag" key={s}>{s}</span>
                ))}
              </div>
            ) : (
              <span className="muted">None identified from the file paths</span>
            )}
          </div>
        </div>
      </div>
      <div className="table-wrap bordered-top">
        <table className="data">
          <caption className="visually-hidden">Changed files</caption>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Change</th>
              <th scope="col">Categories</th>
              <th scope="col">Component</th>
            </tr>
          </thead>
          <tbody>
            {d.file_analysis.map((f) => (
              <tr key={f.path}>
                <td className="wrap-any">{f.path}</td>
                <td className="nowrap">{CHANGE_LABEL[f.change_type] ?? f.change_type}</td>
                <td>{f.categories.map(categoryLabel).join(", ")}</td>
                <td className="nowrap">{f.service ?? <span className="faint">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 6. Pipeline status
// ---------------------------------------------------------------------------

function Step({ label, state }: { label: string; state: "done" | "failed" | "active" | "waiting" }) {
  const mark = state === "done" ? "✓" : state === "failed" ? "✕" : state === "active" ? "•" : "";
  const spoken = state === "done" ? "done" : state === "failed" ? "failed" : state === "active" ? "in progress" : "not reached";
  return (
    <span className={`step ${state}`}>
      {label}
      {mark ? <span className="mark" aria-hidden="true">{mark}</span> : null}
      <span className="visually-hidden"> ({spoken})</span>
    </span>
  );
}

export function PipelinePanel({ d, incident, links }: { d: DashboardDeployment; incident: Incident | null; links: Links }) {
  const s = d.status;
  const building: "done" | "active" | "waiting" = s === "BUILDING" ? "active" : s === "RECEIVED" ? "waiting" : "done";
  const final = s === "SUCCESS" ? "SUCCESS" : s === "FAILED" ? "FAILED" : "RESULT";
  const finalState = s === "SUCCESS" ? "done" : s === "FAILED" ? "failed" : "waiting";

  return (
    <Panel title="Pipeline" id="pipeline" prov="observed">
      <div className="panel-body">
        <div className="steps">
          <Step label="RECEIVED" state="done" />
          <span className="arrow" aria-hidden="true">→</span>
          <Step label="BUILDING" state={building} />
          <span className="arrow" aria-hidden="true">→</span>
          <Step label={final} state={finalState} />
        </div>

        <dl className="facts">
          <dt>Run</dt>
          <dd>
            {d.ci_run_url ? (
              <a href={d.ci_run_url} target="_blank" rel="noreferrer">
                #{d.ci_run_id ?? "view"}
              </a>
            ) : (
              <span className="faint">{s === "RECEIVED" ? "Not started" : "Not reported"}</span>
            )}
          </dd>
          <dt>Started</dt>
          <dd>{d.ci_started_at ? absoluteTime(d.ci_started_at) : <span className="faint">—</span>}</dd>
          <dt>Finished</dt>
          <dd>{d.ci_finished_at ? absoluteTime(d.ci_finished_at) : <span className="faint">—</span>}</dd>
          {d.failure ? (
            <>
              <dt>Failed stage</dt>
              <dd>{d.failure.stage ?? <Unknown />}</dd>
              <dt>Failed job</dt>
              <dd>{d.failure.job ?? <Unknown />}</dd>
            </>
          ) : null}
          {incident ? (
            <>
              <dt>Incident</dt>
              <dd>
                <a href={links.incident(incident.id)}>#{incident.id}</a> · {incident.failure_type}
              </dd>
              <dt>Root cause</dt>
              <dd>{incident.root_cause ?? <Unknown />}</dd>
              <dt>Resolution</dt>
              <dd>{incident.resolution ?? <Unknown />}</dd>
            </>
          ) : null}
        </dl>

        {d.failure?.message ? (
          <div>
            <span className="label">Observed failure output (redacted, last lines)</span>
            <pre className="output">{d.failure.message}</pre>
          </div>
        ) : d.failure ? (
          <p className="muted small">No failure output is stored (none was reported, or it passed its retention period).</p>
        ) : null}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 5. Historical evidence
// ---------------------------------------------------------------------------

export function HistoricalEvidence({ evidence, links }: { evidence: SelectedDeployment["evidence"]; links: Links }) {
  const source =
    evidence.source === "assessment"
      ? "Evidence supplied to the risk analysis"
      : "Matches from the deployment database (no risk analysis yet)";
  return (
    <Panel title="Historical evidence" aside={source} id="history-evidence" prov="history">
      {evidence.matches.length === 0 ? (
        <div className="empty">No similar past deployments found. DeployGuard has no history to compare this change with yet.</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <caption className="visually-hidden">Similar past deployments</caption>
            <thead>
              <tr>
                <th scope="col">Deployment</th>
                <th scope="col">Outcome</th>
                <th scope="col">Change</th>
                <th scope="col">Observed failure</th>
                <th scope="col">Matched because</th>
                <th scope="col">Match</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {evidence.matches.map((m: EvidenceMatch) => (
                <tr key={m.deployment_id}>
                  <td className="nowrap">
                    <a href={links.deployment(m.deployment_id)}>#{m.deployment_id}</a>
                    <span className="sub num">{shortSha(m.commit_sha)}</span>
                  </td>
                  <td>
                    <Badge tone={statusTone(m.status)}>{m.status}</Badge>
                  </td>
                  <td className="col-msg">
                    {m.commit_message}
                    <span className="sub">{m.change_categories.map(categoryLabel).join(", ")}</span>
                  </td>
                  <td className="col-msg">
                    {lastLine(m.incident?.error_message ?? m.failure?.message) ?? <span className="faint">—</span>}
                    {m.incident ? (
                      <span className="sub">
                        <a href={links.incident(m.incident.id)}>Incident #{m.incident.id}</a> · root cause{" "}
                        {m.incident.root_cause ?? "not determined"}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {groupedSignals(m.matched_signals).map((line) => (
                      <div key={line} className="small">{line}</div>
                    ))}
                  </td>
                  <td className="nowrap">
                    <span className="num">{m.similarity_score}</span>
                    <span className="sub">{m.relevance}</span>
                  </td>
                  <td>
                    <Time iso={m.created_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="panel-body bordered-top compact">
        <p className="footnote">
          Match score is DeployGuard&apos;s rule-based similarity ranking (shared files, components and categories), not a probability.
        </p>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 7. Deployment history (+ Stage 3 counts and paging)
// ---------------------------------------------------------------------------

function RiskCell({ row }: { row: HistoryRow }) {
  if (row.risk_level) return <Badge tone={riskTone(row.risk_level)}>{row.risk_level}</Badge>;
  if (row.risk_analysis_status === "pending") return <span className="muted small">Pending</span>;
  if (row.risk_analysis_status === "unavailable") return <span className="muted small">Unavailable</span>;
  return <span className="faint">—</span>;
}

export function HistoryCountsBar({ counts }: { counts: HistoryCounts }) {
  const s = counts.byStatus;
  const inProgress = (s.RECEIVED ?? 0) + (s.BUILDING ?? 0);
  return (
    <dl className="counts" aria-label="Deployment counts">
      <div><dt>Deployments</dt><dd className="num">{counts.total}</dd></div>
      <div><dt>Succeeded</dt><dd className="num">{s.SUCCESS ?? 0}</dd></div>
      <div><dt>Failed</dt><dd className="num">{s.FAILED ?? 0}</dd></div>
      <div><dt>In progress</dt><dd className="num">{inProgress}</dd></div>
      <div><dt>Incidents</dt><dd className="num">{counts.incidents}</dd></div>
      <div><dt>Risk HIGH / MEDIUM / LOW</dt><dd className="num">{counts.byRisk.HIGH} / {counts.byRisk.MEDIUM} / {counts.byRisk.LOW}</dd></div>
      <div><dt>Not assessed</dt><dd className="num">{counts.byRisk.none}</dd></div>
    </dl>
  );
}

export function DeploymentHistory({
  rows,
  selectedId,
  counts,
  page,
  links,
}: {
  rows: HistoryRow[];
  selectedId: string | null;
  counts: HistoryCounts;
  page: { offset: number; limit: number; hasMore: boolean };
  links: Links;
}) {
  const from = page.offset + 1;
  const to = page.offset + rows.length;
  return (
    <Panel title="Deployment and risk history" aside={`${from}-${to} of ${counts.total}`} id="deployments">
      <div className="panel-body compact">
        <HistoryCountsBar counts={counts} />
        <p className="footnote">Plain counts of recorded deployments. Risk is the latest validated assessment of each deployment.</p>
      </div>
      <div className="table-wrap bordered-top">
        <table className="data">
          <caption className="visually-hidden">Deployment history</caption>
          <thead>
            <tr>
              <th scope="col">Commit</th>
              <th scope="col">Repository</th>
              <th scope="col">Branch</th>
              <th scope="col">Changed components</th>
              <th scope="col">Risk</th>
              <th scope="col">Outcome</th>
              <th scope="col">Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.id === selectedId ? "selected" : undefined} aria-current={r.id === selectedId ? "true" : undefined}>
                <td className="col-msg">
                  <a href={links.deployment(r.id)} className="num">
                    {shortSha(r.commit_sha)}
                  </a>
                  <span className="sub truncate" title={r.commit_message}>
                    {r.commit_message}
                  </span>
                </td>
                <td>{r.repository}</td>
                <td>{r.branch}</td>
                <td>
                  {r.affected_services?.length ? (
                    r.affected_services.join(", ")
                  ) : (
                    <span className="faint">{r.change_categories ? "None identified" : "—"}</span>
                  )}
                </td>
                <td>
                  <RiskCell row={r} />
                </td>
                <td>
                  <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                </td>
                <td>
                  <Time iso={r.created_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {page.offset > 0 || page.hasMore ? (
        <nav className="pager panel-body bordered-top compact" aria-label="History pages">
          {page.offset > 0 ? <a href={links.page(Math.max(0, page.offset - page.limit))}>← Newer</a> : <span />}
          {page.hasMore ? <a href={links.page(page.offset + page.limit)}>Older →</a> : null}
        </nav>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// GitHub connection management (Stage 3)
// ---------------------------------------------------------------------------

const STATE_TEXT: Record<UserRepository["connection_state"], { label: string; tone: Tone; help: string }> = {
  CONNECTED: { label: "CONNECTED", tone: "green", help: "Monitored: pushes and CI results are recorded." },
  SUSPENDED: { label: "SUSPENDED", tone: "amber", help: "The installation is suspended on GitHub. Monitoring is paused; unsuspend it on GitHub to resume." },
  DISCONNECTED: { label: "DISCONNECTED", tone: "gray", help: "Not monitored (removed from the installation, or the app was uninstalled). History is kept." },
};

function installationSettingsUrl(r: UserRepository): string {
  const id = encodeURIComponent(r.installation_id);
  return r.account_type === "Organization" && r.account_login
    ? `https://github.com/organizations/${encodeURIComponent(r.account_login)}/settings/installations/${id}`
    : `https://github.com/settings/installations/${id}`;
}

export function ConnectedRepositories({ repositories, links }: { repositories: UserRepository[]; links: Links }) {
  return (
    <Panel title="GitHub connections" id="repositories" aside={<a href="/auth/github/install">Connect another repository</a>}>
      <div className="panel-body">
        <ul className="repo-list">
          {repositories.map((r) => {
            const st = STATE_TEXT[r.connection_state];
            return (
              <li key={r.id}>
                <div className="repo-line">
                  <a href={links.repo(r.github_repository_id)} className="wrap-any">{r.full_name}</a>
                  {r.private ? <span className="faint small">private</span> : null}
                  <Badge tone={st.tone}>{st.label}</Badge>
                </div>
                <div className="small muted">
                  {st.help}{" "}
                  <a href={installationSettingsUrl(r)} target="_blank" rel="noreferrer">
                    {r.connection_state === "CONNECTED" ? "Stop monitoring or change repositories on GitHub" : "Manage on GitHub"}
                  </a>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="footnote">
          Access is read-only and limited to the repositories you selected on GitHub. To stop monitoring a repository,
          remove it from the DeployGuard installation (or uninstall the app) on GitHub; DeployGuard keeps its history
          until you purge it. To connect another repository, use &ldquo;Connect another repository&rdquo;.
        </p>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 8. Incident history and incident detail
// ---------------------------------------------------------------------------

export function IncidentHistory({ rows, links }: { rows: IncidentListItem[]; links: Links }) {
  return (
    <Panel title="Incident history" aside={rows.length ? `Latest ${rows.length}` : undefined} id="incidents" prov="observed">
      {rows.length === 0 ? (
        <div className="empty">No incidents recorded.</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <caption className="visually-hidden">Incident history</caption>
            <thead>
              <tr>
                <th scope="col">Incident</th>
                <th scope="col">Deployment</th>
                <th scope="col">Failure stage</th>
                <th scope="col">Affected component</th>
                <th scope="col">Observed failure</th>
                <th scope="col">Resolution</th>
                <th scope="col">Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td className="nowrap">
                    <a href={links.incident(i.id)}>#{i.id}</a>
                    <span className="sub">{i.failure_type}</span>
                  </td>
                  <td className="nowrap">
                    <a href={links.deployment(i.deployment_id)}>#{i.deployment_id}</a>
                    <span className="sub">{i.repository}</span>
                  </td>
                  <td>{i.failure_stage ?? <Unknown />}</td>
                  <td>{i.affected_service ?? <Unknown />}</td>
                  <td className="col-msg">{lastLine(i.error_message) ?? <Unknown />}</td>
                  <td>{i.resolution ?? <Unknown />}</td>
                  <td>
                    <Time iso={i.created_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

export function IncidentDetail({ data, links }: { data: IncidentDetailData; links: Links }) {
  const { incident: i, deployment: d, related } = data;
  return (
    <Panel title={`Incident #${i.id}`} id="incident" prov="observed" aside={<a href={links.home()}>Back to dashboard</a>}>
      <div className="panel-body">
        <dl className="facts">
          <dt>Deployment</dt>
          <dd>
            <a href={links.deployment(d.id)}>#{d.id}</a> · {d.owner}/{d.repository} · {d.branch} ·{" "}
            <span className="num">{shortSha(d.commit_sha)}</span> · <Badge tone={statusTone(d.status)}>{d.status}</Badge>
          </dd>
          <dt>Recorded</dt>
          <dd>{absoluteTime(i.created_at)}</dd>
          <dt>Failure type</dt>
          <dd>{i.failure_type}</dd>
          <dt>Failure stage</dt>
          <dd>{d.failure_stage ?? <Unknown />}</dd>
          <dt>Failed job</dt>
          <dd>{i.failure_job ?? d.failure_job ?? <Unknown />}</dd>
          <dt>Service</dt>
          <dd>{i.affected_service ?? <Unknown />}</dd>
          <dt>Downstream effect</dt>
          <dd>{i.downstream_effect ?? <Unknown />}</dd>
          <dt>Root cause</dt>
          <dd>{i.root_cause ?? <Unknown />}</dd>
          <dt>Resolution</dt>
          <dd>{i.resolution ?? <Unknown />}</dd>
          <dt>CI run</dt>
          <dd>
            {d.ci_run_url && /^https:\/\/github\.com\//.test(d.ci_run_url) ? (
              <a href={d.ci_run_url} target="_blank" rel="noreferrer">GitHub Actions run #{d.ci_run_id ?? "view"}</a>
            ) : (
              <Unknown />
            )}
          </dd>
        </dl>
        <p className="footnote">
          Everything above was observed by DeployGuard from the pipeline. Root cause, resolution, service and downstream
          effect are only filled in when they are actually known; DeployGuard never guesses them.
        </p>
        <div>
          <span className="label">Observed output (redacted, last lines)</span>
          {i.error_message ? <pre className="output">{i.error_message}</pre> : <p className="muted small">No output is stored (none was reported, or it passed its retention period).</p>}
        </div>
        <div>
          <span className="label">Other incidents of this repository with the same failure type</span>
          {related.length === 0 ? (
            <p className="muted small">None recorded.</p>
          ) : (
            <ul className="plain-list">
              {related.map((r) => (
                <li key={r.id}>
                  <a href={links.incident(r.id)}>Incident #{r.id}</a> on <a href={links.deployment(r.deployment_id)}>deployment #{r.deployment_id}</a>{" "}
                  ({r.branch}, <Time iso={r.created_at} />)
                </li>
              ))}
            </ul>
          )}
          <p className="footnote">Same failure type is an observation, not a claim that the incidents share a cause.</p>
        </div>
      </div>
    </Panel>
  );
}
