/**
 * Phase 5: deterministic change analysis.
 *
 * Answers "what kind of thing changed, and which service/component may be
 * affected?" from file PATHS alone. It never opens a file, so it cannot read or
 * leak the contents of a secret file such as .env.
 *
 * Deterministic by design: fixed rules, no AI, no network. The same file list
 * always produces the same analysis, and every label can be traced to the rule
 * below that produced it. Anything no rule recognises is "unknown" -- the
 * analyzer never guesses.
 *
 * It imports only the pure glob helper (relative path), so the unit tests and
 * verification scripts can load it directly with Node's type stripping.
 *
 * Stage 5: explicit categories for migrations, lockfiles, dependency
 * manifests, infrastructure-as-code, container files and environment files,
 * and an optional per-repository config (.deployguard.yml) that can add
 * categories, map paths to services, mark critical paths and ignore paths.
 */
import { matchesGlob } from "./glob.ts";

/** The fixed set of categories, in the order they are always reported. */
export const CHANGE_CATEGORIES = [
  "application_code",
  "database",
  "configuration",
  "authentication",
  "payments",
  "api",
  "infrastructure",
  "ci_cd",
  "tests",
  "documentation",
  "dependencies",
  // Stage 5: finer signals. They are added alongside the broad categories above.
  "migration",
  "lockfile",
  "dependency_manifest",
  "iac",
  "container",
  "environment",
  "unknown",
] as const;

export type ChangeCategory = (typeof CHANGE_CATEGORIES)[number];
export type ChangeType = "added" | "modified" | "deleted";

/** The analysis of one changed file. */
export type FileAnalysis = {
  path: string;
  change_type: ChangeType;
  categories: ChangeCategory[];
  /** The service/component named by the path, or null when the path does not name one. */
  service: string | null;
  /** Stage 5 (.deployguard.yml): matched a critical path / an ignore pattern; which config rules applied. */
  critical?: boolean;
  ignored?: boolean;
  rules?: string[];
};

/** Stage 5: the validated, normalised part of .deployguard.yml that affects analysis. */
export type AnalysisConfig = {
  ignore: string[];
  critical: string[];
  services: { pattern: string; service: string }[];
  categories: { pattern: string; categories: ChangeCategory[] }[];
};

/** The analysis of a whole push. `categories` and `services` are the union over all files. */
export type ChangeAnalysis = {
  files: FileAnalysis[];
  categories: ChangeCategory[];
  services: string[];
  /** Stage 5: paths matching a configured critical path / ignore pattern. */
  critical?: string[];
  ignored?: string[];
};

// ---------------------------------------------------------------------------
// Rules. Words are matched as whole path tokens: `src/db/pool.ts` has the
// tokens src, db, pool, ts, and `LoginForm.tsx` has login, form, tsx.
// ---------------------------------------------------------------------------

/** Domain words: a file whose path contains one belongs to that area. */
const DOMAIN_WORDS: [ChangeCategory, string[]][] = [
  ["database", ["db", "database", "databases", "migration", "migrations", "postgres", "postgresql", "mysql", "sqlite", "mongo", "mongodb", "prisma", "sql"]],
  ["authentication", ["auth", "authentication", "authn", "authz", "login", "logout", "signin", "signup", "oauth", "oauth2", "jwt", "sso", "session", "sessions", "password", "passwords"]],
  ["payments", ["payment", "payments", "billing", "checkout", "invoice", "invoices", "stripe", "charge", "charges", "subscription", "subscriptions", "refund", "refunds"]],
  ["api", ["api", "apis", "graphql", "grpc", "openapi", "swagger", "endpoint", "endpoints"]],
];

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "java", "kt", "go", "rb", "rs", "cs",
  "cpp", "cc", "c", "h", "hpp", "php", "swift", "scala", "vue", "svelte",
]);
const CONFIG_EXTENSIONS = new Set(["json", "yaml", "yml", "toml", "ini", "conf", "cfg", "properties", "env"]);
const DOC_EXTENSIONS = new Set(["md", "mdx", "rst", "adoc"]);
const DATABASE_EXTENSIONS = new Set(["sql", "prisma"]);
const INFRA_EXTENSIONS = new Set(["tf", "tfvars", "hcl"]);

const DEPENDENCY_FILES = new Set([
  "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json",
  "requirements.txt", "pipfile", "pipfile.lock", "poetry.lock", "pyproject.toml",
  "go.mod", "go.sum", "cargo.toml", "cargo.lock", "gemfile", "gemfile.lock",
  "pom.xml", "build.gradle", "build.gradle.kts", "composer.json", "composer.lock",
]);
/** Stage 5: exact dependency resolutions vs declared dependencies. */
const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "npm-shrinkwrap.json", "bun.lockb", "pipfile.lock",
  "poetry.lock", "uv.lock", "go.sum", "cargo.lock", "gemfile.lock", "composer.lock", "packages.lock.json", "gradle.lockfile",
]);
const MANIFESTS = new Set([
  "package.json", "pipfile", "pyproject.toml", "setup.py", "setup.cfg", "go.mod", "cargo.toml", "gemfile",
  "pom.xml", "build.gradle", "build.gradle.kts", "composer.json",
]);
const MIGRATION_DIRS = new Set(["migrations", "migration", "migrate", "alembic", "flyway", "liquibase", "changelogs"]);
const IAC_DIRS = new Set(["terraform", "k8s", "kubernetes", "helm", "charts", "ansible", "pulumi", "cloudformation", "cdk", "bicep"]);
const IAC_FILES = new Set(["serverless.yml", "serverless.yaml", "cdk.json", "pulumi.yaml", "pulumi.yml", "chart.yaml", "kustomization.yaml", "kustomization.yml", "skaffold.yaml"]);
const IAC_EXTENSIONS = new Set(["tf", "tfvars", "hcl", "bicep"]);
const ENVIRONMENT_NAMES = new Set(["production", "prod", "staging", "stage", "development", "dev", "qa", "uat", "preview"]);

const DOC_NAMES = new Set(["readme", "changelog", "license", "contributing", "code_of_conduct"]);
const CI_FILES = new Set([".gitlab-ci.yml", "jenkinsfile", ".travis.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml"]);
const CI_DIRS = [".github/workflows/", ".circleci/", ".buildkite/"];
const INFRA_DIRS = new Set(["k8s", "kubernetes", "helm", "charts", "terraform", "infra", "infrastructure", "ansible"]);
const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "e2e"]);
const DOC_DIRS = new Set(["docs", "doc"]);
const CONFIG_DIRS = new Set(["config", "configs", "settings"]);

/** Top-level folders whose sub-folders are services: services/<name>/... */
const SERVICE_PARENT_DIRS = new Set(["services", "service", "apps", "microservices", "packages"]);
/** Top-level folders that are components in their own right. */
const COMPONENT_DIRS = new Set(["frontend", "backend", "client", "server", "web", "mobile", "worker"]);
/** A top-level folder named like payment-service or auth-api is itself a service. */
const SERVICE_DIR_PATTERN = /^[a-z0-9][a-z0-9_.-]*[-_](service|svc|api|app|worker)$|^(service|svc)[-_][a-z0-9_.-]+$/;

/** Classifies one path. Pure: no I/O, same answer every time. */
export function classifyFile(path: string, changeType: ChangeType, config?: AnalysisConfig): FileAnalysis {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const lower = normalized.toLowerCase();
  const segments = lower.split("/").filter(Boolean);
  const dirs = segments.slice(0, -1);
  const base = segments[segments.length - 1] ?? "";
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1) : "";
  const stem = dot > 0 ? base.slice(0, base.indexOf(".", base.startsWith(".") ? 1 : 0)) : base;
  const tokens = new Set(tokenize(normalized));

  const found = new Set<ChangeCategory>();

  // --- structural rules: what kind of file is this? --------------------------
  const isCi = CI_FILES.has(base) || CI_DIRS.some((dir) => lower.startsWith(dir));
  const isInfra =
    isCi ||
    base === "dockerfile" || base.startsWith("dockerfile.") || base === ".dockerignore" ||
    /^(docker-)?compose(\.[a-z0-9_-]+)?\.ya?ml$/.test(base) ||
    INFRA_EXTENSIONS.has(ext) ||
    dirs.some((dir) => INFRA_DIRS.has(dir));
  const isDependency = DEPENDENCY_FILES.has(base);
  const isTest =
    /\.(test|spec)\.[a-z0-9]+$/.test(base) || dirs.some((dir) => TEST_DIRS.has(dir));
  const isDoc =
    DOC_EXTENSIONS.has(ext) || DOC_NAMES.has(stem) || dirs.some((dir) => DOC_DIRS.has(dir));
  const isEnvFile = base === ".env" || base.startsWith(".env.");
  const isToolConfig = /\.config\.[a-z]+$/.test(base) || /^\.[a-z0-9_-]+rc(\.[a-z]+)?$/.test(base);

  // --- Stage 5: finer, explicit signals -----------------------------------------
  const isRequirements = /^requirements([-_.][a-z0-9_-]+)?\.(txt|in)$/.test(base);
  const isLockfile = LOCKFILES.has(base);
  const isManifest = MANIFESTS.has(base) || isRequirements;
  const isMigration =
    dirs.some((dir) => MIGRATION_DIRS.has(dir)) ||
    /\.migration\.[a-z0-9]+$/.test(base) ||
    (/^(v?\d{3,}|\d{8,})[_.-][a-z0-9_.-]+\.(sql|py|rb|js|ts)$/.test(base) && dirs.some((dir) => ["db", "database", "sql", "schema"].includes(dir)));
  const isIac =
    IAC_EXTENSIONS.has(ext) || IAC_FILES.has(base) || dirs.some((dir) => IAC_DIRS.has(dir)) ||
    /(^|[.-])(cloudformation|cfn)([.-]|$)/.test(stem);
  const isContainer =
    base === "dockerfile" || base.startsWith("dockerfile.") || base.endsWith(".dockerfile") || base === "containerfile" ||
    base === ".dockerignore" || /^(docker-)?compose(\.[a-z0-9_-]+)?\.ya?ml$/.test(base);
  const isEnvironment =
    isEnvFile || ext === "env" ||
    (CONFIG_EXTENSIONS.has(ext) && ENVIRONMENT_NAMES.has(stem.replace(/^(application|appsettings|config|settings)[._-]/, ""))) ||
    dirs.some((dir) => dir === "environments" || dir === "envs");

  if (isMigration) found.add("migration").add("database");
  if (isLockfile) found.add("lockfile").add("dependencies");
  if (isManifest) found.add("dependency_manifest").add("dependencies");
  if (isIac) found.add("iac").add("infrastructure");
  if (isContainer) found.add("container").add("infrastructure");
  if (isEnvironment) found.add("environment").add("configuration");

  if (isCi) found.add("ci_cd");
  if (isInfra) found.add("infrastructure");
  if (isDependency) found.add("dependencies");
  if (isTest) found.add("tests");
  if (isDoc && !isDependency) found.add("documentation");
  if (DATABASE_EXTENSIONS.has(ext)) found.add("database");

  // Configuration: env files, config folders and tool configs always; data
  // formats (.json/.yaml/...) only when no more specific rule already explained
  // the file -- a workflow .yml is CI, not generic configuration.
  if (
    isEnvFile ||
    isToolConfig ||
    dirs.some((dir) => CONFIG_DIRS.has(dir)) ||
    (CONFIG_EXTENSIONS.has(ext) && !isInfra && !isDependency)
  ) {
    found.add("configuration");
  }

  // Application code: a source-language file that is not a test, not a tool
  // config and not part of the pipeline/infrastructure.
  if (CODE_EXTENSIONS.has(ext) && !isTest && !isToolConfig && !isInfra) {
    found.add("application_code");
  }

  // --- domain rules: which part of the system? --------------------------------
  // Applied to every file, tests included: payment-service/tests/x.test.ts is
  // still about payments.
  for (const [category, words] of DOMAIN_WORDS) {
    if (words.some((word) => tokens.has(word))) found.add(category);
  }

  // --- Stage 5: repository config (.deployguard.yml), applied last --------------
  const rules: string[] = [];
  let service: string | null = null;
  let critical = false;
  let ignored = false;
  if (config) {
    for (const rule of config.categories) {
      if (matchesGlob(normalized, rule.pattern)) {
        rule.categories.forEach((c) => found.add(c));
        rules.push(`categories:${rule.pattern}`);
      }
    }
    for (const rule of config.services) {
      if (service === null && matchesGlob(normalized, rule.pattern)) {
        service = rule.service;
        rules.push(`service:${rule.pattern}`);
      }
    }
    critical = config.critical.some((p) => matchesGlob(normalized, p));
    ignored = config.ignore.some((p) => matchesGlob(normalized, p));
    if (critical) rules.push("critical");
    if (ignored) rules.push("ignored");
  }

  if (found.size === 0) found.add("unknown");
  else if (found.size > 1) found.delete("unknown");

  const categories = CHANGE_CATEGORIES.filter((category) => found.has(category));
  return {
    path: normalized,
    change_type: changeType,
    categories,
    service: service ?? serviceFor(segments, categories),
    ...(critical ? { critical: true } : {}),
    ...(ignored ? { ignored: true } : {}),
    ...(rules.length ? { rules } : {}),
  };
}

/**
 * The service/component a path names, or null. Only the folder structure is
 * used; nothing is inferred about what depends on what.
 *
 *   services/auth/login.ts          -> auth
 *   payment-service/checkout.ts     -> payment-service
 *   frontend/components/Login.tsx   -> frontend
 *   src/db/pool.ts                  -> database   (database files, see below)
 *   src/auth/login.ts               -> null       (src/ names no service)
 */
function serviceFor(segments: string[], categories: ChangeCategory[]): string | null {
  const [first, second] = segments;
  const isDirectory = segments.length > 1;

  if (isDirectory && SERVICE_PARENT_DIRS.has(first) && segments.length > 2) return second;
  if (isDirectory && SERVICE_DIR_PATTERN.test(first)) return first;
  if (isDirectory && COMPONENT_DIRS.has(first)) return first;

  // The database is a shared component every service talks to, so a change to
  // database code or config is attributed to it -- but not a test or a doc
  // that merely mentions it.
  if (
    categories.includes("database") &&
    !categories.includes("tests") &&
    !categories.includes("documentation")
  ) {
    return "database";
  }
  return null;
}

/** Analyses a whole push. Files come back sorted by path; unions are in canonical order. */
export function analyzeChanges(
  files: { added: string[]; modified: string[]; deleted: string[] },
  /** Stage 5: the repository's validated .deployguard.yml, if any. */
  config?: AnalysisConfig
): ChangeAnalysis {
  const analysed = [
    ...files.added.map((path) => classifyFile(path, "added", config)),
    ...files.modified.map((path) => classifyFile(path, "modified", config)),
    ...files.deleted.map((path) => classifyFile(path, "deleted", config)),
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Ignored files stay in the file list (labelled) but do not shape the union.
  const counted = analysed.filter((file) => !file.ignored);
  const categorySet = new Set(counted.flatMap((file) => file.categories));
  const services = [
    ...new Set(counted.map((file) => file.service).filter((s): s is string => s !== null)),
  ].sort();

  return {
    files: analysed,
    categories: CHANGE_CATEGORIES.filter((category) => categorySet.has(category)),
    services,
    ...(config
      ? { critical: analysed.filter((f) => f.critical).map((f) => f.path), ignored: analysed.filter((f) => f.ignored).map((f) => f.path) }
      : {}),
  };
}

/** Splits a path into lowercase word tokens, including camelCase boundaries. */
function tokenize(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
