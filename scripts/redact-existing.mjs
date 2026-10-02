/**
 * Stage 1: redacts text that was stored BEFORE redaction existed.
 *
 *   npm run db:redact-existing            dry run: counts only, changes nothing
 *   npm run db:redact-existing -- --apply rewrite the affected rows
 *
 * Covers: deployments (commit_message, failure_stage, failure_job,
 * failure_message), incidents (error_message), github_webhook_deliveries
 * (last_error, stored payload), risk_assessments (stored evidence bundle and
 * cited observed_failure). Uses the same module as the app (lib/security/redact.ts).
 *
 * --apply is irreversible by design: the removed values are not kept anywhere.
 * Prints table/column names and counts only, never a value.
 *
 * Hindsight: memories retained before Stage 1 may still hold unredacted text.
 * After --apply, re-store deployment memories with the internal
 * /api/memory/backfill endpoint (replace mode overwrites them).
 */
import pg from "pg";
import { loadEnv } from "./load-env.mjs";
import { redact, redactDeep } from "../lib/security/redact.ts";

loadEnv();
const apply = process.argv.includes("--apply");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}
const client = new pg.Client({
  connectionString,
  ssl: /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString) ? undefined : { rejectUnauthorized: false },
});

const counts = {};
const note = (key, n = 1) => (counts[key] = (counts[key] ?? 0) + n);

await client.connect();
try {
  if (apply) await client.query("BEGIN");

  // deployments
  const deployments = await client.query(
    `SELECT id, commit_message, failure_stage, failure_job, failure_message, redaction FROM deployments`
  );
  for (const d of deployments.rows) {
    const msg = redact(d.commit_message);
    const out = d.failure_message ? redact(d.failure_message) : null;
    const stage = redact(d.failure_stage);
    const job = redact(d.failure_job);
    const outChanged = Boolean(out?.count);
    const changed = msg.count || stage.count || job.count || outChanged;
    if (!changed) continue;
    note("deployments rows");
    if (msg.count) note("deployments.commit_message");
    if (outChanged) note("deployments.failure_message");
    if (stage.count || job.count) note("deployments.failure_stage/job");
    if (apply) {
      const record = { ...(d.redaction ?? {}) };
      if (msg.count) record.commit_message = { count: msg.count, categories: msg.categories };
      if (out?.count || stage.count || job.count) {
        record.failure_output = {
          count: (out?.count ?? 0) + stage.count + job.count,
          categories: [...new Set([...(out?.categories ?? []), ...stage.categories, ...job.categories])].sort(),
        };
      }
      await client.query(
        `UPDATE deployments SET commit_message = $2, failure_stage = $3, failure_job = $4, failure_message = $5, redaction = $6::jsonb WHERE id = $1`,
        [d.id, msg.text, d.failure_stage === null ? null : stage.text, d.failure_job === null ? null : job.text,
         d.failure_message === null ? null : out.text, JSON.stringify(record)]
      );
    }
  }

  // incidents
  const incidents = await client.query(`SELECT id, error_message FROM incidents WHERE error_message IS NOT NULL`);
  for (const i of incidents.rows) {
    const out = redact(i.error_message);
    if (!out.count) continue;
    note("incidents.error_message");
    if (apply) await client.query(`UPDATE incidents SET error_message = $2 WHERE id = $1`, [i.id, out.text]);
  }

  // webhook deliveries
  const deliveries = await client.query(
    `SELECT delivery_id, last_error, payload FROM github_webhook_deliveries WHERE last_error IS NOT NULL OR payload IS NOT NULL`
  );
  for (const w of deliveries.rows) {
    const err = redact(w.last_error);
    const payload = w.payload ? redactDeep(w.payload) : null;
    if (!err.count && !payload?.summary.count) continue;
    note("github_webhook_deliveries rows");
    if (apply) {
      await client.query(`UPDATE github_webhook_deliveries SET last_error = $2, payload = $3::jsonb WHERE delivery_id = $1`, [
        w.delivery_id, w.last_error === null ? null : err.text, payload ? JSON.stringify(payload.value) : null,
      ]);
    }
  }

  // stored evidence bundles and cited observed failures
  const assessments = await client.query(`SELECT id, evidence, historical_evidence FROM risk_assessments`);
  for (const a of assessments.rows) {
    const ev = redactDeep(a.evidence);
    const he = redactDeep(a.historical_evidence);
    if (!ev.summary.count && !he.summary.count) continue;
    note("risk_assessments rows");
    if (apply) {
      await client.query(`UPDATE risk_assessments SET evidence = $2::jsonb, historical_evidence = $3::jsonb WHERE id = $1`, [
        a.id, JSON.stringify(ev.value), JSON.stringify(he.value),
      ]);
    }
  }

  if (apply) await client.query("COMMIT");
} catch (error) {
  if (apply) await client.query("ROLLBACK").catch(() => {});
  console.error(`Failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}

console.log(`${apply ? "APPLIED" : "DRY RUN (nothing changed; add --apply to rewrite)"}`);
if (Object.keys(counts).length === 0) console.log("  No stored text needed redaction.");
for (const [k, n] of Object.entries(counts)) console.log(`  ${k.padEnd(36)} ${n}`);
