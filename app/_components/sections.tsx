import type { ReactNode } from "react";
import type {
  DashboardDeployment,
  HistoryRow,
  RiskView,
  SelectedDeployment,
} from "@/lib/dashboard/dashboard-data";
import type { Incident, IncidentListItem } from "@/lib/db/incidents";
import type { UserRepository } from "@/lib/db/accounts";
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
  statusTone,
  type Tone,
} from "./format";

/**
 * Dashboard sections (Phase 8). Presentational server components: they render
 * the data they are given and add nothing to it. Unknown values are shown as
 * "Not determined", never filled in.
 */

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge tone-${tone}`}>{children}</span>;
}

function Time({ iso }: { iso: string | Date }) {
  return (
    <time dateTime={new Date(iso).toISOString()} title={absoluteTime(iso)} className="nowrap">
      {relativeTime(iso)}
    </time>
  );
}

function Panel({ title, aside, children, id }: { title: string; aside?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="panel" id={id}>
      <div className="panel-head">
        <h2>{title}</h2>
        {aside ? <div className="aside">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

const deploymentLink = (id: string) => `/?id=${id}`;

// ---------------------------------------------------------------------------
// 1. Current deployment
// ---------------------------------------------------------------------------

export function CurrentDeployment({ d, isLatest }: { d: DashboardDeployment; isLatest: boolean }) {
  return (
    <Panel
      id="overview"
      title={isLatest ? "Current deployment" : `Deployment #${d.id}`}
      aside={isLatest ? `Deployment #${d.id}` : <a href="/">Show latest deployment</a>}
    >
      <div className="panel-body">
        <div>
          <div className="deploy-head">
            <span className="repo">{d.repository}</span>
            <span className="muted">{d.branch}</span>
            <span className="muted num" title={d.commit_sha}>{shortSha(d.commit_sha)}</span>
            <span style={{ marginLeft: "auto" }}>
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
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 2 + 3. Risk assessment, reasons, recommended checks
// ---------------------------------------------------------------------------

export function RiskPanel({ risk }: { risk: RiskView }) {
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
          <p>
            The analysis could not produce a valid result, so no risk level is shown.
            {risk.error ? <span className="small" style={{ display: "block", marginTop: 4 }}>Reason: {risk.error}</span> : null}
          </p>
        </>
      ) : (
        <>
          <strong>Not analysed</strong>
          <p>No risk analysis has been run for this deployment.</p>
        </>
      );
    return (
      <Panel title="Deployment risk">
        <div className="panel-body">
          <div className="state-box">{content}</div>
        </div>
      </Panel>
    );
  }

  const a = risk.assessment;
  return (
    <Panel
      title="Deployment risk"
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
        </div>

        {risk.note ? <div className="note">{risk.note}</div> : null}

        <p className="risk-summary">{a.risk_summary}</p>

        <div>
          <span className="label">Why this risk was identified</span>
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
                          <a href={deploymentLink(id)}>#{id}</a>
                        </span>
                      ))}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <span className="label">Recommended checks</span>
          <ol className="checks">
            {a.recommended_checks.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ol>
        </div>

        {a.missing_information.length ? (
          <div>
            <span className="label">Not known from the evidence</span>
            <ul className="plain-list">
              {a.missing_information.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="footnote">
          Reasons and cited deployments are validated against the recorded evidence before they are stored.
          Confidence is reported by the model and is not statistically calibrated. Checks are recommendations only.
        </p>
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
      <Panel title="Change analysis">
        <div className="empty">This deployment was recorded before change analysis existed.</div>
      </Panel>
    );
  }
  return (
    <Panel title="Change analysis" aside={`${d.file_analysis.length} file(s)`}>
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
      <div className="table-wrap" style={{ borderTop: "1px solid var(--border)" }}>
        <table className="data">
          <thead>
            <tr>
              <th>File</th>
              <th>Change</th>
              <th>Categories</th>
              <th>Component</th>
            </tr>
          </thead>
          <tbody>
            {d.file_analysis.map((f) => (
              <tr key={f.path}>
                <td style={{ overflowWrap: "anywhere" }}>{f.path}</td>
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
  return (
    <span className={`step ${state}`}>
      {label}
      {mark ? <span className="mark">{mark}</span> : null}
    </span>
  );
}

export function PipelinePanel({ d, incident }: { d: DashboardDeployment; incident: Incident | null }) {
  const s = d.status;
  const building: "done" | "active" | "waiting" = s === "BUILDING" ? "active" : s === "RECEIVED" ? "waiting" : "done";
  const final = s === "SUCCESS" ? "SUCCESS" : s === "FAILED" ? "FAILED" : "RESULT";
  const finalState = s === "SUCCESS" ? "done" : s === "FAILED" ? "failed" : "waiting";

  return (
    <Panel title="Pipeline" id="pipeline">
      <div className="panel-body">
        <div className="steps">
          <Step label="RECEIVED" state="done" />
          <span className="arrow">→</span>
          <Step label="BUILDING" state={building} />
          <span className="arrow">→</span>
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
              <dd>{d.failure.stage ?? NOT_DETERMINED}</dd>
              <dt>Failed job</dt>
              <dd>{d.failure.job ?? NOT_DETERMINED}</dd>
            </>
          ) : null}
          {incident ? (
            <>
              <dt>Incident</dt>
              <dd>
                #{incident.id} · {incident.failure_type}
              </dd>
              <dt>Root cause</dt>
              <dd className={incident.root_cause ? "" : "faint"}>{incident.root_cause ?? NOT_DETERMINED}</dd>
              <dt>Resolution</dt>
              <dd className={incident.resolution ? "" : "faint"}>{incident.resolution ?? NOT_DETERMINED}</dd>
            </>
          ) : null}
        </dl>

        {d.failure?.message ? (
          <div>
            <span className="label">Observed failure output</span>
            <pre className="output">{d.failure.message}</pre>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 5. Historical evidence
// ---------------------------------------------------------------------------

export function HistoricalEvidence({ evidence }: { evidence: SelectedDeployment["evidence"] }) {
  const source =
    evidence.source === "assessment"
      ? "Evidence supplied to the risk analysis"
      : "Matches from the deployment database (no risk analysis yet)";
  return (
    <Panel title="Historical evidence" aside={source} id="history-evidence">
      {evidence.matches.length === 0 ? (
        <div className="empty">No relevant historical deployments found.</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Deployment</th>
                <th>Outcome</th>
                <th>Change</th>
                <th>Observed failure</th>
                <th>Matched because</th>
                <th>Match</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {evidence.matches.map((m) => (
                <tr key={m.deployment_id}>
                  <td className="nowrap">
                    <a href={deploymentLink(m.deployment_id)}>#{m.deployment_id}</a>
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
                    {m.incident ? <span className="sub">Incident #{m.incident.id} · root cause {m.incident.root_cause ?? "not determined"}</span> : null}
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
      <div className="panel-body" style={{ borderTop: "1px solid var(--border)", paddingTop: 10, paddingBottom: 10 }}>
        <p className="footnote">
          Match score is DeployGuard&apos;s rule-based similarity ranking (shared files, components and categories), not a probability.
        </p>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 7. Deployment history
// ---------------------------------------------------------------------------

function RiskCell({ row }: { row: HistoryRow }) {
  if (row.risk_level) return <Badge tone={riskTone(row.risk_level)}>{row.risk_level}</Badge>;
  if (row.risk_analysis_status === "pending") return <span className="muted small">Pending</span>;
  if (row.risk_analysis_status === "unavailable") return <span className="muted small">Unavailable</span>;
  return <span className="faint">—</span>;
}

export function DeploymentHistory({ rows, selectedId }: { rows: HistoryRow[]; selectedId: string | null }) {
  return (
    <Panel title="Deployment history" aside={`Latest ${rows.length}`} id="deployments">
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Commit</th>
              <th>Repository</th>
              <th>Branch</th>
              <th>Changed components</th>
              <th>Risk</th>
              <th>Status</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.id === selectedId ? "selected" : undefined}>
                <td className="col-msg">
                  <a href={deploymentLink(r.id)} className="num">
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
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Phase 9: connected repositories
// ---------------------------------------------------------------------------

export function ConnectedRepositories({ repositories }: { repositories: UserRepository[] }) {
  return (
    <Panel title="Connected repositories" id="repositories" aside={<a href="/auth/github/install">Connect another repository</a>}>
      <div className="panel-body">
        <ul className="repo-list">
          {repositories.map((r) => (
            <li key={r.id}>
              <span style={{ overflowWrap: "anywhere" }}>{r.full_name}</span>
              {r.private ? <span className="faint small">private</span> : null}
              <span className="state">
                Monitoring:{" "}
                {r.monitoring ? (
                  <span className="on">ON</span>
                ) : (
                  <span>OFF{r.installation_status !== "active" ? ` (app ${r.installation_status})` : " (disconnected)"}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
        <p className="footnote">
          Access is read-only and limited to the repositories you selected on GitHub. Change the selection or
          uninstall the app from your GitHub settings at any time.
        </p>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// 8. Incident history
// ---------------------------------------------------------------------------

export function IncidentHistory({ rows }: { rows: IncidentListItem[] }) {
  return (
    <Panel title="Incident history" aside={rows.length ? `Latest ${rows.length}` : undefined} id="incidents">
      {rows.length === 0 ? (
        <div className="empty">No incidents recorded.</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Incident</th>
                <th>Deployment</th>
                <th>Failure stage</th>
                <th>Affected component</th>
                <th>Observed failure</th>
                <th>Resolution</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id}>
                  <td className="nowrap">
                    #{i.id}
                    <span className="sub">{i.failure_type}</span>
                  </td>
                  <td className="nowrap">
                    <a href={deploymentLink(i.deployment_id)}>#{i.deployment_id}</a>
                    <span className="sub">{i.repository}</span>
                  </td>
                  <td>{i.failure_stage ?? <span className="faint">{NOT_DETERMINED}</span>}</td>
                  <td>{i.affected_service ?? <span className="faint">{NOT_DETERMINED}</span>}</td>
                  <td className="col-msg">{lastLine(i.error_message) ?? <span className="faint">{NOT_DETERMINED}</span>}</td>
                  <td>{i.resolution ?? <span className="faint">{NOT_DETERMINED}</span>}</td>
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
