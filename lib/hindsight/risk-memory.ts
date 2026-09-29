import type { StoredRiskAssessment } from "@/lib/db/risk-assessments";
import type { MemoryItem } from "@/lib/hindsight/client";
import { repositoryScopeTags } from "@/lib/hindsight/deployment-memory";

/**
 * Phase 7: a risk assessment as a Hindsight memory.
 *
 * Kept SEPARATE from the deployment memory (deployment-memory.ts) and the
 * incident memory (incident-memory.ts), which are left untouched. Its own
 * document_id means a regenerated assessment replaces the previous risk memory
 * for the deployment; the full history stays in the risk_assessments table.
 *
 * The content has two clearly headed parts:
 *   OBSERVED FACTS -- copied from DeployGuard's database records.
 *   AI ANALYSIS    -- Gemini's assessment, labelled as model output, not fact.
 */
export function buildRiskMemory(a: StoredRiskAssessment, githubRepositoryId: string | null = null): MemoryItem {
  const current = a.evidence.current_deployment;
  const repo = current.repository;
  const shortSha = current.commit_sha.slice(0, 7);

  const facts = [
    `OBSERVED FACTS (from DeployGuard's database):`,
    `Deployment #${current.deployment_id} of ${repo} on branch ${current.branch}, commit ${shortSha}: ${current.commit_message || "(empty)"}.`,
    `Change categories: ${a.evidence.change_analysis.change_categories.join(", ") || "none"}.`,
    `Affected services/components: ${a.evidence.change_analysis.affected_services.join(", ") || "none determined"}.`,
    `Pipeline status when assessed: ${a.evidence.current_pipeline.status}.`,
    a.historical_evidence.length
      ? `Historical deployments cited: ${a.historical_evidence
          .map((h) => `#${h.deployment_id} (${h.outcome}${h.observed_failure ? `, observed failure: ${firstLine(h.observed_failure)}` : ""})`)
          .join("; ")}.`
      : a.historical_evidence_available
        ? "Similar historical deployments existed but none were cited."
        : "No sufficiently similar historical deployments were found.",
  ];

  const analysis = [
    `AI ANALYSIS (Gemini model ${a.model}; model output, not verified fact):`,
    `Risk assessment for deployment #${current.deployment_id}: ${a.risk_level} (model-reported confidence ${a.risk_confidence}).`,
    `Summary: ${a.risk_summary}`,
    ...a.risk_reasons.map((r) => `Reason (${r.basis}): ${r.reason}`),
    `Recommended checks: ${a.recommended_checks.join("; ")}.`,
    `Assessed at ${a.risk_generated_at.toISOString()}.`,
  ];

  return {
    content: [...facts, "", ...analysis].join("\n"),
    timestamp: a.risk_generated_at.toISOString(),
    context: `DeployGuard AI risk assessment for ${repo}`,
    document_id: `risk/${current.deployment_id}`,
    update_mode: "replace",
    tags: [
      "risk-assessment",
      ...repositoryScopeTags({ github_repository_id: githubRepositoryId }),
      `risk:${a.risk_level}`,
      `deployment:${current.deployment_id}`,
      `repo:${repo}`,
      `branch:${current.branch}`,
      `commit:${shortSha}`,
    ],
    metadata: {
      kind: "risk_assessment",
      source: "ai_analysis",
      ...(githubRepositoryId ? { github_repository_id: githubRepositoryId } : {}),
      deployment_id: current.deployment_id,
      risk_assessment_id: a.id,
      risk_level: a.risk_level,
      model: a.model,
      repository_full_name: repo,
      commit_sha: current.commit_sha,
      cited_deployment_ids: a.historical_evidence.map((h) => h.deployment_id).join(","),
    },
  };
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() && !l.startsWith("...")) ?? text;
  return line.trim().slice(0, 200);
}
