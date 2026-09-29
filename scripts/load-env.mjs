import fs from "node:fs";
import path from "node:path";

/**
 * Loads .env then .env.local into process.env, the same order Next.js uses
 * (.env.local wins). Plain Node scripts do not get Next's env loading, so the
 * standalone scripts in this folder call this first.
 *
 * Values are never printed by this module.
 */
export function loadEnv(cwd = process.cwd()) {
  for (const file of [".env", ".env.local"]) {
    const full = path.join(cwd, file);
    if (!fs.existsSync(full)) continue;

    const lines = fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();

      // A double-quoted value may span several lines (e.g. a PEM private key).
      if (value.startsWith('"') && !(value.length > 1 && value.endsWith('"'))) {
        const parts = [value];
        while (i + 1 < lines.length) {
          const next = lines[++i];
          parts.push(next);
          if (next.trimEnd().endsWith('"')) break;
        }
        value = parts.join("\n").trimEnd();
      }

      process.env[key] = value.replace(/^["']|["']$/g, ""); // later file overrides earlier, like Next.js
    }
  }
}
