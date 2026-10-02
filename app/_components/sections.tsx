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
import type { AccuracyRecord, FailurePattern, RevertFacts } from "@/lib/db/learning";
import type { EnvironmentFacts } from "@/lib/db/environments";
import type { InputsView, OwnersView, PullRequestCheckRow } from "@/lib/dashboard/dashboard-data";
import type { AskResult } from "@/lib/learning/ask-history";
import { SMALL_SAMPLE } from "@/lib/learning/accuracy";
import type { Links } from "./links";
import { ReanalyzeButton } from "./reanalyze-button";
import { ConfirmIncidentForm } from "./confirm-incident-form";

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

export type ProvenanceKind = "observed" | "history" | "memory" | "ai" | "confirmed";
const PROVENANCE: Record<ProvenanceKind, string> = {
  observed: "Observed fact",
  history: "Historical evidence",
  memory: "Recalled memory",
  ai: "AI reasoning",
  // Stage 4.1: recorded by a person after the failure, attributed and versioned.
  confirmed: "Human-confirmed",
};

/** Stage 4.1: a cause field -- the confirmed value with its label, or "Not determined". */
function Confirmed({ value, incident }: { value: string | null; incident: Pick<Incident, "confirmed_revision"> }) {
  if (incident.confirmed_revision === null || value === null) return <Unknown />;
  return (
    <>
      {value} <Prov kind="confirmed" />
    </>
  );
}

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
  owners,
}: {
  risk: RiskView;
  reanalyze: SelectedDeployment["reanalyze"];
  deploymentId: string;
  links: Links;
  canAct: boolean;
  memoryHref: string | null;
  /** Stage 5.3 */
  owners?: OwnersView;
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
          {owners ? <OwnersBlock owners={owners} /> : null}
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
        {owners ? <OwnersBlock owners={owners} /> : null}
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

/** Stage 5.3: who owns the changed files (CODEOWNERS), as recorded -- never inferred. */
export function OwnersBlock({ owners }: { owners: OwnersView }) {
  return (
    <div className="owners">
      <span className="label">Code owners of the changed files</span>{" "}
      {owners.status !== "valid" ? (
        <span className="faint">
          {owners.status === "absent" ? "No CODEOWNERS file in this repository." : owners.status === "unavailable" ? "CODEOWNERS could not be read." : "CODEOWNERS not read yet."}
        </span>
      ) : owners.owners.length === 0 ? (
        <span className="faint">No owner is listed for these files.</span>
      ) : (
        <span>
          {owners.owners.map((o, i) => (
            <span key={o.owner}>
              {i ? ", " : ""}
              {o.owner} <span className="faint">({o.files})</span>
            </span>
          ))}
          {owners.unowned ? <span className="faint"> · {owners.unowned} file(s) without an owner</span> : null}
        </span>
      )}
    </div>
  );
}

export function ChangeAnalysis({ d, owners }: { d: DashboardDeployment; owners?: OwnersView }) {
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
        {d.file_analysis.some((f) => f.critical) ? (
          <p className="note" role="note">
            <Badge tone="amber">Critical path</Badge> {d.file_analysis.filter((f) => f.critical).length} file(s) match a critical path in .deployguard.yml.
          </p>
        ) : null}
        {owners ? <OwnersBlock owners={owners} /> : null}
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
                <td className="wrap-any">
                  {f.path}
                  {f.critical ? <span className="sub">critical path</span> : null}
                  {f.ignored ? <span className="sub">ignored by .deployguard.yml</span> : null}
                </td>
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

export function PipelinePanel({
  d,
  incident,
  reverts,
  links,
  environments,
}: {
  d: DashboardDeployment;
  incident: Incident | null;
  reverts?: RevertFacts;
  links: Links;
  /** Stage 5.5 */
  environments?: EnvironmentFacts;
}) {
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
          {environments ? (
            <>
              <dt>Environment</dt>
              <dd>
                {environments.status === "found" && environments.environments.length ? (
                  environments.environments.map((e, i) => (
                    <span key={`${e.name}${i}`}>
                      {i ? ", " : ""}
                      {e.name}: {e.state ?? "state not reported"}
                    </span>
                  ))
                ) : (
                  <span className="faint">
                    Environment unknown
                    {environments.status === "unavailable" ? " (GitHub deployments could not be read)" : environments.status === "none" ? " (GitHub reported no deployment of this commit)" : ""}
                  </span>
                )}
              </dd>
            </>
          ) : null}
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
              <dd><Confirmed value={incident.root_cause} incident={incident} /></dd>
              <dt>Resolution</dt>
              <dd><Confirmed value={incident.resolution} incident={incident} /></dd>
              {incident.flake_status === "probable_flake" ? (
                <>
                  <dt>Flake</dt>
                  <dd>
                    <Badge tone="amber">Probable flake</Badge> A re-run of the same commit passed afterwards.
                  </dd>
                </>
              ) : null}
            </>
          ) : null}
          {reverts?.reverts ? (
            <>
              <dt>Revert of</dt>
              <dd>
                <a href={links.deployment(reverts.reverts.deployment_id)}>#{reverts.reverts.deployment_id}</a>, {reverts.reverts.hours_after} h after it
              </dd>
            </>
          ) : null}
          {reverts?.reverted_by ? (
            <>
              <dt>Reverted by</dt>
              <dd>
                <a href={links.deployment(reverts.reverted_by.deployment_id)}>#{reverts.reverted_by.deployment_id}</a>, {reverts.reverted_by.hours_after} h later
              </dd>
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
                    {m.environments?.length ? <span className="sub">{m.environments.join(", ")}</span> : null}
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
                        {m.incident.root_cause && m.incident.provenance === "HUMAN-CONFIRMED"
                          ? `${m.incident.root_cause} (human-confirmed)`
                          : "not determined"}
                        {m.incident.probable_flake ? " · probable flake" : ""}
                      </span>
                    ) : null}
                    {m.reverted_by ? (
                      <span className="sub">
                        Reverted by <a href={links.deployment(m.reverted_by.deployment_id)}>#{m.reverted_by.deployment_id}</a>
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
                  {r.probable_flake ? <span className="sub">failed first; probable flake</span> : null}
                  {r.reverted ? <span className="sub">reverted</span> : null}
                  {r.environments.length ? <span className="sub">{r.environments.join(", ")}</span> : null}
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
                    {i.flake_status === "probable_flake" ? <span className="sub">probable flake</span> : null}
                  </td>
                  <td className="nowrap">
                    <a href={links.deployment(i.deployment_id)}>#{i.deployment_id}</a>
                    <span className="sub">{i.repository}</span>
                  </td>
                  <td>{i.failure_stage ?? <Unknown />}</td>
                  <td><Confirmed value={i.affected_service} incident={i} /></td>
                  <td className="col-msg">{lastLine(i.error_message) ?? <Unknown />}</td>
                  <td><Confirmed value={i.resolution} incident={i} /></td>
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

export function IncidentDetail({ data, links, canConfirm }: { data: IncidentDetailData; links: Links; canConfirm: boolean }) {
  const { incident: i, deployment: d, related, confirmations } = data;
  const confirmed = i.confirmed_revision !== null;
  const runLink = (url: string | null, id: string | null, fallback: string) =>
    url && /^https:\/\/github\.com\//.test(url) ? (
      <a href={url} target="_blank" rel="noreferrer">GitHub Actions run #{id ?? "view"}</a>
    ) : (
      <span className="faint">{fallback}</span>
    );
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
          <dt>Failed run</dt>
          <dd>{runLink(i.failed_ci_run_url ?? d.ci_run_url, i.failed_ci_run_id ?? d.ci_run_id, "Not reported")}</dd>
          {i.error_signature ? (
            <>
              <dt>Error signature</dt>
              <dd className="num small">{i.error_signature}</dd>
            </>
          ) : null}
        </dl>

        {i.flake_status === "probable_flake" ? (
          <div className="note" role="note">
            <Badge tone="amber">Probable flake</Badge> The same commit failed in{" "}
            {runLink(i.failed_ci_run_url, i.failed_ci_run_id, "a run that was not reported")} and then passed in{" "}
            {runLink(i.flake_passing_run_url, i.flake_passing_run_id, "a later run")}
            {i.flake_detected_at ? <> (seen {absoluteTime(i.flake_detected_at)})</> : null}, with no code change. The incident is kept;
            it counts less in similarity and is left out of recurring patterns.
          </div>
        ) : null}

        <div>
          <span className="label">Observed output (redacted, last lines)</span>
          {i.error_message ? <pre className="output">{i.error_message}</pre> : <p className="muted small">No output is stored (none was reported, or it passed its retention period).</p>}
        </div>
      </div>

      <div className="panel-body bordered-top">
        <div className="panel-head-inline">
          <span className="label">Cause and resolution</span> {confirmed ? <Prov kind="confirmed" /> : null}
        </div>
        <dl className="facts">
          <dt>Root cause</dt>
          <dd><Confirmed value={i.root_cause} incident={i} /></dd>
          <dt>Resolution</dt>
          <dd><Confirmed value={i.resolution} incident={i} /></dd>
          <dt>Service</dt>
          <dd><Confirmed value={i.affected_service} incident={i} /></dd>
          <dt>Downstream effect</dt>
          <dd><Confirmed value={i.downstream_effect} incident={i} /></dd>
          {confirmed ? (
            <>
              <dt>Confirmed by</dt>
              <dd>
                @{i.confirmed_by_login} · {i.confirmed_at ? absoluteTime(i.confirmed_at) : "time not recorded"} · revision {i.confirmed_revision}
              </dd>
            </>
          ) : null}
        </dl>
        <p className="footnote">
          DeployGuard never guesses these. They are filled in only when a person who owns this repository confirms them, and
          each change is kept as a revision. Confirmed values are used as evidence in later risk analyses, labelled as human-confirmed.
        </p>
        {canConfirm ? (
          <details>
            <summary className="small">{confirmed ? "Edit the confirmed cause" : "Record the confirmed cause"}</summary>
            <ConfirmIncidentForm
              incidentId={i.id}
              revision={i.confirmed_revision ?? 0}
              initial={{
                root_cause: i.root_cause ?? "",
                resolution: i.resolution ?? "",
                affected_service: i.affected_service ?? "",
                downstream_effect: i.downstream_effect ?? "",
              }}
            />
          </details>
        ) : null}
        {confirmations.length > 0 ? (
          <details className="history-revisions">
            <summary className="small">Edit history ({confirmations.length} revision{confirmations.length === 1 ? "" : "s"})</summary>
            <ol className="plain-list" reversed>
              {confirmations.map((c) => (
                <li key={c.revision}>
                  Revision {c.revision} by @{c.confirmed_by_login}, {absoluteTime(c.confirmed_at)}: root cause{" "}
                  {c.root_cause ?? "not known"}; resolution {c.resolution ?? "not known"}; service {c.affected_service ?? "not known"};
                  downstream effect {c.downstream_effect ?? "not known"}.
                  {c.redaction?.count ? <span className="faint"> ({c.redaction.count} value(s) masked)</span> : null}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>

      <div className="panel-body bordered-top">
        <span className="label">Other incidents of this repository with the same failure type</span>
        {related.length === 0 ? (
          <p className="muted small">None recorded.</p>
        ) : (
          <ul className="plain-list">
            {related.map((r) => (
              <li key={r.id}>
                <a href={links.incident(r.id)}>Incident #{r.id}</a> on <a href={links.deployment(r.deployment_id)}>deployment #{r.deployment_id}</a>{" "}
                ({r.branch}, <Time iso={r.created_at} />){r.flake_status === "probable_flake" ? " · probable flake" : ""}
              </li>
            ))}
          </ul>
        )}
        <p className="footnote">Same failure type is an observation, not a claim that the incidents share a cause.</p>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Stage 4: what DeployGuard has learned
// ---------------------------------------------------------------------------

const DIMENSION_TEXT: Record<FailurePattern["dimension"], string> = {
  error_signature: "Same error output",
  failed_stage: "Same failed stage",
  component: "Same component",
  category: "Same kind of change",
};

const ordinal = (n: number) => (n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`);

export function FailurePatterns({ patterns, windowDays, links }: { patterns: FailurePattern[]; windowDays: number; links: Links }) {
  return (
    <Panel title="Recurring failure patterns" id="patterns" prov="observed" aside={`Last ${windowDays} days`}>
      {patterns.length === 0 ? (
        <div className="empty">No failure has repeated in the last {windowDays} days.</div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <caption className="visually-hidden">Recurring failure patterns</caption>
            <thead>
              <tr>
                <th scope="col">Observation</th>
                <th scope="col">Shared value</th>
                <th scope="col">Repository</th>
                <th scope="col">Incidents (evidence)</th>
                <th scope="col">Latest</th>
              </tr>
            </thead>
            <tbody>
              {patterns.map((p) => (
                <tr key={`${p.dimension}:${p.github_repository_id}:${p.value}`}>
                  <td>
                    {DIMENSION_TEXT[p.dimension]}: {ordinal(p.count)} failure in {windowDays} days
                    {p.flakes_excluded ? <span className="sub">{p.flakes_excluded} probable flake(s) not counted</span> : null}
                  </td>
                  <td className="col-msg num small">{p.value}</td>
                  <td>{p.repository}</td>
                  <td>
                    {p.incident_ids.map((id, n) => (
                      <span key={id}>
                        {n ? ", " : ""}
                        <a href={links.incident(id)}>#{id}</a>
                      </span>
                    ))}
                  </td>
                  <td>
                    <Time iso={p.last_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="panel-body bordered-top compact">
        <p className="footnote">
          Computed from recorded incidents. A pattern says these failures share something; it does not say they share a cause.
        </p>
      </div>
    </Panel>
  );
}

const RESULT_TEXT: Record<AccuracyRecord["rows"][number]["result"], { label: string; tone: Tone }> = {
  hit: { label: "Hit", tone: "green" },
  miss: { label: "Miss", tone: "red" },
  false_alarm: { label: "False alarm", tone: "amber" },
  unscored: { label: "Unscored", tone: "gray" },
};

export function AccuracyRecordPanel({ record, links }: { record: AccuracyRecord; links: Links }) {
  const c = record.counts;
  const levels = ["HIGH", "MEDIUM", "LOW", "none"].filter((l) => record.matrix[l]);
  return (
    <Panel title="Risk prediction record" id="accuracy" prov="observed" aside={`Rule ${record.ruleVersion}`}>
      <div className="panel-body compact">
        <dl className="counts" aria-label="Prediction outcomes">
          <div><dt>Finished deployments</dt><dd className="num">{c.total}</dd></div>
          <div><dt>Scored</dt><dd className="num">{c.scored}</dd></div>
          <div><dt>Hits</dt><dd className="num">{c.hit}</dd></div>
          <div><dt>Misses</dt><dd className="num">{c.miss}</dd></div>
          <div><dt>False alarms</dt><dd className="num">{c.false_alarm}</dd></div>
          <div><dt>Unscored</dt><dd className="num">{c.unscored}</dd></div>
        </dl>
        {c.scored < SMALL_SAMPLE ? (
          <p className="note" role="note">
            Small sample: {c.scored} scored prediction{c.scored === 1 ? "" : "s"}. These counts say what happened; they are too few to say how
            reliable the predictions are.
          </p>
        ) : null}
        <p className="footnote">
          The prediction is the last assessment made before CI finished. HIGH then FAILED, or LOW then SUCCESS, is a hit; LOW then FAILED is a miss;
          HIGH then SUCCESS is a false alarm. MEDIUM, or no assessment before the result, is unscored. Predictions are never edited.
        </p>
      </div>
      {levels.length ? (
        <div className="table-wrap bordered-top">
          <table className="data">
            <caption className="visually-hidden">Predicted level by outcome (counts)</caption>
            <thead>
              <tr>
                <th scope="col">Predicted</th>
                <th scope="col">Then FAILED</th>
                <th scope="col">Then SUCCESS</th>
              </tr>
            </thead>
            <tbody>
              {levels.map((l) => (
                <tr key={l}>
                  <th scope="row">{l === "none" ? "No prediction" : l}</th>
                  <td className="num">{record.matrix[l].FAILED}</td>
                  <td className="num">{record.matrix[l].SUCCESS}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {record.rows.length ? (
        <details className="panel-body bordered-top compact">
          <summary className="small">The underlying deployments (latest {record.rows.length})</summary>
          <ul className="plain-list">
            {record.rows.map((r) => (
              <li key={r.deployment_id}>
                <a href={links.deployment(r.deployment_id)}>#{r.deployment_id}</a> {shortSha(r.commit_sha)} · predicted{" "}
                {r.predicted_level ?? "nothing"} · {r.outcome_status} · <Badge tone={RESULT_TEXT[r.result].tone}>{RESULT_TEXT[r.result].label}</Badge>
                {r.unscored_reason ? <span className="faint"> ({r.unscored_reason})</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <div className="empty">No deployment has finished CI since prediction tracking started.</div>
      )}
    </Panel>
  );
}

export function AskHistory({ result, repo, links }: { result: AskResult | null; repo: string | null; links: Links }) {
  return (
    <Panel title="Ask your history" id="ask" prov="history">
      <div className="panel-body">
        <form className="ask-form" action="/" method="get" role="search">
          {repo ? <input type="hidden" name="repo" value={repo} /> : null}
          <label htmlFor="ask-q" className="visually-hidden">Question about your deployment history</label>
          <input
            id="ask-q"
            name="ask"
            maxLength={300}
            defaultValue={result?.question ?? ""}
            placeholder="Have we seen a database connection timeout before?"
          />
          <button type="submit" className="button">Ask</button>
        </form>
        {result === null ? (
          <p className="footnote">
            Answers come only from your recorded deployments and incidents, with a link to each record. Questions about anything else are declined.
          </p>
        ) : result.state !== "answered" ? (
          <p className="note" role="status">{result.message}</p>
        ) : (
          <div role="status">
            <p>{result.answer.summary}</p>
            {result.answer.statements.length ? (
              <ul className="statements">
                {result.answer.statements.map((s) => (
                  <li key={s.deployment_id}>
                    {s.text}{" "}
                    <a href={links.deployment(s.deployment_id)}>Deployment #{s.deployment_id}</a>
                    {s.incident_id ? <> · <a href={links.incident(s.incident_id)}>Incident #{s.incident_id}</a></> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="footnote">
              Every line is a database record. {result.memory === "used"
                ? "Memory recall only helped find candidate records."
                : result.memory === "unavailable"
                  ? "Memory recall was unavailable; this was answered from the database alone."
                  : ""}
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Stage 5: repository inputs (.deployguard.yml, CODEOWNERS) and PR checks
// ---------------------------------------------------------------------------

const CONFIG_TEXT: Record<InputsView["configStatus"], string> = {
  valid: "Valid. Its rules shape the change analysis.",
  absent: "No .deployguard.yml on the default branch; defaults apply.",
  invalid: "Invalid, so it is NOT used; defaults apply until it is fixed.",
  unavailable: "Could not be read from GitHub; defaults apply.",
  not_read: "Not read yet; it is read after the next push.",
};

const PR_STATE_TEXT: Record<string, string> = {
  posted: "Check posted",
  pending: "Running",
  disabled: "Disabled",
  permission_missing: "Permission missing",
  failed: "Failed",
};

export function RepositoryInputs({ inputs, prChecks }: { inputs: InputsView; prChecks: PullRequestCheckRow[] }) {
  const c = inputs.config;
  return (
    <Panel title="Repository inputs" id="inputs" prov="observed">
      <div className="panel-body">
        <dl className="facts">
          <dt>.deployguard.yml</dt>
          <dd>
            <Badge tone={inputs.configStatus === "valid" ? "green" : inputs.configStatus === "invalid" ? "red" : "gray"}>{inputs.configStatus.replace("_", " ")}</Badge>{" "}
            {CONFIG_TEXT[inputs.configStatus]}
          </dd>
          {c ? (
            <>
              <dt>Rules</dt>
              <dd>
                {c.critical.length} critical path(s), {c.ignore.length} ignore pattern(s), {c.services.length} service mapping(s), {c.categories.length} category rule(s); PR checks {c.pull_request_checks ? "on" : "off"}.
              </dd>
            </>
          ) : null}
          <dt>This deployment</dt>
          <dd>
            {inputs.appliedToDeployment
              ? `Analysed with config status "${inputs.appliedToDeployment.status.replace(/_/g, " ")}"${inputs.appliedToDeployment.sha ? ` (file ${inputs.appliedToDeployment.sha.slice(0, 7)})` : ""}.`
              : "Analysed before repository config existed."}
          </dd>
          <dt>CODEOWNERS</dt>
          <dd>
            {inputs.codeownersStatus === "valid" ? `Read from ${inputs.codeownersPath}.` : inputs.codeownersStatus === "absent" ? "None found." : inputs.codeownersStatus === "unavailable" ? "Could not be read." : "Not read yet."}
            {inputs.emailsDropped ? <span className="faint"> {inputs.emailsDropped} email owner(s) are not shown.</span> : null}
          </dd>
          {inputs.fetchedAt ? (
            <>
              <dt>Read</dt>
              <dd>{absoluteTime(inputs.fetchedAt)}</dd>
            </>
          ) : null}
        </dl>
        {inputs.configErrors.length ? (
          <div role="alert">
            <span className="label">Config errors</span>
            <ul className="plain-list">
              {inputs.configErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div>
          <span className="label">Recent pull request checks (advisory, never blocking)</span>
          {prChecks.length === 0 ? (
            <p className="muted small">None yet. They appear when a pull request is opened or updated.</p>
          ) : (
            <ul className="plain-list">
              {prChecks.map((p) => (
                <li key={`${p.pr_number}-${p.head_sha}`}>
                  PR #{p.pr_number} <span className="num">{shortSha(p.head_sha)}</span> · {PR_STATE_TEXT[p.state] ?? p.state}
                  {p.risk_level ? <> · <Badge tone={riskTone(p.risk_level as "LOW" | "MEDIUM" | "HIGH")}>{p.risk_level}</Badge></> : null}
                  {p.detail ? <span className="faint"> · {p.detail}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="footnote">DeployGuard reads these files as data from the default branch; it never runs anything from them.</p>
      </div>
    </Panel>
  );
}
