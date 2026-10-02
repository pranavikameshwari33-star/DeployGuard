/** Stage 2: the job types (kept apart from the handlers so enqueuers do not import them). */
export const JOB_TYPES = {
  workflowRun: "webhook.workflow_run",
  deploymentMemory: "memory.deployment",
  incidentMemory: "memory.incident",
  riskAnalyze: "risk.analyze",
  installationReconcile: "installation.reconcile",
  /** Stage 4.1: one bounded re-evaluation after a confirmed cause changed. */
  learningReevaluate: "learning.reevaluate",
} as const;
