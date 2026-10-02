/**
 * Stage 4.3: a normalised error signature, so the same failure with different
 * details (addresses, ports, ids, timings, file paths) groups together:
 *
 *   "Error: connect ETIMEDOUT 10.0.0.7:5432"  -> "error: connect etimedout <ip>"
 *   "Error: connect ETIMEDOUT 10.0.0.9:6543"  -> "error: connect etimedout <ip>"
 *
 * It describes WHAT was printed, never WHY. Pure: no imports, no I/O.
 */

const ERROR_LINE =
  /(error|exception|fail|timeout|timed out|refused|denied|cannot|could not|unable to|panic|fatal|segfault|oom|killed|etimedout|econn|enotfound|exit code)/i;

const MAX_SIGNATURE = 160;

/** The signature of a failure output, or null when there is no output. */
export function errorSignature(output: string | null | undefined): string | null {
  if (!output) return null;
  const lines = output
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\.\.\.\s*$/.test(l));
  if (lines.length === 0) return null;
  const line = [...lines].reverse().find((l) => ERROR_LINE.test(l)) ?? lines[lines.length - 1];
  const normalised = normaliseLine(line);
  return normalised || null;
}

export function normaliseLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/^\.\.\.\s*/, "")
    // leading timestamps / log prefixes
    .replace(/^\[?\d{4}-\d{2}-\d{2}[t ][\d:.]+z?\]?\s*/, "")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/g, "<url>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ip>")
    .replace(/\[[0-9a-f:]+\](?::\d+)?/g, "<ip>")
    .replace(/(?:[a-z]:)?(?:[\\/][\w.@-]+){2,}/g, "<path>")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<str>")
    // hex ids (at least one digit, so words like "defaced" survive)
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/g, "<hex>")
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h|kb|mb|gb)?\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SIGNATURE);
}
