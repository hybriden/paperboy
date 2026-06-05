// Regenerate src/lib/ph-duotone.json — the duotone-only subset of the Phosphor
// Iconify collection. The full @iconify-json/ph bundles all 6 weights (~950 kB
// gzipped); content-type icons only use duotone, so we ship 1/6 of that.
// Run after bumping @iconify-json/ph:  node scripts/gen-ph-duotone.mjs
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const full = require("@iconify-json/ph/icons.json");

const icons = Object.fromEntries(
  Object.entries(full.icons).filter(([name]) => name.endsWith("-duotone")),
);
const aliases = Object.fromEntries(
  Object.entries(full.aliases ?? {}).filter(
    ([name, def]) => name.endsWith("-duotone") && def.parent in icons,
  ),
);
const subset = {
  prefix: full.prefix,
  info: full.info,
  lastModified: full.lastModified,
  icons,
  aliases,
  width: full.width,
  height: full.height,
};

const out = join(dirname(fileURLToPath(import.meta.url)), "../src/lib/ph-duotone.json");
writeFileSync(out, JSON.stringify(subset));
console.log(`ph-duotone.json: ${Object.keys(icons).length} icons, ${Object.keys(aliases).length} aliases`);
