import { recall } from "@/lib/hindsight/client";
import { checkRateLimit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { redactText } from "@/lib/security/redact";
import type { Deployment } from "@/lib/db/deployments";

/**
 * Stage 3: what Hindsight recalls about a deployment, for PEOPLE to read.
 *
 * Only on an explicit "Show recalled memory" request -- never on a normal page
 * load. Scoped to the deployment's own repository (ghrepo: tag, any_strict,
 * re-checked by the client). The text is Hindsight's paraphrase: it is shown
 * labelled RECALLED MEMORY, is never sent to Gemini, and is not evidence.
 */
export type RecalledMemory =
  | { state: "ok"; memories: { text: string; deploymentId: string | null; kind: string | null }[] }
  | { state: "unavailable"; reason: string };

export async function recallForDeployment(d: Deployment, actorKey: string): Promise<RecalledMemory> {
  if (!d.github_repository_id) return { state: "unavailable", reason: "This deployment has no repository scope for memory recall." };
  const limited = await checkRateLimit("memoryRecall", actorKey, RATE_LIMITS.memoryRecall);
  if (!limited.allowed) return { state: "unavailable", reason: "Too many memory requests; try again later." };

  const query = [
    `${d.owner}/${d.repository} deployments similar to:`,
    d.commit_message.split("\n")[0].slice(0, 200),
    (d.change_categories ?? []).join(", "),
    (d.affected_services ?? []).join(", "),
  ].join(" ");
  try {
    const { results } = await recall(query, { githubRepositoryIds: [d.github_repository_id], maxTokens: 1500 });
    return {
      state: "ok",
      memories: results.slice(0, 8).map((m) => ({
        text: redactText(m.text),
        deploymentId: m.metadata?.deployment_id ?? null,
        kind: m.metadata?.kind ?? null,
      })),
    };
  } catch (error) {
    console.error(`[DeployGuard][memory] Recall for deployment #${d.id} failed: ${(error as Error).message}`);
    return { state: "unavailable", reason: "Memory recall is unavailable right now." };
  }
}
