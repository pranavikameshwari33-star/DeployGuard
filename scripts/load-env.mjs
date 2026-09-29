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

    for (const line of fs.readFileSync(full, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      process.env[key] = value; // later file overrides earlier, like Next.js
    }
  }
}
