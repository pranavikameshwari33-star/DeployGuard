import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeChanges, classifyFile } from "../lib/analysis/change-analysis.ts";
import { matchesGlob } from "../lib/analysis/glob.ts";
import { parseRepoConfig, analysisConfigOf, DEFAULT_CONFIG } from "../lib/config/repo-config.ts";
import { parseCodeowners, ownersOf, ownersOfFiles } from "../lib/config/codeowners.ts";
import { escapeMarkdown, renderCheck } from "../lib/github/check-output.ts";

/** Stage 5: better inputs to the analysis (pure parts). */

const cats = (p) => classifyFile(p, "modified").categories;

// ---------------------------------------------------------------- 5.4 signals
test("5.4 migrations are explicit (and still database)", () => {
  for (const p of ["db/migrations/001_init.sql", "prisma/migrations/20240101_x/migration.sql", "alembic/versions/abc_add.py", "db/0042_add_index.sql", "src/users.migration.ts"]) {
    assert.ok(cats(p).includes("migration") && cats(p).includes("database"), p);
  }
  assert.ok(!cats("src/migrate-users-button.tsx").includes("migration"));
});

test("5.4 lockfiles and dependency manifests are told apart", () => {
  for (const p of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "go.sum", "Cargo.lock"]) {
    assert.ok(cats(p).includes("lockfile") && !cats(p).includes("dependency_manifest"), p);
  }
  for (const p of ["package.json", "requirements.txt", "requirements-dev.txt", "go.mod", "pyproject.toml", "Gemfile"]) {
    assert.ok(cats(p).includes("dependency_manifest") && !cats(p).includes("lockfile"), p);
  }
});

test("5.4 infrastructure-as-code, containers, CI and environment files", () => {
  for (const p of ["terraform/main.tf", "infra/vpc.tf", "env/prod.tfvars", "k8s/deployment.yaml", "helm/app/values.yaml", "serverless.yml"]) assert.ok(cats(p).includes("iac"), p);
  for (const p of ["Dockerfile", "docker/Dockerfile.prod", "api.Dockerfile", "docker-compose.yml", "compose.prod.yaml"]) assert.ok(cats(p).includes("container"), p);
  for (const p of [".github/workflows/ci.yml", ".gitlab-ci.yml", "Jenkinsfile"]) assert.ok(cats(p).includes("ci_cd"), p);
  for (const p of [".env.production", "config/production.yml", "environments/staging.json", "app.env"]) assert.ok(cats(p).includes("environment"), p);
  for (const p of ["src/app.ts", "README.md", "config/logging.yml"]) assert.ok(!cats(p).includes("environment") && !cats(p).includes("iac") && !cats(p).includes("container"), p);
});

// ---------------------------------------------------------------- globs
test("5.2 globs: **, *, ?, directory and anchored patterns", () => {
  assert.ok(matchesGlob("src/payments/stripe/charge.ts", "src/payments/**"));
  assert.ok(!matchesGlob("lib/payments/x.ts", "src/payments/**"));
  assert.ok(matchesGlob("infra/a/main.tf", "*.tf"));
  assert.ok(matchesGlob("docs/a/b.md", "docs/"));
  assert.ok(matchesGlob("docs/a.md", "/docs/**"));
  assert.ok(!matchesGlob("x/docs/a.md", "/docs/**"));
  assert.ok(matchesGlob("a1.txt", "a?.txt") && !matchesGlob("a12.txt", "a?.txt"));
});

// ---------------------------------------------------------------- 5.2 config
const GOOD = `version: 1
pull_request_checks: false
ignore:
  - "docs/**"
critical_paths:
  - "src/payments/**"
services:
  "services/legacy-billing/**": billing
categories:
  "db/schema/**": [database, migration]
`;

test("5.2 a valid config is parsed and normalised", () => {
  const r = parseRepoConfig(GOOD);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.config.pull_request_checks, false);
  assert.deepEqual(r.config.ignore, ["docs/**"]);
  assert.deepEqual(r.config.categories, [{ pattern: "db/schema/**", categories: ["database", "migration"] }]);
});

test("5.2 invalid configs are rejected with line numbers (strict subset, nothing executable)", () => {
  const bad = {
    "wrong version": "version: 2",
    "unknown key": "version: 1\nshell: rm -rf /",
    "YAML anchor": "version: 1\nignore:\n  - &x docs",
    "YAML tag": "version: 1\nignore:\n  - !!python/object x",
    "block scalar": "version: 1\nignore: |\n  docs",
    "unknown category": "version: 1\ncategories:\n  \"x/**\": [rockets]",
    "bad service name": "version: 1\nservices:\n  \"x/**\": \"a b\"",
    "path traversal": "version: 1\nignore:\n  - ../secrets",
    "tabs": "version: 1\nignore:\n\t- docs",
    "missing version": "ignore:\n  - docs",
    "duplicate key": "version: 1\nversion: 1",
  };
  for (const [name, text] of Object.entries(bad)) {
    const r = parseRepoConfig(text);
    assert.equal(r.ok, false, name);
    assert.ok(r.errors.length > 0, name);
  }
  assert.equal(parseRepoConfig("x".repeat(70 * 1024)).ok, false, "size limit");
  assert.match(parseRepoConfig("version: 1\nfoo: 1").errors[0], /^line 2:/);
});

test("5.2 the config shapes the analysis: categories, services, critical, ignore", () => {
  const config = analysisConfigOf(parseRepoConfig(GOOD).config);
  const a = analyzeChanges({ added: [], modified: ["db/schema/users.sql", "services/legacy-billing/x.ts", "src/payments/pay.ts", "docs/guide.md"], deleted: [] }, config);
  const byPath = Object.fromEntries(a.files.map((f) => [f.path, f]));
  assert.ok(byPath["db/schema/users.sql"].categories.includes("migration"));
  assert.equal(byPath["services/legacy-billing/x.ts"].service, "billing");
  assert.equal(byPath["src/payments/pay.ts"].critical, true);
  assert.equal(byPath["docs/guide.md"].ignored, true);
  assert.ok(!a.categories.includes("documentation"), "ignored files do not shape the union");
  assert.deepEqual(a.critical, ["src/payments/pay.ts"]);
  // Without config the analysis is unchanged.
  const plain = analyzeChanges({ added: [], modified: ["docs/guide.md"], deleted: [] });
  assert.ok(plain.categories.includes("documentation"));
  assert.equal(DEFAULT_CONFIG.pull_request_checks, true);
});

// ---------------------------------------------------------------- 5.3 CODEOWNERS
test("5.3 CODEOWNERS: last match wins, emails dropped, empty owners = unowned", () => {
  const { rules, emailsDropped } = parseCodeowners(`# owners
*            @acme/core
/src/payments/  @acme/payments @alice
*.md         docs@acme.com
/vendor/
`);
  assert.equal(emailsDropped, 1);
  assert.deepEqual(ownersOf("src/payments/pay.ts", rules), ["@acme/payments", "@alice"]);
  assert.deepEqual(ownersOf("src/app.ts", rules), ["@acme/core"]);
  assert.deepEqual(ownersOf("README.md", rules), [], "the email-only line wins and leaves no shown owner");
  assert.deepEqual(ownersOf("vendor/lib.js", rules), []);
  const summary = ownersOfFiles(["src/payments/a.ts", "src/payments/b.ts", "src/app.ts", "vendor/x.js"], rules);
  assert.deepEqual(summary.owners[0], { owner: "@acme/payments", files: 2 });
  assert.equal(summary.unowned, 1);
});

// ---------------------------------------------------------------- 5.1 check output
const baseInput = {
  prNumber: 7, level: "HIGH", unavailable: null, confidence: 0.6, summary: "Touches the pool.",
  reasons: [], cited: [], matches: [], categories: ["database"], criticalFiles: [], ignoredFiles: 0, owners: [],
  configStatus: "valid", filesAnalysed: 2, filesTruncated: false, dashboardBase: null, githubRepositoryId: "123",
};

test("5.1 check output escapes untrusted text and builds links only from ids", () => {
  const out = renderCheck({
    ...baseInput,
    summary: "<script>alert(1)</script> see [click](https://evil.example) @everyone",
    reasons: [{ reason: "**bold** ![img](http://x/y.png)", basis: "inference" }],
    cited: [{ deployment_id: "12", outcome: "FAILED", relevance_note: "token ghp_" + "a".repeat(36) }],
    owners: [{ owner: "@acme/payments", files: 2 }],
    dashboardBase: "https://deployguard.example.com",
  });
  const all = `${out.title}\n${out.summary}\n${out.text}`;
  assert.ok(!all.includes("<script>"), "no raw HTML");
  assert.ok(!all.includes("](https://evil.example)"), "no model-made links");
  assert.ok(!all.includes("![img]"), "no images");
  assert.ok(!/(^|[^\\])@everyone/.test(all) && !/(^|[^\\])@acme/.test(all), "mentions are escaped (no notifications)");
  assert.ok(!all.includes("ghp_aaaa"), "secrets redacted");
  assert.ok(all.includes("[deployment 12](https://deployguard.example.com/?repo=123&id=12)"), "links built from numeric ids only");
  assert.match(out.summary, /never blocks merging|never fails/);
});

test("5.1 no risk level is invented when the analysis is unavailable", () => {
  const out = renderCheck({ ...baseInput, level: null, unavailable: "the model's answer failed validation", confidence: null, summary: null });
  assert.match(out.title, /unavailable/);
  assert.ok(!/\b(LOW|MEDIUM|HIGH)\b/.test(out.title + out.summary));
  assert.equal(escapeMarkdown("a\nb"), "a b");
});
