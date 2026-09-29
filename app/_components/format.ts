/**
 * Small, pure display helpers for the dashboard. Formatting only: nothing here
 * adds or infers information.
 */

export type Tone = "green" | "red" | "amber" | "blue" | "gray";

export function statusTone(status: string): Tone {
  switch (status) {
    case "SUCCESS": return "green";
    case "FAILED": return "red";
    case "BUILDING": return "blue";
    case "ROLLED_BACK": return "amber";
    default: return "gray";
  }
}

export function riskTone(level: string): Tone {
  return level === "HIGH" ? "red" : level === "MEDIUM" ? "amber" : "green";
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

const ABSOLUTE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

export function absoluteTime(iso: string | Date): string {
  return ABSOLUTE.format(new Date(iso));
}

export function relativeTime(iso: string | Date, now = Date.now()): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return absoluteTime(iso);
}

const CATEGORY_LABELS: Record<string, string> = {
  application_code: "Application code",
  database: "Database",
  configuration: "Configuration",
  authentication: "Authentication",
  payments: "Payments",
  api: "API",
  infrastructure: "Infrastructure",
  ci_cd: "CI/CD",
  tests: "Tests",
  documentation: "Documentation",
  dependencies: "Dependencies",
  unknown: "Unknown",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

const SIGNAL_LABELS: Record<string, string> = {
  shared_file: "Shared file",
  same_service: "Same component",
  same_service_category: "Same component and category",
  same_category: "Same category",
  similar_commit_message: "Similar commit message",
  same_failure_type: "Same failure type",
  recalled_by_hindsight: "Recalled from memory",
};

/** "shared_file: config/database.yaml (+4)" -> "Shared file: config/database.yaml" */
export function signalLabel(signal: string): string {
  const match = /^([a-z_]+): (.*?)(?: \(\+[\d.]+\))?$/.exec(signal);
  if (!match) return signal;
  const [, name, value] = match;
  const label = SIGNAL_LABELS[name] ?? name;
  if (name === "recalled_by_hindsight") return label;
  if (name === "same_service_category") return `${label}: ${value.replace("@", " in ")}`;
  return `${label}: ${name === "same_category" ? categoryLabel(value) : value}`;
}

const GROUP_LABELS: Record<string, [string, string]> = {
  shared_file: ["Shared file", "Shared files"],
  same_service: ["Same component", "Same components"],
  same_service_category: ["Same component and category", "Same components and categories"],
  same_category: ["Same category", "Same categories"],
};

/**
 * Groups raw signals by type for compact display:
 *   ["shared_file: a (+4)", "shared_file: b (+4)", "same_category: database (+2)"]
 *   -> ["Shared files: a, b", "Same category: Database"]
 * Every signal is still shown; only repeated labels are merged.
 */
export function groupedSignals(signals: string[]): string[] {
  const groups = new Map<string, string[]>();
  const singles: string[] = [];
  for (const signal of signals) {
    const match = /^([a-z_]+): (.*?)(?: \(\+[\d.]+\))?$/.exec(signal);
    if (!match || !GROUP_LABELS[match[1]]) {
      singles.push(signalLabel(signal));
      continue;
    }
    const [, name, value] = match;
    const shown =
      name === "same_category" ? categoryLabel(value)
      : name === "same_service_category" ? value.split("@").map((v, i) => (i === 0 ? categoryLabel(v) : v)).join(" in ")
      : value;
    groups.set(name, [...(groups.get(name) ?? []), shown]);
  }
  const lines = [...groups].map(([name, values]) => {
    const [one, many] = GROUP_LABELS[name];
    return `${values.length > 1 ? many : one}: ${values.join(", ")}`;
  });
  return [...lines, ...singles];
}

const BASIS_LABELS: Record<string, string> = {
  historical_evidence: "History",
  current_change: "This change",
  pipeline: "Pipeline",
  inference: "Inference",
};

export function basisLabel(basis: string): string {
  return BASIS_LABELS[basis] ?? basis;
}

/** The last meaningful line of a failure log: where a failing command reports its error. */
export function lastLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && l !== "...");
  return lines.length ? lines[lines.length - 1] : null;
}

export const NOT_DETERMINED = "Not determined";
