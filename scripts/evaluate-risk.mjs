/**
 * Stage 4.7: offline risk quality evaluation. No server, no database, no
 * Gemini, no Hindsight -- it replays recorded histories through the REAL
 * similarity scorer, the REAL validator and the REAL accuracy rule.
 *
 *   npm run eval:risk                                  (synthetic fixture)
 *   npm run eval:risk -- --export deployguard-export-123.json   (a real export)
 *
 * Fixture mode (tests/fixtures/risk-eval/*.json): each deployment is replayed
 * in order. Its history is every earlier deployment of the same repository;
 * the matches the scorer finds become the evidence bundle (pipeline RECEIVED,
 * i.e. before CI), the recorded model output is validated against that bundle,
 * and an accepted rating is scored against the recorded outcome.
 *
 * Export mode (GET /api/repositories/export): uses the risk_outcomes recorded
 * by DeployGuard itself (the assessment that existed before CI, scored by the
 * same rule) and replays similarity over the exported deployments.
 *
 * Output is RAW COUNTS ONLY. No rates, no significance, nothing tuned: the
 * numbers are whatever the data gives. The fixture's model outputs are
 * synthetic and test the harness, not the product's usefulness.
 */
import fs from "node:fs";
import path from "node:path";

const { analyzeChanges } = await import("@/lib/analysis/change-analysis");
const { scoreSimilarity } = await import("@/lib/similarity/scoring");
const { validateRiskAssessment } = await import("@/lib/risk/validate");
const { scoreOutcome, ACCURACY_RULE_VERSION } = await import("@/lib/learning/accuracy");

const args = process.argv.slice(2);
const exportIndex = args.indexOf("--export");
const asJson = args.includes("--json");

const comparable = (d, analysis, failureType) => ({
  changedFiles: [...d.files.added, ...d.files.modified, ...d.files.deleted],
  files: analysis.files,
  categories: analysis.categories,
  services: analysis.services,
  commitMessage: d.commit_message,
  failureType,
});
const failureType = (d) => (d.outcome === "FAILED" ? `${(d.failure?.stage ?? "unknown").toLowerCase()}_failure` : null);

/** The history a deployment would have seen: earlier deployments that the scorer finds relevant. */
function replayMatches(current, earlier) {
  const ca = analyzeChanges(current.files);
  const cur = comparable(current, ca, null);
  const matches = [];
  for (const h of earlier) {
    const ha = analyzeChanges(h.files);
    const s = scoreSimilarity(cur, comparable(h, ha, failureType(h)));
    if (s.relevance === "not_relevant") continue;
    matches.push({ h, ha, score: s });
  }
  return { analysis: ca, matches: matches.sort((a, b) => b.score.score - a.score.score).slice(0, 10) };
}

function bundleFor(repo, d, analysis, matches) {
  const outcomeCounts = {};
  for (const m of matches) outcomeCounts[m.h.outcome] = (outcomeCounts[m.h.outcome] ?? 0) + 1;
  return {
    current_deployment: {
      deployment_id: d.id, repository: repo, owner: repo.split("/")[0], branch: "main", commit_sha: `eval${d.id}`,
      commit_message: d.commit_message, author: "eval", recorded_at: new Date(0).toISOString(),
      added_files: d.files.added, modified_files: d.files.modified, deleted_files: d.files.deleted, reverts: null, reverted_by: null,
    },
    change_analysis: { change_categories: analysis.categories, affected_services: analysis.services, files: analysis.files },
    current_pipeline: { status: "RECEIVED", state: "pending", ci_run_url: null, started_at: null, finished_at: null, failure: null, incident: null },
    historical_evidence: {
      available: matches.length > 0,
      match_count: matches.length,
      outcome_counts: outcomeCounts,
      matches: matches.map(({ h, ha, score }) => ({
        deployment_id: h.id, commit_sha: `eval${h.id}`, commit_message: h.commit_message, created_at: new Date(0).toISOString(),
        status: h.outcome, changed_files: [...h.files.added, ...h.files.modified, ...h.files.deleted],
        change_categories: ha.categories, affected_services: ha.services,
        failure: h.outcome === "FAILED" ? { stage: h.failure?.stage ?? null, job: null, message: h.failure?.message ?? null } : null,
        incident: h.outcome === "FAILED"
          ? { id: `i${h.id}`, failure_type: failureType(h), error_message: h.failure?.message ?? null, root_cause: null, resolution: null, provenance: "NOT DETERMINED", probable_flake: false }
          : null,
        similarity_score: score.score, relevance: score.relevance,
        matched_signals: score.signals.map((s) => `${s.signal}: ${s.value} (+${s.points})`), reverted_by: null,
      })),
    },
    evidence_notes: [],
  };
}

const emptyMatrix = () => ({ HIGH: { FAILED: 0, SUCCESS: 0 }, MEDIUM: { FAILED: 0, SUCCESS: 0 }, LOW: { FAILED: 0, SUCCESS: 0 }, none: { FAILED: 0, SUCCESS: 0 } });

function evaluateFixture(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const report = {
    source: path.relative(process.cwd(), file), synthetic: true, rule: ACCURACY_RULE_VERSION,
    deployments: 0, with_history: 0, model_outputs: 0, rejected_by_validator: 0,
    results: { hit: 0, miss: 0, false_alarm: 0, unscored: 0 },
    ratings_vs_outcomes: emptyMatrix(), rejections: [], misses: [], false_alarms: [],
  };
  for (const repo of data.repositories) {
    const earlier = [];
    for (const d of repo.deployments) {
      report.deployments++;
      const { analysis, matches } = replayMatches(d, earlier);
      if (matches.length) report.with_history++;
      if (d.model_output) {
        report.model_outputs++;
        const v = validateRiskAssessment(d.model_output, bundleFor(repo.name, d, analysis, matches));
        let level = null;
        if (!v.ok) {
          report.rejected_by_validator++;
          report.rejections.push({ repository: repo.name, deployment: d.id, errors: v.errors.slice(0, 3) });
        } else level = v.assessment.risk_level;
        // A rejected answer is "risk analysis unavailable": no prediction exists.
        const s = scoreOutcome(level ? { id: d.id, risk_level: level, risk_generated_at: new Date(0), based_on_pipeline: "RECEIVED" } : null, d.outcome);
        report.results[s.result]++;
        report.ratings_vs_outcomes[level ?? "none"][d.outcome]++;
        if (s.result === "miss") report.misses.push(`${repo.name} #${d.id}`);
        if (s.result === "false_alarm") report.false_alarms.push(`${repo.name} #${d.id}`);
      }
      earlier.push(d);
    }
  }
  return report;
}

function evaluateExport(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (data.format !== "deployguard-export/1") throw new Error(`${file} is not a DeployGuard export.`);
  const latest = new Map();
  for (const o of data.risk_outcomes ?? []) {
    const prev = latest.get(o.deployment_id);
    if (!prev || new Date(o.outcome_at) >= new Date(prev.outcome_at)) latest.set(o.deployment_id, o);
  }
  const report = {
    source: path.basename(file), synthetic: false, rule: ACCURACY_RULE_VERSION,
    deployments: data.deployments.length, scored_outcomes: latest.size,
    results: { hit: 0, miss: 0, false_alarm: 0, unscored: 0 }, ratings_vs_outcomes: emptyMatrix(), misses: [], false_alarms: [],
    similarity: { finished: 0, failed_with_prior_failed_match: 0, failed_without: 0, succeeded_with_prior_failed_match: 0, succeeded_without: 0 },
  };
  for (const o of latest.values()) {
    report.results[o.result]++;
    report.ratings_vs_outcomes[o.predicted_level ?? "none"][o.outcome_status]++;
    if (o.result === "miss") report.misses.push(`#${o.deployment_id}`);
    if (o.result === "false_alarm") report.false_alarms.push(`#${o.deployment_id}`);
  }
  const rows = data.deployments
    .filter((d) => d.status === "SUCCESS" || d.status === "FAILED")
    .map((d) => ({
      id: d.id, commit_message: d.commit_message ?? "", outcome: d.status,
      failure: { stage: d.failure_stage }, files: { added: d.added_files ?? [], modified: d.modified_files ?? [], deleted: d.deleted_files ?? [] },
    }));
  const earlier = [];
  for (const d of rows) {
    const { matches } = replayMatches(d, earlier);
    const priorFailed = matches.some((m) => m.h.outcome === "FAILED");
    report.similarity.finished++;
    report.similarity[`${d.outcome === "FAILED" ? "failed" : "succeeded"}_${priorFailed ? "with_prior_failed_match" : "without"}`]++;
    earlier.push(d);
  }
  return report;
}

function print(r) {
  console.log(`\nSource: ${r.source}${r.synthetic ? "  (SYNTHETIC: tests the harness, not the product)" : ""}`);
  console.log(`Rule: ${r.rule}`);
  console.log(`Deployments: ${r.deployments}`);
  if (r.synthetic) {
    console.log(`  with similar history found by the scorer: ${r.with_history}`);
    console.log(`  recorded model outputs: ${r.model_outputs}`);
    console.log(`  rejected by the validator: ${r.rejected_by_validator}`);
  } else console.log(`  with a recorded outcome: ${r.scored_outcomes}`);
  console.log(`Results: hit ${r.results.hit}, miss ${r.results.miss}, false alarm ${r.results.false_alarm}, unscored ${r.results.unscored}`);
  console.log("Ratings vs outcomes (counts):");
  console.log("  predicted   then FAILED   then SUCCESS");
  for (const [level, c] of Object.entries(r.ratings_vs_outcomes)) {
    console.log(`  ${level.padEnd(10)}  ${String(c.FAILED).padStart(11)}   ${String(c.SUCCESS).padStart(12)}`);
  }
  if (r.misses.length) console.log(`Misses: ${r.misses.join(", ")}`);
  if (r.false_alarms.length) console.log(`False alarms: ${r.false_alarms.join(", ")}`);
  for (const x of r.rejections ?? []) console.log(`Rejected ${x.repository} #${x.deployment}: ${x.errors.join("; ")}`);
  if (r.similarity) {
    const s = r.similarity;
    console.log(`Similarity replay over ${s.finished} finished deployments (counts):`);
    console.log(`  FAILED  with a similar earlier failure: ${s.failed_with_prior_failed_match}, without: ${s.failed_without}`);
    console.log(`  SUCCESS with a similar earlier failure: ${s.succeeded_with_prior_failed_match}, without: ${s.succeeded_without}`);
  }
}

const reports = [];
if (exportIndex >= 0) {
  const file = args[exportIndex + 1];
  if (!file) throw new Error("--export needs a file path.");
  reports.push(evaluateExport(path.resolve(file)));
} else {
  const dir = path.join(process.cwd(), "tests", "fixtures", "risk-eval");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) reports.push(evaluateFixture(path.join(dir, f)));
}
if (asJson) console.log(JSON.stringify(reports, null, 2));
else {
  console.log("DeployGuard Stage 4.7: offline risk evaluation (raw counts only)");
  reports.forEach(print);
}
