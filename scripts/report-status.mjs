/**
 * Reports a pipeline status to DeployGuard. Runs INSIDE GitHub Actions:
 *
 *   node scripts/report-status.mjs BUILDING
 *   node scripts/report-status.mjs SUCCESS
 *   node scripts/report-status.mjs FAILED
 *
 * Everything it needs comes from the environment GitHub Actions provides:
 *   GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_SHA, GITHUB_RUN_ID, ...  (built in)
 *   DEPLOYGUARD_URL            repo variable, e.g. https://xxxx.ngrok-free.app
 *   DEPLOYGUARD_STATUS_TOKEN   repo secret, the same value as in .env.local
 *   OUTCOME_<STAGE>            set by the workflow, used to find the failed stage
 *
 * Two deliberate choices:
 *  - It never makes the pipeline fail. The build result on GitHub must reflect
 *    the code, not whether DeployGuard happened to be reachable. Problems are
 *    printed as ::warning:: annotations instead.
 *  - The token is only ever placed in the Authorization header and is never
 *    printed. GitHub also masks secrets in logs as a second layer.
 */
import fs from "node:fs";
import path from "node:path";

// Pipeline stages in the order the workflow runs them.
const STAGES = ["install", "test", "build", "deploy"];
const LOG_TAIL_LINES = 40;
const ATTEMPTS = 6;
const RETRY_DELAY_MS = 5000;

const status = (process.argv[2] ?? "").toUpperCase();
if (!["BUILDING", "SUCCESS", "FAILED"].includes(status)) {
  warn(`report-status: unknown status "${process.argv[2]}". Expected BUILDING, SUCCESS or FAILED.`);
  process.exit(0);
}

const baseUrl = (process.env.DEPLOYGUARD_URL ?? "").trim().replace(/\/+$/, "");
const token = (process.env.DEPLOYGUARD_STATUS_TOKEN ?? "").trim();

if (!baseUrl || !token) {
  warn(
    "DeployGuard reporting is not configured, so this run was not reported. " +
      "Add the DEPLOYGUARD_URL repository variable and the DEPLOYGUARD_STATUS_TOKEN repository secret."
  );
  process.exit(0);
}

const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
const body = {
  repository: process.env.GITHUB_REPOSITORY,
  branch: process.env.GITHUB_REF_NAME,
  commitSha: process.env.GITHUB_SHA,
  status,
  runId: process.env.GITHUB_RUN_ID,
  runUrl: `${server}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
};

if (status === "FAILED") {
  const stage = STAGES.find((s) => process.env[`OUTCOME_${s.toUpperCase()}`] === "failure");
  body.failure = {
    // No failed stage found means an earlier step (e.g. checkout) broke.
    stage: stage ?? "setup",
    job: process.env.DEPLOYGUARD_JOB_NAME ?? process.env.GITHUB_JOB,
    message: stage ? readLogTail(stage) : "The pipeline failed before any DeployGuard stage ran.",
  };
}

await send();

async function send() {
  const url = `${baseUrl}/api/deployments/status`;

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let response;
    let result;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          // Lets requests through ngrok's free-tier browser warning page.
          "ngrok-skip-browser-warning": "1",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      try {
        result = JSON.parse(text);
      } catch {
        result = { raw: text.slice(0, 300) };
      }
    } catch (error) {
      console.log(`Attempt ${attempt}: could not reach DeployGuard (${error.message}).`);
      await pause(attempt);
      continue;
    }

    if (response.ok) {
      console.log(
        `DeployGuard: deployment #${result.deploymentId} ${result.previousStatus} -> ${result.status}`
      );
      return;
    }

    // 404: the push webhook may simply not have landed yet -- it races this job.
    // 5xx: a temporary server or database problem. Both are worth retrying.
    // 400/401/409 will not fix themselves, so stop.
    const retryable = response.status === 404 || response.status >= 500;
    console.log(`Attempt ${attempt}: HTTP ${response.status} ${JSON.stringify(result)}`);
    if (!retryable) break;
    await pause(attempt);
  }

  warn(`DeployGuard did not accept the ${status} report. See the attempts above.`);
}

/** The last lines the failing stage printed, with terminal colour codes removed. */
function readLogTail(stage) {
  const file = path.join(process.env.RUNNER_TEMP ?? ".", `deployguard-${stage}.log`);
  try {
    const lines = fs
      .readFileSync(file, "utf8")
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n")
      .filter((line) => line.trim() !== "");
    return lines.slice(-LOG_TAIL_LINES).join("\n");
  } catch {
    return `The ${stage} stage failed, but its output could not be read.`;
  }
}

function pause(attempt) {
  if (attempt === ATTEMPTS) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
}

function warn(message) {
  console.log(`::warning title=DeployGuard::${message}`);
}
