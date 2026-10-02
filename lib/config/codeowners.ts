/**
 * Stage 5.3: CODEOWNERS, read as data.
 *
 * GitHub semantics: each line is `<pattern> <owner> <owner> ...`; the LAST
 * matching line wins; a matching line with no owners means "no owner". Only
 * @user and @org/team owners are kept. Email owners are dropped (and counted)
 * so personal addresses are never stored or shown.
 *
 * Pure apart from the glob helper -- unit-tested directly.
 */
import { matchesGlob } from "../analysis/glob.ts";

/** GitHub looks for the file in these places, in this order. */
export const CODEOWNERS_PATHS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];
const MAX_RULES = 500;
const OWNER = /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9_.-]{1,100})?$/;

export type CodeownersRule = { pattern: string; owners: string[] };

export function parseCodeowners(text: string): { rules: CodeownersRule[]; emailsDropped: number; invalidLines: number } {
  const rules: CodeownersRule[] = [];
  let emailsDropped = 0;
  let invalidLines = 0;
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    // GitLab-style sections and negations are not GitHub syntax.
    if (line.startsWith("[") || line.startsWith("^") || line.startsWith("!")) {
      invalidLines++;
      continue;
    }
    const [pattern, ...tokens] = line.split(/\s+/);
    if (pattern.length > 300) {
      invalidLines++;
      continue;
    }
    const owners: string[] = [];
    for (const t of tokens) {
      if (OWNER.test(t)) owners.push(t);
      else if (t.includes("@")) emailsDropped++;
    }
    rules.push({ pattern, owners });
    if (rules.length >= MAX_RULES) break;
  }
  return { rules, emailsDropped, invalidLines };
}

/** The owners of one path (last matching rule wins); null when no rule matches. */
export function ownersOf(path: string, rules: CodeownersRule[]): string[] | null {
  for (let i = rules.length - 1; i >= 0; i--) {
    if (matchesGlob(path, rules[i].pattern)) return rules[i].owners;
  }
  return null;
}

/** Owners of a set of changed files, with how many of the files each owns, plus files nobody owns. */
export function ownersOfFiles(paths: string[], rules: CodeownersRule[]): { owners: { owner: string; files: number }[]; unowned: number } {
  const counts = new Map<string, number>();
  let unowned = 0;
  for (const p of paths) {
    const owners = ownersOf(p, rules);
    if (!owners || owners.length === 0) {
      unowned++;
      continue;
    }
    for (const o of owners) counts.set(o, (counts.get(o) ?? 0) + 1);
  }
  return {
    owners: [...counts.entries()].map(([owner, files]) => ({ owner, files })).sort((a, b) => b.files - a.files || a.owner.localeCompare(b.owner)),
    unowned,
  };
}
