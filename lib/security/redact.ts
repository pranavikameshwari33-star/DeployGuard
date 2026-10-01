/**
 * Stage 1: the ONE redaction module for everything DeployGuard ingests from
 * GitHub (CI log output, commit messages, failure job/step names, delivery
 * errors). All of it is untrusted and may contain credentials.
 *
 * Applied BEFORE any of: storing in PostgreSQL, retaining to Hindsight,
 * building a Gemini evidence bundle, rendering on the dashboard. The raw text
 * is never stored; only the redacted text plus a summary of WHAT KIND of thing
 * was removed (counts and categories, never the removed value).
 *
 * Pure: no imports, no I/O, so tests and scripts can load it directly.
 * Idempotent: redacting already-redacted text changes nothing, because the
 * placeholder "[REDACTED:<category>]" matches none of the rules.
 */

export type RedactionCategory =
  | "private_key"
  | "github_token"
  | "aws_access_key"
  | "google_api_key"
  | "slack_token"
  | "stripe_key"
  | "npm_token"
  | "supabase_key"
  | "jwt"
  | "auth_header"
  | "url_credentials"
  | "connection_string"
  | "secret_assignment"
  | "high_entropy";

export type RedactionSummary = { count: number; categories: RedactionCategory[] };
export type RedactionResult = RedactionSummary & { text: string };

export type RedactionOptions = {
  /** Mask long random-looking strings that no specific rule recognised. Default true. */
  highEntropy?: boolean;
  /** Minimum length for the high-entropy rule. Default 32. */
  minEntropyLength?: number;
  /** Minimum Shannon entropy (bits per character) for the high-entropy rule. Default 4.2. */
  minEntropyBits?: number;
  /** Extra project-specific rules, applied after the built-in ones. */
  extraRules?: RedactionRule[];
};

export type RedactionRule = {
  category: RedactionCategory;
  pattern: RegExp; // must be global
  /** Builds the replacement; defaults to the placeholder for the whole match. */
  replace?: (match: string, ...groups: string[]) => string;
};

export const placeholder = (category: RedactionCategory) => `[REDACTED:${category}]`;

/** Key names that mark the value after them as a secret (KEY=value, "key": "value"). */
const SECRET_KEY_NAME =
  "[A-Za-z0-9_.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth[_-]?key|session[_-]?key|signing[_-]?key)[A-Za-z0-9_.-]*";

/** Values that are clearly not secrets: CI placeholders, masks, empty. */
function isHarmlessValue(value: string): boolean {
  const v = value.replace(/^["']|["']$/g, "").trim();
  return (
    v === "" ||
    /^\*+$/.test(v) ||                 // GitHub's own "***" mask
    /^\$\{\{.*\}\}$/.test(v) ||        // ${{ secrets.X }} in workflow text
    /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(v) || // $VAR / ${VAR}
    /^\[REDACTED:[a-z_]+\]$/.test(v) ||
    /^(true|false|null|undefined|none|yes|no)$/i.test(v) ||
    v.length < 4
  );
}

export const BUILT_IN_RULES: RedactionRule[] = [
  // Whole PEM blocks, including a block whose END line was cut off by the tail.
  {
    category: "private_key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  // GitHub: classic/OAuth/user-to-server/server-to-server/refresh tokens and fine-grained PATs.
  { category: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g },
  { category: "aws_access_key", pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g },
  { category: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { category: "slack_token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { category: "slack_token", pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { category: "stripe_key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { category: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { category: "supabase_key", pattern: /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{16,}\b/g },
  { category: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // Authorization headers / bearer and basic credentials. The scheme word is kept.
  {
    category: "auth_header",
    pattern: /\b(Bearer|bearer|BEARER|Basic|BASIC)(\s+)([A-Za-z0-9._~+/=-]{12,})/g,
    // "Basic configuration" is prose, not a credential: require a digit or base64 punctuation.
    replace: (match, scheme, space, credential) =>
      /[\d+/=]/.test(credential) ? `${scheme}${space}${placeholder("auth_header")}` : match,
  },
  // Database / broker connection strings: the whole thing after the scheme.
  {
    category: "connection_string",
    pattern: /\b(postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|mssql|sqlserver):\/\/[^\s"'`<>]+/gi,
    replace: (_m, scheme) => `${scheme}://${placeholder("connection_string")}`,
  },
  // Any other URL with user:password@ in it: keep scheme and host, drop the credentials.
  {
    category: "url_credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/"'`<>]+:[^\s@/"'`<>]+@/gi,
    replace: (_m, scheme) => `${scheme}${placeholder("url_credentials")}@`,
  },
  // KEY=value, KEY: value (env/YAML style, key name must look secret), "key": "value" (JSON).
  {
    category: "secret_assignment",
    pattern: new RegExp(
      `((?:^|[\\s,;{(]|export\\s+)["']?${SECRET_KEY_NAME}["']?\\s*(?:=|:)\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s,;}"'\\n]+)`,
      "gim"
    ),
    replace: (match, prefix, value) => {
      if (isHarmlessValue(value)) return match;
      // "token: }" in a JS syntax error, "password: required" in a form error:
      // after ":" only mask values that look like a credential (no spaces, has a digit or is long).
      if (/:\s*$/.test(prefix) && !/=\s*$/.test(prefix)) {
        const bare = value.replace(/^["']|["']$/g, "");
        if (!(bare.length >= 12 || (/\d/.test(bare) && bare.length >= 8))) return match;
      }
      const quote = /^["']/.test(value) ? value[0] : "";
      return `${prefix}${quote}${placeholder("secret_assignment")}${quote}`;
    },
  },
];

/** Shannon entropy in bits per character. */
export function shannonEntropy(text: string): number {
  if (!text) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Is this token a random-looking secret? Deliberately conservative so ordinary
 * text survives: commit SHAs and sha256 digests are pure hex (excluded), UUIDs
 * are hex with dashes (excluded), file paths and identifiers rarely mix upper,
 * lower and several digits at high entropy.
 */
function looksRandom(token: string, minLength: number, minBits: number): boolean {
  if (token.length < minLength) return false;
  if (/^[0-9a-f-]+$/i.test(token)) return false; // hex digests, SHAs, UUIDs
  if (token.includes("/") && /^[\w./-]+\.[a-z0-9]{1,6}$/i.test(token)) return false; // file paths
  if (token.startsWith("[REDACTED:")) return false;
  const digits = (token.match(/\d/g) ?? []).length;
  if (!/[a-z]/.test(token) || !/[A-Z]/.test(token) || digits < 2) return false;
  return shannonEntropy(token) >= minBits;
}

export function redact(input: string | null | undefined, options: RedactionOptions = {}): RedactionResult {
  if (!input) return { text: input ?? "", count: 0, categories: [] };
  let text = input;
  let count = 0;
  const categories = new Set<RedactionCategory>();

  for (const rule of [...BUILT_IN_RULES, ...(options.extraRules ?? [])]) {
    text = text.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      const groups = rest.slice(0, -2).map((g) => (typeof g === "string" ? g : ""));
      const replaced = rule.replace ? rule.replace(match, ...groups) : placeholder(rule.category);
      if (replaced !== match) {
        count++;
        categories.add(rule.category);
      }
      return replaced;
    });
  }

  if (options.highEntropy !== false) {
    const minLength = options.minEntropyLength ?? 32;
    const minBits = options.minEntropyBits ?? 4.2;
    text = text.replace(/[A-Za-z0-9+/_=-]{16,}/g, (token) => {
      if (!looksRandom(token, minLength, minBits)) return token;
      count++;
      categories.add("high_entropy");
      return placeholder("high_entropy");
    });
  }

  return { text, count, categories: [...categories].sort() };
}

/** The redacted text only. */
export function redactText(input: string | null | undefined, options?: RedactionOptions): string {
  return redact(input, options).text;
}

/** Same as redactText, but keeps null as null (for nullable database columns). */
export function redactNullable(input: string | null | undefined, options?: RedactionOptions): string | null {
  return input == null ? null : redact(input, options).text;
}

/** Merges summaries, e.g. for several fields of one record. */
export function mergeSummaries(...summaries: RedactionSummary[]): RedactionSummary {
  const categories = new Set<RedactionCategory>();
  let count = 0;
  for (const s of summaries) {
    count += s.count;
    s.categories.forEach((c) => categories.add(c));
  }
  return { count, categories: [...categories].sort() };
}

/**
 * Redacts every string inside a JSON-like value (objects, arrays). Keys are
 * kept. Used as the last line of defence on bundles and memory items.
 */
export function redactDeep<T>(value: T, options?: RedactionOptions): { value: T; summary: RedactionSummary } {
  let count = 0;
  const categories = new Set<RedactionCategory>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redact(v, options);
      count += r.count;
      r.categories.forEach((c) => categories.add(c));
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  const out = walk(value) as T;
  return { value: out, summary: { count, categories: [...categories].sort() } };
}

// ---------------------------------------------------------------------------
// Size limits for failure output (the 40-line tail is unchanged from Phase 9)
// ---------------------------------------------------------------------------

export const FAILURE_OUTPUT_LIMITS = { maxLines: 40, maxLineLength: 500, maxTotal: 4000 };

/**
 * Keeps the END of the output (where a failing command reports its error):
 * the last `maxLines` non-empty lines, each cut to `maxLineLength`, the whole
 * cut to `maxTotal` characters. ANSI colour codes and control characters are
 * removed.
 */
export function tailOutput(text: string, limits = FAILURE_OUTPUT_LIMITS): string {
  const lines = text
    .replace(/\r/g, "")
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-limits.maxLines)
    .map((line) => (line.length > limits.maxLineLength ? `${line.slice(0, limits.maxLineLength)} ...` : line));
  const joined = lines.join("\n");
  return joined.length > limits.maxTotal ? joined.slice(-limits.maxTotal) : joined;
}

/**
 * Failure output as it may be stored: redacted FIRST (so a secret cut in half by
 * the size limit is still recognised whole), then tailed, then redacted again
 * (cheap, catches anything the cut exposed, e.g. a PEM block's tail).
 */
export function prepareFailureOutput(text: string | null | undefined): RedactionResult {
  if (!text) return { text: "", count: 0, categories: [] };
  const first = redact(text);
  const second = redact(tailOutput(first.text));
  return { text: second.text, ...mergeSummaries(first, second) };
}
