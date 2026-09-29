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
  /** Shared with GitHub Actions so only our own pipeline can change a deployment's status. */
  deployguardStatusToken: () => required("DEPLOYGUARD_STATUS_TOKEN"),
};
