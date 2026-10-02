/**
 * Stage 4.5: recognising a revert commit from its message.
 *
 * GitHub's "Revert" button and `git revert` both write:
 *
 *   Revert "<title of the reverted commit>"
 *
 *   This reverts commit <full sha>.
 *
 * Either part is enough: the SHA is exact; the title alone is matched only
 * against the first line of an earlier deployment's commit message. Pure.
 */

export type RevertReference = {
  /** Lower-case SHA or SHA prefix (7-40 hex) named in the message, if any. */
  sha: string | null;
  /** The quoted title after `Revert "`, if any. */
  title: string | null;
};

export function parseRevert(message: string): RevertReference | null {
  const text = message ?? "";
  const shaMatch = /\bThis reverts commit ([0-9a-f]{7,40})\b/i.exec(text);
  const titleMatch = /^\s*Revert\s+"(.+)"\s*$/m.exec(text.split("\n")[0] ?? "");
  const sha = shaMatch ? shaMatch[1].toLowerCase() : null;
  const title = titleMatch ? titleMatch[1].trim().slice(0, 300) : null;
  if (!sha && !title) return null;
  return { sha, title };
}

/** Default window (hours after a deployment) in which a revert is attached to it. */
export const DEFAULT_REVERT_WINDOW_HOURS = 72;
