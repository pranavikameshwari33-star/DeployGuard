/**
 * Stage 1: configuration check at server start (Next.js calls register() once
 * per server instance, before it handles requests).
 *
 * Production: any problem stops the server with a message naming the
 * variable (never its value). Development: problems are printed as warnings,
 * so a partial local setup still starts.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { validateServerEnv } = await import("@/lib/env");
  const problems = validateServerEnv();
  if (problems.length === 0) return;

  const message = `[DeployGuard][config] ${problems.length} configuration problem(s):\n  - ${problems.join("\n  - ")}`;
  if (process.env.NODE_ENV === "production") {
    throw new Error(message);
  }
  console.warn(message);
}
