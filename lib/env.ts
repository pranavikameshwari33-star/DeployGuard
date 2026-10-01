/**
 * One place that reads environment variables.
 *
 * Rules that the rest of the codebase relies on:
 *  - Secrets are read here and nowhere else, so they cannot leak into a log by
 *    accident somewhere in the app.
 *  - A missing variable throws a message naming the VARIABLE, never its value.
 *  - This file is only ever imported by server-side code. Nothing here is
 *    prefixed with NEXT_PUBLIC_, so Next.js will never ship it to the browser.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing environment variable ${name}. Add it to .env.local and restart the dev server.`
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

export const env = {
  githubWebhookSecret: () => required("GITHUB_WEBHOOK_SECRET"),
  databaseUrl: () => required("DATABASE_URL"),
  hindsightApiKey: () => required("HINDSIGHT_API_KEY"),
  hindsightBaseUrl: () =>
    optional("HINDSIGHT_BASE_URL", "https://api.hindsight.vectorize.io").replace(/\/+$/, ""),
  hindsightBankId: () => optional("HINDSIGHT_BANK_ID", "DeployGuard"),
  /**
   * CI/status reporting ONLY: accepted by POST /api/deployments/status and
   * nowhere else. It lives in GitHub Actions secrets, so it is the credential
   * most likely to leak; it must not unlock anything else.
   */
  deployguardStatusToken: () => required("DEPLOYGUARD_STATUS_TOKEN"),
  /**
   * Stage 1: internal maintenance/administrative operations ONLY (maintenance
   * run, memory backfill, unscoped reads for verification scripts, operational
   * health detail). Rejected by the CI status route. Server-only.
   */
  deployguardInternalToken: () => required("DEPLOYGUARD_INTERNAL_TOKEN"),
  /** Phase 7: risk analysis. The key is sent only as a request header, never in a URL. */
  geminiApiKey: () => required("GEMINI_API_KEY"),
  /**
   * Pinned to a stable model (not a moving "-latest" alias) so behaviour does not
   * change silently. Override with GEMINI_MODEL, e.g. gemini-3.5-flash.
   */
  geminiModel: () => optional("GEMINI_MODEL", "gemini-3.5-flash-lite"),

  // --- Phase 9: GitHub App (login + repository connection) ---
  githubAppId: () => required("GITHUB_APP_ID"),
  githubAppClientId: () => required("GITHUB_APP_CLIENT_ID"),
  githubAppClientSecret: () => required("GITHUB_APP_CLIENT_SECRET"),
  /** Accepts a multi-line PEM or a single line with escaped "\n" sequences. */
  githubAppPrivateKey: () => required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
};

/** Every variable whose value is a secret. Used by the tripwire below and by startup validation. */
export const SECRET_ENV_NAMES = [
  "GITHUB_WEBHOOK_SECRET",
  "DEPLOYGUARD_STATUS_TOKEN",
  "DEPLOYGUARD_INTERNAL_TOKEN",
  "DATABASE_URL",
  "HINDSIGHT_API_KEY",
  "GEMINI_API_KEY",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
  "SUPABASE_SECRET_KEY",
] as const;

/** Required for the app to work at all. Checked at startup (instrumentation.ts). */
export const REQUIRED_ENV_NAMES = [
  "GITHUB_WEBHOOK_SECRET",
  "DEPLOYGUARD_STATUS_TOKEN",
  "DEPLOYGUARD_INTERNAL_TOKEN",
  "DATABASE_URL",
  "HINDSIGHT_API_KEY",
  "GEMINI_API_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
] as const;

/**
 * Stage 1 tripwire: returns the NAME of the first server secret whose value
 * appears verbatim in `text`, or null. Used right before data leaves the
 * server for Hindsight or Gemini. Never returns or logs the value itself.
 * Values shorter than 12 characters are skipped (too likely to occur by chance).
 */
export function findServerSecretIn(text: string): string | null {
  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name]?.trim();
    if (!value || value.length < 12) continue;
    if (text.includes(value)) return name;
    // A multi-line PEM may appear with escaped newlines, or one line of it may appear alone.
    if (name === "GITHUB_APP_PRIVATE_KEY") {
      const lines = value
        .replace(/\\n/g, "\n")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length >= 40 && !l.startsWith("-----"));
      if (lines.some((line) => text.includes(line))) return name;
    }
  }
  return null;
}

/**
 * Stage 1: fail fast on bad configuration. Returns problems as messages naming
 * the variable, never its value. In production the caller throws on any
 * problem; in development it only warns, so a partial local setup still starts.
 */
export function validateServerEnv(): string[] {
  const problems: string[] = [];
  for (const name of REQUIRED_ENV_NAMES) {
    if (!process.env[name]?.trim()) problems.push(`Missing environment variable ${name}. Add it to .env.local (or the host's environment).`);
  }
  const status = process.env.DEPLOYGUARD_STATUS_TOKEN?.trim();
  const internal = process.env.DEPLOYGUARD_INTERNAL_TOKEN?.trim();
  if (status && internal && status === internal) {
    problems.push("DEPLOYGUARD_STATUS_TOKEN and DEPLOYGUARD_INTERNAL_TOKEN must be different values.");
  }
  for (const name of ["DEPLOYGUARD_STATUS_TOKEN", "DEPLOYGUARD_INTERNAL_TOKEN", "GITHUB_WEBHOOK_SECRET"]) {
    const v = process.env[name]?.trim();
    if (v && v.length < 32) problems.push(`${name} is too short; use at least 32 random characters.`);
  }
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("NEXT_PUBLIC_") && /SECRET|TOKEN|KEY|PASSWORD|DATABASE/i.test(name)) {
      problems.push(`${name} looks like a secret but NEXT_PUBLIC_ variables are shipped to the browser. Rename it.`);
    }
  }
  return problems;
}
