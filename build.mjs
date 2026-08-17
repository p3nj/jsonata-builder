/**
 * Assembles parts/ into the single self-contained demo page.
 *
 *   node build.mjs
 *
 * jsonata is inlined so the page runs from the filesystem with no network access
 * (Artifact pages block every external request). It is resolved from any connector's
 * node_modules; run `npm install` in one of them first, or set JSONATA_BUNDLE to a
 * jsonata.min.js path.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const parts = join(here, "parts");
const repo = here;

const read = (name) => readFileSync(join(parts, name), "utf8");
const readJson = (name) => JSON.parse(read(name));

const candidates = [
  process.env.JSONATA_BUNDLE,
  join(repo, "node_modules/jsonata/jsonata.min.js"),
].filter(Boolean);

const bundlePath = candidates.find((path) => existsSync(path));
if (!bundlePath) {
  console.error(
    "jsonata.min.js not found. Run `npm install jsonata` (or set JSONATA_BUNDLE) and retry.\nLooked in:\n  " +
      candidates.join("\n  "),
  );
  process.exit(1);
}

/** `</script>` inside injected data would close the tag early. */
const embed = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

/**
 * JSON Forms renders an array of objects as a table and dispatches a *cell* per property.
 * There is no cell renderer for an object or an array, so a nested property makes Prismatic
 * render "No applicable cell found" instead of the form. Keep every array item primitive.
 */
const assertNoNestedArrayItems = (schema) => {
  const offences = [];
  const walk = (node, path) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "array" && node.items?.type === "object") {
      for (const [key, prop] of Object.entries(node.items.properties ?? {})) {
        if (prop.type === "object" || prop.type === "array") {
          offences.push(`${path}[].${key} is ${prop.type}`);
        }
      }
      walk(node.items, `${path}[]`);
    }
    for (const [key, prop] of Object.entries(node.properties ?? {})) walk(prop, `${path}.${key}`);
  };
  walk(schema, "");
  if (offences.length) {
    console.error(
      'Schema nests objects/arrays inside array items. Prismatic renders "No applicable cell found" for these:\n  ' +
        offences.join("\n  ") +
        "\nFlatten them (comma-separated string, or a sibling array keyed by identifier).",
    );
    process.exit(1);
  }
};


const html = `${read("page.html")}

<style>
${read("styles.css")}
</style>

<script>
${readFileSync(bundlePath, "utf8")}
</script>

<script>
window.__SAMPLE_INPUT__ = ${embed(readJson("sample-input.json"))};
window.__SAMPLE_NODES__ = ${embed(readJson("sample-nodes.json"))};
window.__EXAMPLES__ = ${embed([
  { id: "basics", name: "The ideas, at their smallest",
    blurb: "A value, a list of plain values, a list of objects, numbered rows, and a field reaching the outer record.",
    config: readJson("example-basics.json") },
  { id: "nested",     name: "Everything else",
    blurb: "Joined paths, fallbacks, transforms, affixes, a filtered list, and a list nested inside a list.",
    config: readJson("example-nested.json") }
])};
window.__SAMPLE_PROPERTIES__ = ${embed(readJson("sample-properties.json"))};
</script>

${["nodes.js", "probe.js", "tree-ui.js", "probe-ui.js", "history.js", "playground.js"]
  .filter((name) => existsSync(join(parts, name)))
  .map((name) => `<script>\n${read(name)}\n</script>`)
  .join("\n")}

<script>
${read("app.js")}
</script>
`;

/* One complete document, written to site/ (what the Pages workflow uploads) and to the
   repository root (so the file can also be opened straight from a clone). */

const standalone = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="A form that writes JSONata for you, then fault-injects your sample input to show which fields break.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><text y='14' font-size='14'>%F0%9F%94%80</text></svg>">
</head>
<body>
${html}
</body>
</html>
`;

const siteDir = join(here, "site");
mkdirSync(siteDir, { recursive: true });
const siteOut = join(siteDir, "index.html");
writeFileSync(siteOut, standalone);

writeFileSync(join(here, "index.html"), standalone);
console.log(`wrote ${siteOut} and index.html (${(standalone.length / 1024).toFixed(0)} KB, jsonata from ${bundlePath})`);
