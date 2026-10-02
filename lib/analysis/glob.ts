/**
 * Stage 5: path globs for .deployguard.yml and CODEOWNERS. Pure, no imports.
 *
 *   **   any number of path segments (including none)
 *   *    anything except "/"
 *   ?    one character except "/"
 *
 * A pattern without "/" (other than a trailing one) matches the name at any
 * depth, like .gitignore: "*.tf" matches "infra/main.tf". A trailing "/" means
 * "this directory and everything under it". A leading "/" anchors to the root.
 */
export function globToRegExp(pattern: string): RegExp {
  let p = pattern.trim().replace(/\\/g, "/");
  let anchored = p.startsWith("/");
  if (anchored) p = p.slice(1);
  const directory = p.endsWith("/");
  if (directory) p = p.slice(0, -1);
  if (p.includes("/")) anchored = true;

  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      // "**/" = zero or more directories; a trailing "**" = everything below.
      if (p[i + 2] === "/") {
        re += "(?:[^/]+/)*";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const prefix = anchored ? "^" : "^(?:.*/)?";
  // A match also covers everything inside a matched directory.
  return new RegExp(`${prefix}${re}(?:/.*)?$`);
}

export function matchesGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path.replace(/\\/g, "/").replace(/^\.?\//, ""));
}
