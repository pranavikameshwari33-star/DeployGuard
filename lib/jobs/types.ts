/** Stage 2: the job types (kept apart from the handlers so enqueuers do not import them). */
export const JOB_TYPES = {
  workflowRun: "webhook.workflow_run",
  deploymentMemory: "memory.deployment",
  incidentMemory: "memory.incident",
  riskAnalyze: "risk.analyze",
  installationReconcile: "installation.reconcile",
  /** Stage 4.1: one bounded re-evaluation after a confirmed cause changed. */
  learningReevaluate: "learning.reevaluate",
  /** Stage 5: re-read .deployguard.yml and CODEOWNERS from the default branch. */
  repoInputsRefresh: "repo.inputs_refresh",
  /** Stage 5.1: advisory pull request risk check (payload in the delivery log). */
  pullRequestCheck: "github.pull_request_check",
  /** Stage 5.5: a deployment_status event (payload in the delivery log). */
  deploymentStatus: "github.deployment_status",
  /** Stage 5.5: ask the Deployments API about one deployment's commit. */
  environmentsSync: "github.environments_sync",
} as const;
