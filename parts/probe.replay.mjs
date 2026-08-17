/**
 * probe.replay.mjs — replay a committed suite and fail on drift. FOR CI.
 *
 * This is not the workflow. The workflow is the page: it runs the sweep as you design and
 * marks the broken fields on the form. This exists only so a build can hold a finished mapping
 * to what it was proven to do, which needs a headless entry point and nothing more.
 *
 *   node parts/probe.replay.mjs --suite parts/suite-nested.json
 *
 * Options
 *   --suite <path>       required; the committed pack
 *   --config <path>      overrides the mapping named in the suite
 *   --input <path>       overrides the example response
 *   --properties <path>  overrides the flow properties
 *   --write              rewrite the suite from this run instead of checking against it
 *   --fail-on <level>    blocker | high | medium | low | never   (default: high)
 *   --strict             treat NEW cases as failures too
 *
 * Exit codes
 *   0  nothing at or above the threshold, and no drift
 *   1  drift, or findings at or above the threshold
 *   2  could not run at all — jsonata missing, a file unreadable, the mapping uncompilable
 *
 * jsonata is not a dependency of this folder. Point JSONATA_MODULE at an install, or let the
 * search below find one:
 *
 *   JSONATA_MODULE=/path/to/node_modules/jsonata node parts/probe.replay.mjs --suite ...
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const MappingNodes = require("./nodes.js");
const MappingProbe = require("./probe.js");

/* ── jsonata, the same candidate search the test files use ─────────────────────────── */

const JSONATA_CANDIDATES = [
  process.env.JSONATA_MODULE,
  "jsonata",
  resolve(here, "..", "node_modules", "jsonata"),
  resolve(here, "..", "..", "node_modules", "jsonata"),
].filter(Boolean);

let jsonata = null;
for (const candidate of JSONATA_CANDIDATES) {
  try { jsonata = require(candidate); break; } catch { /* keep looking */ }
}
if (!jsonata) {
  console.error("Could not load jsonata. Install it, or set JSONATA_MODULE.");
  process.exit(2);
}

/* ── arguments ─────────────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = argv.indexOf("--" + name);
  return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[at + 1] : fallback;
};
const has = (name) => argv.includes("--" + name);

const suitePath = flag("suite");
if (!suitePath) {
  console.error("Nothing to replay — pass --suite <path>.");
  process.exit(2);
}

const readJson = (path, what) => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { console.error(`Could not read ${what} (${path}) — ${error.message}`); process.exit(2); }
};

const suite = readJson(suitePath, "the suite");
const configPath = flag("config", suite.config?.source);
const modelPath = flag("input", suite.envelope?.model?.source ?? resolve(here, "sample-input.json"));
const propsPath = flag("properties", suite.envelope?.properties?.source ?? resolve(here, "sample-properties.json"));

if (!configPath) {
  console.error("The suite does not name a mapping and none was given — pass --config <path>.");
  process.exit(2);
}

const config = readJson(configPath, "the mapping");
const model = readJson(modelPath, "the example response");
const properties = readJson(propsPath, "the flow properties");

/* ── run ───────────────────────────────────────────────────────────────────────────── */

const THRESHOLDS = { blocker: 0, high: 1, medium: 2, low: 3, never: 99 };
const RANK = { blocker: 0, high: 1, medium: 2, low: 3, pass: 4 };
const failOn = flag("fail-on", "high");
if (!(failOn in THRESHOLDS)) {
  console.error(`--fail-on must be one of ${Object.keys(THRESHOLDS).join(", ")}`);
  process.exit(2);
}

let compiled;
try { compiled = jsonata(MappingNodes.generate(config)); }
catch (error) { console.error(`The mapping does not compile — ${error.message}`); process.exit(2); }

const tier = suite.tier || "standard";
const planned = MappingProbe.plan(config, { model, properties, tier });

/* The suite is keyed by case id; plan() returns caseId. Normalise so compare() can join. */
planned.cases = planned.cases.map((c) => ({ ...c, id: c.caseId }));

const run = await MappingProbe.run({
  config, compiled, model, properties, cases: planned.cases, deps: planned.deps, chunk: 64,
});

if (has("write")) {
  const rewritten = MappingProbe.toSuite(config, planned, run, {
    tier, model, properties,
    configSource: configPath, modelSource: modelPath, propertiesSource: propsPath,
  });
  /* Acceptances are a human decision and must survive a rewrite, or every regeneration would
     silently re-open every problem someone had already signed off. Baseline findings carry
     them too — a field that is dead on purpose is exactly the kind of thing that gets accepted
     once and should stay accepted. */
  const acceptedCases = new Map((suite.cases || []).map((c) => [c.id, c.accepted]));
  rewritten.cases.forEach((c) => { if (acceptedCases.get(c.id)) c.accepted = acceptedCases.get(c.id); });

  const acceptedFindings = new Map(
    ((suite.baseline || {}).findings || []).map((f) => [f.code + "\u0000" + f.nodePath, f.accepted])
  );
  rewritten.baseline.findings.forEach((f) => {
    const carried = acceptedFindings.get(f.code + "\u0000" + f.nodePath);
    if (carried) f.accepted = carried;
  });
  writeFileSync(suitePath, JSON.stringify(rewritten, null, 2) + "\n");
  console.log(`wrote ${suitePath} — ${rewritten.cases.length} cases, ${planned.pointers} paths`);
  process.exit(0);
}

const outcomes = MappingProbe.compare(suite, planned, run);

/* ── report ────────────────────────────────────────────────────────────────────────── */

const by = (name) => outcomes.filter((o) => o.outcome === name);
const drift = by("drift");
const findings = by("finding");
const fresh = by("new").filter((o) => o.severity !== "pass");
const stale = by("stale");
const accepted = by("accepted");

const short = (path) => (path ? path.split("/").slice(-3).join("/") || path : "(payload)");

console.log(`suite      ${suitePath}`);
console.log(`mapping    ${configPath}`);
if (suite.config?.fingerprint && suite.config.fingerprint !== MappingProbe.fingerprint(config)) {
  /* Annotated, never fatal: invalidating the pack the moment anyone renames a field would make
     it useless exactly when it is most needed. */
  console.log(`           note — the mapping has changed since this suite was written`);
}
console.log(`cases      ${planned.cases.length} planned, ${suite.cases?.length ?? 0} in the suite`);

/* One line per FIELD, not per case. Thirty near-identical sentences about the same field is a
   report that gets skimmed and then ignored; the field and the count are the news. */
const section = (label, rows) => {
  if (!rows.length) return;
  console.log(`\n  ${label} — ${rows.length}`);
  const byField = new Map();
  for (const row of rows) {
    const key = (row.nodePath ?? "") + "\u0001" + (row.message ?? "").slice(0, 40);
    if (!byField.has(key)) byField.set(key, { ...row, count: 0 });
    byField.get(key).count++;
  }
  const grouped = [...byField.values()];
  for (const row of grouped.slice(0, 25)) {
    const times = row.count > 1 ? ` (${row.count} cases)` : "";
    console.log(`    ${short(row.nodePath)}${times}`);
    console.log(`      ${row.message}`);
  }
  if (grouped.length > 25) console.log(`    …and ${grouped.length - 25} more`);
};

section("DRIFT — a case now concludes something different", drift);
section("FINDINGS", findings.filter((f) => RANK[f.severity] <= THRESHOLDS[failOn]));
section("NEW — not in the suite", fresh);
section("STALE — in the suite but no longer applicable", stale);

const blocking = findings.filter((f) => RANK[f.severity] <= THRESHOLDS[failOn]);
const failed = drift.length > 0 || blocking.length > 0 || (has("strict") && fresh.length > 0);

console.log(
  `\n${by("pass").length} pass · ${accepted.length} accepted · ${blocking.length} findings · ` +
  `${drift.length} drift · ${fresh.length} new · ${stale.length} stale`
);
process.exit(failed ? 1 : 0);
