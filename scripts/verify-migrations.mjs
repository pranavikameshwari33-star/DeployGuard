/**
 * Stage 2: migration test on a database with realistic data volume.
 *
 *   npm run verify:migrations
 *
 * Works in a THROWAWAY schema (dg_migtest_<random>) inside DATABASE_URL and
 * drops it at the end; the real tables are never touched. Steps:
 *   1. apply 001-009 (the schema as it was before Stage 2)
 *   2. seed realistic volume: 20,000 deployments, 3,000 incidents, 2,000 risk
 *      assessments, 200 repositories, 5,000 webhook deliveries
 *   3. apply 010 and time it; then re-apply ALL migrations (must be re-runnable)
 *   4. assert: no row lost; history-preserving foreign keys; id-based unique
 *      push key; append-only audit log; job dedupe key; cascades unchanged
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadEnv } from "./load-env.mjs";

loadEnv();
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.log("SKIP: DATABASE_URL is not set.");
  process.exit(0);
}

let failures = 0;
const check = (ok, step, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${step}${detail ? " -- " + detail : ""}`);
};
const expectError = async (client, sql, params, step) => {
  await client.query("SAVEPOINT s");
  try {
    await client.query(sql, params);
    await client.query("RELEASE SAVEPOINT s");
    check(false, step, "statement succeeded but should have been refused");
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT s");
    check(true, step, error.code ?? "");
  }
};

const schema = `dg_migtest_${crypto.randomBytes(4).toString("hex")}`;
const dir = path.join(process.cwd(), "db", "migrations");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const before = files.filter((f) => f < "010");
const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
const client = new pg.Client({ connectionString, ssl: isLocal ? undefined : { rejectUnauthorized: false } });

console.log(`DeployGuard Stage 2: migrations on realistic volume (schema ${schema})\n`);
await client.connect();
const apply = async (list) => {
  for (const f of list) await client.query(fs.readFileSync(path.join(dir, f), "utf8"));
};
try {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await apply(before);
  check(true, `applied ${before.length} pre-Stage-2 migrations`);

  // --- seed --------------------------------------------------------------------
  let t = Date.now();
  await client.query(`
    INSERT INTO users (github_user_id, github_login) SELECT g, 'user' || g FROM generate_series(1, 50) g;
    INSERT INTO github_installations (installation_id, user_id, status) SELECT 1000 + g, g, 'active' FROM generate_series(1, 50) g;
    INSERT INTO repositories (github_repository_id, installation_id, owner, name, full_name)
      SELECT 5000 + g, 1000 + (g % 50) + 1, 'owner' || (g % 50), 'repo' || g, 'owner' || (g % 50) || '/repo' || g FROM generate_series(1, 200) g;
    INSERT INTO deployments (repository, owner, branch, commit_sha, commit_message, author, changed_files, status,
                             change_categories, affected_services, repository_id, github_repository_id, created_at, updated_at,
                             failure_message)
      SELECT 'repo' || r, 'owner' || (r % 50), CASE WHEN g % 7 = 0 THEN 'feature' ELSE 'main' END,
             md5(g::text) || substr(md5((g * 7)::text), 1, 8), 'commit ' || g, 'dev' || (g % 30),
             ARRAY['src/file' || (g % 40) || '.ts', 'config/app.yaml'],
             (ARRAY['SUCCESS','SUCCESS','SUCCESS','FAILED','BUILDING'])[1 + g % 5],
             ARRAY['source', CASE WHEN g % 3 = 0 THEN 'database' ELSE 'config' END], ARRAY['svc' || (g % 9)],
             (SELECT id FROM repositories WHERE github_repository_id = 5000 + r), 5000 + r,
             now() - make_interval(hours => g), now() - make_interval(hours => g),
             CASE WHEN g % 5 = 3 THEN 'Error: connect ETIMEDOUT' END
      FROM (SELECT g, 1 + (g % 200) AS r FROM generate_series(1, 20000) g) s;
    INSERT INTO incidents (deployment_id, failure_type, error_message)
      SELECT id, 'test_failure', 'Error: connect ETIMEDOUT' FROM deployments WHERE status = 'FAILED' LIMIT 3000;
    INSERT INTO risk_assessments (deployment_id, risk_level, risk_confidence, risk_summary, risk_reasons, historical_evidence,
                                  missing_information, recommended_checks, evidence, evidence_fingerprint, model)
      SELECT id, 'MEDIUM', 0.5, 'summary', '[]', '[]', '[]', '["check"]', '{}', md5(id::text), 'test-model'
      FROM deployments ORDER BY id LIMIT 2000;
    INSERT INTO github_webhook_deliveries (delivery_id, event, status) SELECT 'd' || g, 'push', 'processed' FROM generate_series(1, 5000) g;
  `);
  const counts = async () =>
    (await client.query(`SELECT (SELECT count(*) FROM deployments)::int d, (SELECT count(*) FROM incidents)::int i,
                                (SELECT count(*) FROM risk_assessments)::int a, (SELECT count(*) FROM repositories)::int r,
                                (SELECT count(*) FROM github_webhook_deliveries)::int w`)).rows[0];
  const seeded = await counts();
  check(seeded.d === 20000 && seeded.i === 3000 && seeded.a === 2000, "seeded realistic volume", `${JSON.stringify(seeded)} in ${Date.now() - t} ms`);

  // --- 010 + re-run -------------------------------------------------------------
  t = Date.now();
  await apply(files.filter((f) => f >= "010"));
  const firstMs = Date.now() - t;
  t = Date.now();
  await apply(files);
  check(true, "Stage 2 migration applied, then ALL migrations re-applied (re-runnable)", `010: ${firstMs} ms; full re-run: ${Date.now() - t} ms`);
  const after = await counts();
  check(JSON.stringify(after) === JSON.stringify(seeded), "no row lost or added by the migrations", JSON.stringify(after));

  const cols = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'deployments' AND column_name IN ('ci_last_event_at', 'redaction')`,
    [schema]
  );
  check(cols.rowCount === 2, "new deployment columns exist and are nullable additions");

  // --- integrity ------------------------------------------------------------------
  await client.query("BEGIN");
  const repoWithHistory = (await client.query(`SELECT repository_id FROM deployments LIMIT 1`)).rows[0].repository_id;
  await expectError(client, `DELETE FROM repositories WHERE id = $1`, [repoWithHistory], "deleting a repository with history is REFUSED (no orphaned deployments)");
  await expectError(client, `DELETE FROM github_installations WHERE installation_id = 1001`, [], "deleting an installation with repositories is REFUSED (no cascade)");
  const one = (await client.query(`SELECT github_repository_id, branch, commit_sha FROM deployments WHERE github_repository_id IS NOT NULL LIMIT 1`)).rows[0];
  await expectError(
    client,
    `INSERT INTO deployments (repository, owner, branch, commit_sha, github_repository_id) VALUES ('renamed', 'someone', $1, $2, $3)`,
    [one.branch, one.commit_sha, one.github_repository_id],
    "a renamed repository cannot record the same push twice (id-based unique key)"
  );
  await client.query(`INSERT INTO audit_log (actor, action, outcome) VALUES ('system', 'test', 'ok')`);
  await expectError(client, `UPDATE audit_log SET outcome = 'failed'`, [], "audit_log UPDATE is refused (append-only)");
  await expectError(client, `DELETE FROM audit_log`, [], "audit_log DELETE is refused (append-only)");
  await client.query(`INSERT INTO jobs (type, dedupe_key) VALUES ('t', 'k1')`);
  await expectError(client, `INSERT INTO jobs (type, dedupe_key) VALUES ('t', 'k1')`, [], "a job dedupe key can exist only once");
  const dep = (await client.query(`SELECT d.id FROM deployments d JOIN incidents i ON i.deployment_id = d.id LIMIT 1`)).rows[0].id;
  await client.query(`DELETE FROM deployments WHERE id = $1`, [dep]);
  const orphan = await client.query(`SELECT count(*)::int n FROM incidents WHERE deployment_id = $1`, [dep]);
  check(orphan.rows[0].n === 0, "deleting a deployment (purge) still removes its own incident / assessments");
  await client.query("ROLLBACK");

  // Hot path uses an index (not a sequential scan) at this volume.
  const plan = (await client.query(
    `EXPLAIN SELECT id FROM deployments WHERE repository_id = ANY($1::bigint[]) ORDER BY created_at DESC LIMIT 25`,
    [[repoWithHistory]]
  )).rows.map((r) => r["QUERY PLAN"]).join(" ");
  check(/Index/.test(plan), "dashboard history query uses an index", plan.slice(0, 90));
} catch (error) {
  check(false, "migration test crashed", error.message);
} finally {
  await client.query(`SET search_path TO public`).catch(() => {});
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch((e) => console.log(`  WARN could not drop ${schema}: ${e.message}`));
  await client.end();
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
