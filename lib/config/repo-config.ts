/**
 * Stage 5.2: the per-repository config file, `.deployguard.yml`.
 *
 * DeployGuard reads this file as DATA and never executes anything from it.
 * Rather than a general YAML library (anchors, tags, custom types, and a
 * large attack surface), it accepts one small, documented subset and rejects
 * everything else with a line-numbered error. An invalid file is not used at
 * all: the defaults apply and the errors are shown to the repository owner.
 *
 *   version: 1
 *   pull_request_checks: true          # false = no PR check runs for this repository
 *   ignore:                            # paths left out of the analysis
 *     - "docs/**"
 *   critical_paths:                    # paths that are flagged when touched
 *     - "src/payments/**"
 *   services:                          # path -> service/component name
 *     "services/legacy-billing/**": billing
 *   categories:                        # path -> extra categories
 *     "db/schema/**": [database, migration]
 *
 * Pure apart from the category list (relative import) -- unit-tested directly.
 */
import { CHANGE_CATEGORIES, type AnalysisConfig, type ChangeCategory } from "../analysis/change-analysis.ts";

export const CONFIG_PATH = ".deployguard.yml";
export const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_LINES = 1000;
const MAX_ITEMS = 200;
const MAX_PATTERN = 200;

export type RepoConfig = AnalysisConfig & { version: 1; pull_request_checks: boolean };

export const DEFAULT_CONFIG: RepoConfig = {
  version: 1,
  pull_request_checks: true,
  ignore: [],
  critical: [],
  services: [],
  categories: [],
};

export type ConfigResult = { ok: true; config: RepoConfig } | { ok: false; errors: string[] };

type Scalar = string | number | boolean;
type Node = { line: number; value: Scalar | Scalar[] | Map<string, { line: number; value: Scalar | Scalar[] }> | ListNode };
type ListNode = { list: { line: number; value: Scalar }[] };

const ALLOWED_CATEGORIES = new Set<string>(CHANGE_CATEGORIES.filter((c) => c !== "unknown"));
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
// Globs: path characters plus * ? / and no "..", no absolute Windows paths, no control characters.
const PATTERN_OK = /^[A-Za-z0-9_.\-*?/@+~ ]+$/;

/** Parses and validates the file text. Never throws. */
export function parseRepoConfig(text: string): ConfigResult {
  const errors: string[] = [];
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) return { ok: false, errors: [`The file is larger than ${MAX_CONFIG_BYTES / 1024} KB.`] };
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines.length > MAX_LINES) return { ok: false, errors: [`The file has more than ${MAX_LINES} lines.`] };

  // ---- 1. parse the subset ---------------------------------------------------
  const top = new Map<string, Node>();
  let current: { key: string; line: number; kind: "unknown" | "list" | "map" } | null = null;

  lines.forEach((raw, index) => {
    const n = index + 1;
    if (/\t/.test(raw.match(/^\s*/)?.[0] ?? "")) {
      errors.push(`line ${n}: indent with spaces, not tabs.`);
      return;
    }
    const line = stripComment(raw).replace(/\s+$/, "");
    if (line.trim() === "") return;
    if (line.trim() === "---" && top.size === 0) return;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    if (indent === 0) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*):(?:\s+(.*))?$/.exec(body);
      if (!m) {
        errors.push(`line ${n}: expected "key: value" at the top level.`);
        current = null;
        return;
      }
      const [, key, rest] = m;
      if (top.has(key)) errors.push(`line ${n}: "${key}" appears twice.`);
      if (rest === undefined || rest === "") {
        current = { key, line: n, kind: "unknown" };
        top.set(key, { line: n, value: { list: [] } });
      } else {
        current = null;
        const v = parseValue(rest, n, errors);
        if (v !== undefined) top.set(key, { line: n, value: v });
      }
      return;
    }

    if (!current || indent !== 2) {
      errors.push(`line ${n}: unexpected indentation (use exactly two spaces under a top-level key).`);
      return;
    }
    const listItem = /^-\s+(.*)$/.exec(body);
    if (listItem) {
      if (current.kind === "map") {
        errors.push(`line ${n}: "${current.key}" mixes list items and key: value entries.`);
        return;
      }
      current.kind = "list";
      const v = parseScalar(listItem[1], n, errors);
      if (v !== undefined) (top.get(current.key)!.value as ListNode).list.push({ line: n, value: v });
      return;
    }
    const entry = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^:\s][^:]*?):\s+(.*)$/.exec(body);
    if (entry) {
      if (current.kind === "list") {
        errors.push(`line ${n}: "${current.key}" mixes list items and key: value entries.`);
        return;
      }
      if (current.kind === "unknown") {
        current.kind = "map";
        top.set(current.key, { line: current.line, value: new Map() });
      }
      const key = parseScalar(entry[1], n, errors);
      const value = parseValue(entry[2], n, errors);
      if (typeof key !== "string") {
        if (key !== undefined) errors.push(`line ${n}: map keys must be text.`);
        return;
      }
      const map = top.get(current.key)!.value as Map<string, { line: number; value: Scalar | Scalar[] }>;
      if (map.has(key)) errors.push(`line ${n}: "${key}" appears twice under "${current.key}".`);
      if (value !== undefined) map.set(key, { line: n, value });
      return;
    }
    errors.push(`line ${n}: expected "- item" or "key: value".`);
  });
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };

  // ---- 2. validate the shape -------------------------------------------------
  const config: RepoConfig = { ...DEFAULT_CONFIG, ignore: [], critical: [], services: [], categories: [] };
  const known = new Set(["version", "pull_request_checks", "ignore", "critical_paths", "services", "categories"]);
  for (const [key, node] of top) {
    if (!known.has(key)) errors.push(`line ${node.line}: unknown setting "${key}".`);
  }

  const version = top.get("version");
  if (!version) errors.push(`"version: 1" is required.`);
  else if (version.value !== 1) errors.push(`line ${version.line}: only "version: 1" is supported.`);

  const prChecks = top.get("pull_request_checks");
  if (prChecks) {
    if (typeof prChecks.value !== "boolean") errors.push(`line ${prChecks.line}: pull_request_checks must be true or false.`);
    else config.pull_request_checks = prChecks.value;
  }

  config.ignore = patternList(top.get("ignore"), "ignore", errors);
  config.critical = patternList(top.get("critical_paths"), "critical_paths", errors);

  const services = top.get("services");
  if (services) {
    const map = asMap(services, "services", errors);
    for (const [pattern, entry] of map) {
      if (!validPattern(pattern)) errors.push(`line ${entry.line}: "${pattern.slice(0, 60)}" is not a valid path pattern.`);
      else if (typeof entry.value !== "string" || !SERVICE_NAME.test(entry.value)) {
        errors.push(`line ${entry.line}: the service name must be 1-64 letters, digits, ".", "_" or "-".`);
      } else config.services.push({ pattern, service: entry.value });
    }
  }

  const categories = top.get("categories");
  if (categories) {
    const map = asMap(categories, "categories", errors);
    for (const [pattern, entry] of map) {
      const list = Array.isArray(entry.value) ? entry.value : [entry.value];
      if (!validPattern(pattern)) {
        errors.push(`line ${entry.line}: "${pattern.slice(0, 60)}" is not a valid path pattern.`);
        continue;
      }
      const bad = list.filter((c) => typeof c !== "string" || !ALLOWED_CATEGORIES.has(c));
      if (bad.length || list.length === 0) {
        errors.push(`line ${entry.line}: categories must be from: ${[...ALLOWED_CATEGORIES].join(", ")}.`);
        continue;
      }
      config.categories.push({ pattern, categories: [...new Set(list as ChangeCategory[])] });
    }
  }

  for (const [name, count] of [["services", config.services.length], ["categories", config.categories.length]] as const) {
    if (count > MAX_ITEMS) errors.push(`"${name}" has more than ${MAX_ITEMS} entries.`);
  }
  if (errors.length) return { ok: false, errors: errors.slice(0, 20) };
  return { ok: true, config };
}

/** The analysis part of a stored config (or none). */
export function analysisConfigOf(config: RepoConfig | null | undefined): AnalysisConfig | undefined {
  if (!config) return undefined;
  return { ignore: config.ignore, critical: config.critical, services: config.services, categories: config.categories };
}

// ---------------------------------------------------------------------------

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/** A scalar or a flow list "[a, b]". Anything that could be a YAML feature beyond the subset is refused. */
function parseValue(text: string, line: number, errors: string[]): Scalar | Scalar[] | undefined {
  const t = text.trim();
  if (t.startsWith("[")) {
    if (!t.endsWith("]")) {
      errors.push(`line ${line}: a list in [ ] must close on the same line.`);
      return undefined;
    }
    const inner = t.slice(1, -1).trim();
    if (inner === "") return [];
    const items: Scalar[] = [];
    for (const part of splitFlow(inner)) {
      const v = parseScalar(part, line, errors);
      if (v === undefined) return undefined;
      items.push(v);
    }
    if (items.length > MAX_ITEMS) {
      errors.push(`line ${line}: more than ${MAX_ITEMS} items.`);
      return undefined;
    }
    return items;
  }
  return parseScalar(t, line, errors);
}

function splitFlow(text: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ",") {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim());
}

function parseScalar(text: string, line: number, errors: string[]): Scalar | undefined {
  const t = text.trim();
  if (t === "") {
    errors.push(`line ${line}: empty value.`);
    return undefined;
  }
  if (t.startsWith('"')) {
    if (!/^"(?:[^"\\]|\\["\\/])*"$/.test(t)) {
      errors.push(`line ${line}: unterminated or unsupported "quoted" text (only \\" \\\\ \\/ escapes).`);
      return undefined;
    }
    return t.slice(1, -1).replace(/\\(["\\/])/g, "$1");
  }
  if (t.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(t)) {
      errors.push(`line ${line}: unterminated 'quoted' text.`);
      return undefined;
    }
    return t.slice(1, -1).replace(/''/g, "'");
  }
  // YAML features outside the subset: anchors, aliases, tags, block scalars, flow maps, directives.
  if (/^[&*!|>{%@`]/.test(t) || t.includes(": ") || t.startsWith("- ")) {
    errors.push(`line ${line}: "${t.slice(0, 40)}" uses YAML syntax that DeployGuard does not accept; quote the text.`);
    return undefined;
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^\d{1,6}$/.test(t)) return Number(t);
  return t;
}

function patternList(node: Node | undefined, name: string, errors: string[]): string[] {
  if (!node) return [];
  let items: { line: number; value: Scalar }[];
  if (Array.isArray(node.value)) items = node.value.map((value) => ({ line: node.line, value }));
  else if (typeof node.value === "object" && node.value !== null && "list" in node.value) items = node.value.list;
  else {
    errors.push(`line ${node.line}: "${name}" must be a list.`);
    return [];
  }
  if (items.length > MAX_ITEMS) errors.push(`"${name}" has more than ${MAX_ITEMS} entries.`);
  const out: string[] = [];
  for (const item of items) {
    if (typeof item.value !== "string" || !validPattern(item.value)) {
      errors.push(`line ${item.line}: "${String(item.value).slice(0, 60)}" in "${name}" is not a valid path pattern.`);
    } else out.push(item.value);
  }
  return out;
}

function asMap(node: Node, name: string, errors: string[]): Map<string, { line: number; value: Scalar | Scalar[] }> {
  if (node.value instanceof Map) return node.value;
  if (typeof node.value === "object" && node.value !== null && "list" in node.value && node.value.list.length === 0) return new Map();
  errors.push(`line ${node.line}: "${name}" must be "path: value" entries.`);
  return new Map();
}

function validPattern(p: string): boolean {
  return p.length > 0 && p.length <= MAX_PATTERN && PATTERN_OK.test(p) && !p.split("/").includes("..");
}
