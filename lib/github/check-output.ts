/**
 * Stage 5.1: the text of the advisory pull request check run.
 *
 * GitHub renders check-run output as Markdown, so every value that came from a
 * repository or a model is redacted, flattened to one line, HTML-escaped and
 * Markdown-escaped before it is placed in the text. Links are only ever built
 * by DeployGuard itself (dashboard URLs from numeric ids).
 *
 * Pure apart from the redaction module (relative import) -- unit-tested directly.
 */
import { redactText } from "../security/redact.ts";

export const CHECK_NAME = "DeployGuard risk (advisory)";
const MAX_TEXT = 20_000;

export type CheckInput = {
  prNumber: number;
  level: "LOW" | "MEDIUM" | "HIGH" | null;
  /** Why there is no level (risk analysis unavailable / not run). */
  unavailable: string | null;
  confidence: number | null;
  summary: string | null;
  reasons: { reason: string; basis: string }[];
  cited: { deployment_id: string; outcome: string; relevance_note: string }[];
  /** The similar history the analysis saw (shown when there is no assessment). */
  matches: { deployment_id: string; status: string; commit_message: string; environments?: string[] }[];
  categories: string[];
  criticalFiles: string[];
  ignoredFiles: number;
  owners: { owner: string; files: number }[];
  configStatus: string;
  filesAnalysed: number;
  filesTruncated: boolean;
  /** https origin of the DeployGuard dashboard, or null (then ids are not linked). */
  dashboardBase: string | null;
  githubRepositoryId: string;
};

/** One line of untrusted text, safe to place in GitHub Markdown. */
export function escapeMarkdown(value: string | null | undefined, max = 300): string {
  const text = redactText(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_{}[\]()#+\-.!|~:@])/g, "\\$1");
}

function deploymentRef(input: CheckInput, id: string): string {
  if (!/^\d{1,19}$/.test(id)) return "";
  if (!input.dashboardBase) return `deployment ${id}`;
  const url = `${input.dashboardBase}/?repo=${encodeURIComponent(input.githubRepositoryId)}&id=${encodeURIComponent(id)}`;
  return `[deployment ${id}](${url})`;
}

export function renderCheck(input: CheckInput): { title: string; summary: string; text: string } {
  const title = input.level
    ? `Advisory risk: ${input.level} (never blocks merging)`
    : `Risk analysis unavailable (advisory, never blocks merging)`;

  const summary = [
    input.level
      ? `**Risk: ${input.level}**${input.confidence !== null ? ` · model confidence ${input.confidence.toFixed(2)} (self-reported, not calibrated)` : ""}`
      : `**Risk analysis unavailable:** ${escapeMarkdown(input.unavailable ?? "no validated assessment")}. No risk level is shown rather than a guess.`,
    "",
    input.summary ? escapeMarkdown(input.summary, 1500) : "",
    "",
    "This check is advisory. Its conclusion is always *neutral*: it never fails, never blocks merging and changes nothing in the repository.",
  ].join("\n");

  const lines: string[] = [];
  if (input.reasons.length) {
    lines.push("### Why", ...input.reasons.map((r) => `- ${escapeMarkdown(r.reason, 800)} *(${escapeMarkdown(r.basis, 40)})*`), "");
  }
  if (input.cited.length) {
    lines.push(
      "### Historical deployments used",
      ...input.cited.map((c) => `- ${deploymentRef(input, c.deployment_id)}: ${escapeMarkdown(c.outcome, 20)} -- ${escapeMarkdown(c.relevance_note, 300)}`),
      ""
    );
  } else if (input.matches.length) {
    lines.push(
      "### Similar past deployments (database records)",
      ...input.matches.slice(0, 10).map(
        (m) =>
          `- ${deploymentRef(input, m.deployment_id)}: ${escapeMarkdown(m.status, 20)} -- ${escapeMarkdown(m.commit_message, 120)}` +
          (m.environments?.length ? ` (${escapeMarkdown(m.environments.join(", "), 120)})` : "")
      ),
      ""
    );
  } else {
    lines.push("### History", "- No similar past deployment is recorded for this repository.", "");
  }
  lines.push("### What changed");
  lines.push(`- ${input.filesAnalysed} file(s) analysed${input.filesTruncated ? " (the pull request has more; only the first ones were analysed)" : ""}${input.ignoredFiles ? `, ${input.ignoredFiles} ignored by .deployguard.yml` : ""}.`);
  lines.push(`- Categories: ${input.categories.length ? input.categories.map((c) => escapeMarkdown(c, 40)).join(", ") : "none"}.`);
  if (input.criticalFiles.length) {
    lines.push(`- Critical paths touched: ${input.criticalFiles.slice(0, 20).map((f) => escapeMarkdown(f, 200)).join(", ")}.`);
  }
  if (input.owners.length) {
    lines.push(`- Code owners of the changed files: ${input.owners.slice(0, 15).map((o) => `${escapeMarkdown(o.owner, 140)} (${o.files})`).join(", ")}.`);
  }
  lines.push(`- Repository config (.deployguard.yml): ${escapeMarkdown(input.configStatus, 40)}.`);
  lines.push("", `Root causes are stated only when a person confirmed them in DeployGuard. Similarity is a rule-based ranking, not a probability.`);

  let text = lines.join("\n");
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n\n(truncated)`;
  return { title, summary, text };
}
