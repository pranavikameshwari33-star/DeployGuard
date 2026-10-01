/**
 * Stage 2: lets plain Node verification scripts import the app's own
 * TypeScript modules (lib/**) directly, so they test the REAL code rather
 * than a copy. Resolves the "@/..." path alias from tsconfig.json and adds the
 * ".ts" extension Node needs. Used with:
 *   node --experimental-strip-types --import ./scripts/ts-alias.mjs scripts/<script>.mjs
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const rootUrl = pathToFileURL(process.cwd() + "/").href;

const hooks = `
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const rootUrl = ${JSON.stringify(rootUrl)};
const hasExt = (u) => /\\.[cm]?[jt]sx?$/.test(u);
function withTs(url) {
  if (hasExt(url)) return url;
  for (const ext of [".ts", ".tsx", "/index.ts"]) {
    if (existsSync(fileURLToPath(url + ext))) return url + ext;
  }
  return url;
}
export async function resolve(specifier, context, next) {
  if (specifier.startsWith("@/")) return next(withTs(new URL(specifier.slice(2), rootUrl).href), context);
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL && context.parentURL.startsWith(rootUrl + "lib/")) {
    return next(withTs(new URL(specifier, context.parentURL).href), context);
  }
  return next(specifier, context);
}
`;

register("data:text/javascript," + encodeURIComponent(hooks), import.meta.url);
