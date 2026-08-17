/* ══════════════════════════════════════════════════════════════════════════════════════
   probe.js — tests. Plain node, no jest.

     cd parts && node probe.test.js

   The engine makes claims about a mapping it did not write, so the thing most worth testing
   is not any single classification but the JOIN: that the paths it injures are the paths the
   generated expression actually reads. If extraction drifts from emission the probe injures
   nothing, every case comes back clean, and the report cheerfully certifies a broken mapping.
   That failure is silent, so two independent cross-checks guard it — one textual, one
   behavioural — and they are the first tests in the file for a reason.

     JSONATA_MODULE=/path/to/node_modules/jsonata node probe.test.js
   ══════════════════════════════════════════════════════════════════════════════════════ */
"use strict";

var path = require("path");
var fs = require("fs");
var N = require("./nodes.js");
var P = require("./probe.js");

var JSONATA_CANDIDATES = [
  process.env.JSONATA_MODULE,
  "jsonata",
  path.resolve(__dirname, "..", "node_modules", "jsonata"),
  path.resolve(__dirname, "..", "..", "node_modules", "jsonata"),
].filter(Boolean);

var jsonata = null;
for (var c = 0; c < JSONATA_CANDIDATES.length && !jsonata; c++) {
  try { jsonata = require(JSONATA_CANDIDATES[c]); } catch (e) { /* keep looking */ }
}
if (!jsonata) {
  console.error("FATAL: could not load jsonata. Install it, or set JSONATA_MODULE.");
  process.exit(2);
}

/* ── harness ─────────────────────────────────────────────────────────────────────────── */

var passed = 0;
var failed = 0;
var pending = [];

function report(ok, name, note) {
  if (ok) { passed++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (note ? "\n        " + String(note).split("\n").join("\n        ") : "")); }
}

function testAsync(name, body) {
  pending.push(
    Promise.resolve().then(body)
      .then(function (note) { report(true, name); if (note) console.log("        " + note); })
      .catch(function (e) { report(false, name, (e && e.stack) ? e.stack.split("\n").slice(0, 6).join("\n") : String(e)); })
  );
}

function test(name, body) {
  try {
    var note = body();
    report(true, name);
    if (note) console.log("        " + note);
  } catch (e) {
    report(false, name, (e && e.stack) ? e.stack.split("\n").slice(0, 6).join("\n") : String(e));
  }
}

function assert(condition, message) { if (!condition) throw new Error(message || "assertion failed"); }

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || "not equal") +
      "\n  expected: " + JSON.stringify(expected) + "\n  actual:   " + JSON.stringify(actual));
  }
}

/* ── fixtures ────────────────────────────────────────────────────────────────────────── */

function load(name) { return JSON.parse(fs.readFileSync(path.join(__dirname, name), "utf8")); }

var EXAMPLES = ["example-basics.json", "example-nested.json"];
var MODEL = load("sample-input.json");
var PROPERTIES = load("sample-properties.json");

/** One sweep, wired the way the page wires it. */
function sweep(config, options) {
  options = options || {};
  var model = options.model || MODEL;
  var properties = options.properties || PROPERTIES;
  var planned = P.plan(config, { model: model, properties: properties, tier: options.tier || "standard" });
  return P.run({
    config: config, compiled: jsonata(N.generate(config)),
    model: model, properties: properties, cases: planned.cases, deps: planned.deps
  }).then(function (run) {
    run.planned = planned;
    run.codes = function (code) { return run.results.filter(function (r) { return r.code === code; }); };
    return run;
  });
}

/* ══ the join: extraction must match emission ══════════════════════════════════════════ */

/* Textual. Every path a dependency claims to read has to appear, rendered by the same pathRef
   the emitter uses, somewhere in the generated expression. Cheap, and it catches gross drift —
   a renamed key, a segment dropped while composing a frame. */
EXAMPLES.forEach(function (name) {
  test("extraction: every read appears in the generated expression — " + name, function () {
    var config = load(name);
    var expression = N.generate(config);
    var checked = 0;
    P.dependencies(config).forEach(function (dep) {
      if (dep.unresolved) return;
      dep.reads.forEach(function (read) {
        /* The tail after the last wildcard is what the emitter writes relative to a loop
           variable; the segments before it are how the loop variable was reached. */
        var segments = read.segments.slice();
        var lastWildcard = -1;
        segments.forEach(function (step, index) { if (step === P._internal.WILDCARD) lastWildcard = index; });
        var tail = segments.slice(lastWildcard + 1).filter(function (step) { return typeof step === "string"; });
        if (!tail.length) return;
        checked++;
        assert(expression.indexOf(N.pathRef(tail.join("."))) >= 0,
          dep.nodePath + " claims to read " + read.pointer + ", but " +
          N.pathRef(tail.join(".")) + " is nowhere in the expression");
      });
    });
    assert(checked > 5, "expected the example to carry reads, checked " + checked);
    return checked + " reads found in the emitted text";
  });
});

/* Behavioural, and the stronger of the two. If a field says it reads a path, removing that path
   has to do something to that field. A pointer that can be deleted with no effect anywhere is
   extraction inventing a dependency — which is exactly how this feature would lie. The engine
   already classifies that as a low-severity NO_EFFECT, so the assertion is that there are none. */
EXAMPLES.forEach(function (name) {
  testAsync("extraction: no read is invented — " + name, function () {
    return sweep(load(name)).then(function (run) {
      var phantom = run.results.filter(function (r) { return r.code === "NO_EFFECT" && r.severity === "low"; });
      assert(!phantom.length, "paths that nothing actually reads:\n  " +
        phantom.slice(0, 5).map(function (r) { return r.message; }).join("\n  "));
      return run.planned.cases.length + " cases, " + run.planned.pointers + " pointers";
    });
  });
});

test("extraction: the smallest example resolves to exactly the paths it reads", function () {
  var pointers = {};
  P.dependencies(load("example-basics.json")).forEach(function (dep) {
    dep.reads.forEach(function (read) { pointers[read.pointer] = true; });
  });
  var expected = [
    "result.orders",
    "result.orders[*].header.orderNo",
    "result.orders[*].header.customer",
    "result.orders[*].lines",
    "result.orders[*].lines[*].sku",
    "result.orders[*].lines[*].name"
  ];
  expected.forEach(function (pointer) { assert(pointers[pointer], "missing " + pointer); });
  return Object.keys(pointers).sort().join("\n        ");
});

/* "root" means the outermost RECORD, not the response document — nodes.js:182 stops one link
   short on purpose, and an extraction that walks all the way up would injure the wrong path. */
test("extraction: scope root resolves to the outermost record, not the document", function () {
  var config = { root: { type: "array", key: "Rows", source: "rows",
    item: { type: "array", key: "Inner", source: "inner",
      item: { type: "leaf", key: "Top", source: "id", scope: "root" } } } };
  var deps = P.dependencies(config);
  var leaf = deps.filter(function (d) { return d.key === "Top"; })[0];
  equal(leaf.reads[0].pointer, "rows[*].id", "root frame");
});

test("extraction: scope auto reads the record and the one enclosing it", function () {
  var config = { root: { type: "array", key: "Rows", source: "rows",
    item: { type: "array", key: "Lines", source: "lines",
      item: { type: "leaf", key: "Plant", source: "plant", scope: "auto" } } } };
  var leaf = P.dependencies(config).filter(function (d) { return d.key === "Plant"; })[0];
  equal(leaf.reads.length, 2, "two frames");
  equal(leaf.reads[0].pointer, "rows[*].lines[*].plant", "instance frame");
  equal(leaf.reads[1].pointer, "rows[*].plant", "parent frame");
  equal(leaf.reads[1].via, "scope:auto", "the parent read is marked as the auto fallback");
});

test("extraction: a filter path is relative to the item, not to the array", function () {
  var config = { root: { type: "array", key: "Rows", source: "rows",
    filterPath: "status", filterOperator: "equals", filterValue: "open",
    item: { type: "leaf", source: "id" } } };
  var array = P.dependencies(config)[0];
  var filter = array.reads.filter(function (r) { return r.role === "filter"; })[0];
  equal(filter.pointer, "rows[*].status", "filter pointer");
});

test("extraction: a raw source expression is reported as a gap, not guessed at", function () {
  var config = { root: { type: "array", key: "Rows", sourceExpression: "model.rows[0].sub",
    item: { type: "object", children: [{ type: "leaf", key: "Id", source: "id" }] } } };
  var leaf = P.dependencies(config).filter(function (d) { return d.key === "Id"; })[0];
  assert(leaf.unresolved, "a node under a raw expression must be marked unresolved");
  equal(leaf.reads.length, 0, "and must claim no reads");
});

/* ══ mutation ══════════════════════════════════════════════════════════════════════════ */

test("mutate: the original document is never touched", function () {
  var model = { a: { b: [{ c: 1 }, { c: 2 }] } };
  var snapshot = JSON.stringify(model);
  var result = P._internal.mutate(model, ["a", "b", P._internal.WILDCARD, "c"], 0, { kind: "delete" }, false);
  equal(JSON.stringify(model), snapshot, "the input changed underneath us");
  equal(JSON.stringify(result.value), '{"a":{"b":[{},{"c":2}]}}', "the copy");
  /* Copy-on-write: untouched branches are shared, not cloned. */
  assert(result.value.a.b[1] === model.a.b[1], "an untouched element should be shared, not copied");
});

test("mutate: first versus every element", function () {
  var model = { rows: [{ v: 1 }, { v: 2 }, { v: 3 }] };
  var segments = ["rows", P._internal.WILDCARD, "v"];
  equal(JSON.stringify(P._internal.mutate(model, segments, 0, { kind: "delete" }, false).value),
    '{"rows":[{},{"v":2},{"v":3}]}', "first only");
  equal(JSON.stringify(P._internal.mutate(model, segments, 0, { kind: "delete" }, true).value),
    '{"rows":[{},{},{}]}', "every element");
});

test("mutate: a path that is not there reports itself rather than creating one", function () {
  var result = P._internal.mutate({ a: 1 }, ["b", "c"], 0, { kind: "set", value: 9 }, false);
  equal(result.changed, false, "changed");
  equal(JSON.stringify(result.value), '{"a":1}', "nothing invented");
});

/* Paths come from a config file that can be imported from disk, so this is reachable. */
test("mutate: refuses to walk into the prototype chain", function () {
  var result = P._internal.mutate({ a: 1 }, ["__proto__", "polluted"], 0, { kind: "set", value: true }, false);
  equal(result.changed, false, "changed");
  equal(({}).polluted, undefined, "Object.prototype was written to");
});

test("applyCase: the envelope cases build the shapes the mapper action really passes", function () {
  var envelope = { model: { a: 1 }, properties: { Existing: [1], Mapping: { root: {} } } };
  equal(JSON.stringify(P.applyCase({ kind: "envelope", id: "MODEL_EMPTY" }, envelope).model), "{}", "MODEL_EMPTY");
  equal(P.applyCase({ kind: "envelope", id: "MODEL_NULL" }, envelope).model, null, "MODEL_NULL");
  equal(P.applyCase({ kind: "envelope", id: "MODEL_ABSENT" }, envelope).model, undefined, "MODEL_ABSENT");
  equal(P.applyCase({ kind: "envelope", id: "PROPERTIES_ABSENT" }, envelope).properties, undefined, "PROPERTIES_ABSENT");
  /* An unconfigured flow still gets Mapping, because the mapper action injects it. */
  equal(JSON.stringify(Object.keys(P.applyCase({ kind: "envelope", id: "PROPERTIES_MAPPING_ONLY" }, envelope).properties)),
    '["Mapping"]', "PROPERTIES_MAPPING_ONLY");
  equal(JSON.stringify(Object.keys(P.applyCase({ kind: "envelope", id: "PROPERTIES_KEY_MISSING", name: "Existing" }, envelope).properties)),
    '["Mapping"]', "PROPERTIES_KEY_MISSING");
  equal(JSON.stringify(envelope.properties.Existing), "[1]", "the original envelope was mutated");
});

/* ══ the oracle, one positive case per classification ══════════════════════════════════ */

testAsync("THROWS: one unparseable number destroys the whole payload", function () {
  var config = { root: { type: "array", key: "Rows", source: "rows", item: { type: "object", children: [
    { type: "leaf", key: "Id", source: "id" },
    { type: "leaf", key: "Qty", source: "qty", transform: "number" }
  ] } } };
  return sweep(config, { model: { rows: [{ id: "A", qty: "1" }, { id: "B", qty: "2" }] } }).then(function (run) {
    var throws = run.codes("THROWS");
    assert(throws.length, "expected $number to abort on non-numeric text");
    assert(throws.some(function (r) { return r.blastRadius === "payload"; }), "blast radius must be the payload");
    assert(throws[0].message.indexOf("Every other field is discarded") >= 0, "the message must say what it costs");
    return throws.length + " cases lose the payload";
  });
});

testAsync("PAYLOAD_COLLAPSE: a localised injury that empties everything is a blocker", function () {
  /* JSONata omits a key whose value is undefined, so a one-field payload becomes {} the moment
     that field's path goes missing — an empty payload from an injury nowhere near the root. */
  var config = { root: { type: "object", children: [{ type: "leaf", key: "Id", source: "id" }] } };
  return sweep(config, { model: { id: "A" } }).then(function (run) {
    var collapse = run.codes("PAYLOAD_COLLAPSE");
    assert(collapse.length, "expected the empty payload to be reported");
    equal(collapse[0].severity, "blocker", "severity");
    assert(collapse[0].message.indexOf("every field is lost") >= 0, "the message must say what it costs");
  });
});

/* Emptying the list the whole mapping iterates SHOULD produce an empty payload. Reporting the
   one case that works as designed as the loudest finding in the report is how a report gets
   ignored. */
testAsync("PAYLOAD_COLLAPSE: emptying the root source is a pass, not a blocker", function () {
  return sweep(load("example-basics.json")).then(function (run) {
    var blockers = run.results.filter(function (r) {
      return r.severity === "blocker" && r.mutation.pointer === "result.orders";
    });
    assert(!blockers.length, "emptying the root list was called a blocker: " +
      blockers.map(function (b) { return b.label; }).join(", "));
    var passes = run.results.filter(function (r) {
      return r.mutation.pointer === "result.orders" && r.severity === "pass";
    });
    assert(passes.length, "expected it to be reported as the right answer");
  });
});

testAsync("SILENT_SUBSTITUTION: an auto-scope field quietly reading the enclosing record", function () {
  var config = { root: { type: "array", key: "Rows", source: "rows", item: { type: "object", children: [
    { type: "array", key: "Lines", source: "lines", item: { type: "object", children: [
      { type: "leaf", key: "Plant", source: "plant", scope: "auto" }
    ] } }
  ] } } };
  /* The line has its own plant; the row has a different one. Remove the line's, and the field
     keeps a value — the row's — with no error and no clue on the payload. */
  var model = { rows: [{ plant: "ROW", lines: [{ plant: "LINE" }, { plant: "LINE2" }] }] };
  return sweep(config, { model: model }).then(function (run) {
    var silent = run.codes("SILENT_SUBSTITUTION");
    assert(silent.length, "expected the substitution to be caught");
    assert(silent[0].message.indexOf("enclosing record") >= 0, "the message must explain what happened");
    /* It must name the value the field quietly took — the row's, not the line's. */
    assert(silent[0].message.indexOf('"ROW"') >= 0,
      "the message must show the substituted value, got: " + silent[0].message);
    /* And only where the inference holds: a nulled or blanked path does not trigger the auto
       fallback at all, because $exists() is true for both. */
    silent.forEach(function (r) {
      equal(r.mutation.id, "DELETE_KEY", "substitution claimed for " + r.mutation.id);
    });
    return silent.length + " cases";
  });
});

testAsync("SILENT_SUBSTITUTION: not reported for a fallbackSource, which is what was asked for", function () {
  var config = { root: { type: "array", key: "Rows", source: "rows", item: { type: "object", children: [
    { type: "leaf", key: "Name", source: "name", fallbackSource: "id" }
  ] } } };
  return sweep(config, { model: { rows: [{ name: "N", id: "I" }] } }).then(function (run) {
    equal(run.codes("SILENT_SUBSTITUTION").length, 0, "falling back on purpose is not a surprise");
  });
});

testAsync("CARDINALITY: an alwaysArray node that stops being a list", function () {
  var config = { root: { type: "object", children: [
    { type: "array", key: "Rows", source: "rows", alwaysArray: false, item: { type: "leaf", source: "id" } }
  ] } };
  return sweep(config, { model: { rows: [{ id: "A" }, { id: "B" }] } }).then(function (run) {
    /* alwaysArray:false opts out, so nothing to report here — this pins that the check does not
       fire on a node that asked for the collapse. */
    equal(run.codes("CARDINALITY").length, 0, "alwaysArray:false must not be reported");
  });
});

testAsync("LIST_SHRINKS: rows disappearing without an error", function () {
  return sweep(load("example-basics.json")).then(function (run) {
    var shrink = run.codes("LIST_SHRINKS");
    assert(shrink.length, "expected a shrinking list to be reported");
    assert(shrink[0].message.indexOf("without any error") >= 0, "the message must say it is silent");
    return shrink.length + " cases across " + new Set(shrink.map(function (r) { return r.nodePath; })).size + " lists";
  });
});

testAsync("ARTEFACT: a prefix concatenated onto nothing", function () {
  var config = { root: { type: "array", key: "Rows", source: "rows", item: { type: "object", children: [
    { type: "leaf", key: "Label", source: "name", prefix: "Operation " }
  ] } } };
  return sweep(config, { model: { rows: [{ name: "Pump" }] } }).then(function (run) {
    var artefact = run.codes("ARTEFACT");
    assert(artefact.length, "expected the dangling prefix to be reported");
    assert(artefact[0].message.indexOf("looks like data but it is not") >= 0, "the message must name the problem");
  });
});

testAsync("COLLATERAL: a container reflecting its own children is not collateral", function () {
  return Promise.all(EXAMPLES.map(function (name) {
    return sweep(load(name)).then(function (run) {
      var collateral = run.codes("COLLATERAL");
      assert(!collateral.length, name + " reported collateral that is really its own children:\n  " +
        collateral.slice(0, 3).map(function (r) { return r.message; }).join("\n  "));
    });
  })).then(function () { return "three examples, no false collateral"; });
});

testAsync("DEAD_AT_BASELINE: a path that is not in the response even before anything is injured", function () {
  return sweep(load("example-nested.json")).then(function (run) {
    var dead = run.findings.filter(function (f) { return f.code === "DEAD_AT_BASELINE"; });
    assert(dead.length, "expected the deliberately broken demo field to be caught");
    assert(dead[0].nodePath.indexOf("Warehouse") >= 0, "expected it at the demo field, got " + dead[0].nodePath);
    return dead.length + " dead field(s)";
  });
});

/* ══ static findings ═══════════════════════════════════════════════════════════════════ */

test("FILTER_CONTEXT: a filter reading model directly is caught without running anything", function () {
  var findings = P.staticFindings({ root: { type: "array", key: "Rows", source: "rows",
    filterExpression: 'model.plant = "P1"', item: { type: "leaf", source: "id" } } });
  var hit = findings.filter(function (f) { return f.code === "FILTER_CONTEXT"; });
  equal(hit.length, 1, "expected one FILTER_CONTEXT");
  equal(hit[0].severity, "blocker", "severity");
  assert(hit[0].message.indexOf("$$.model") >= 0, "the message must give the fix");
});

test("FILTER_CONTEXT: $$-qualified references are fine", function () {
  var findings = P.staticFindings({ root: { type: "array", key: "Rows", source: "rows",
    filterExpression: '$$.model.plant = "P1"', item: { type: "leaf", source: "id" } } });
  equal(findings.filter(function (f) { return f.code === "FILTER_CONTEXT"; }).length, 0, "no finding expected");
});

test("properties: discovered from raw expressions, with Mapping excluded", function () {
  var found = P.discoverProperties({ root: { type: "object", children: [
    { type: "leaf", key: "A", expression: "$$.properties.Existing[0].Id" },
    { type: "leaf", key: "B", expression: "$$.properties.`Work Order`" },
    { type: "leaf", key: "C", expression: "$$.properties.Mapping.root" }
  ] } });
  equal(JSON.stringify(Object.keys(found).sort()), '["Existing","Work Order"]', "discovered names");
  equal(JSON.stringify(found.Existing), '["/A"]', "and the field that uses it");
});

testAsync("properties: a mapping that reads one gets a case for it going missing", function () {
  var config = { root: { type: "object", children: [
    { type: "leaf", key: "Known", expression: "$$.properties.Existing[0].Id" }
  ] } };
  var planned = P.plan(config, { model: MODEL, properties: PROPERTIES, tier: "smoke" });
  var missing = planned.cases.filter(function (c) { return c.mutation.id === "PROPERTIES_KEY_MISSING"; });
  equal(missing.length, 1, "expected one property-absence case");
  equal(missing[0].mutation.name, "Existing", "for the right property");
  return sweep(config).then(function (run) {
    /* It resolves to nothing without the property, so the field must be reported as lost. */
    var affected = run.results.filter(function (r) { return r.mutation.id === "PROPERTIES_KEY_MISSING"; });
    assert(affected.length, "expected the case to be run");
  });
});

/* ══ housekeeping ══════════════════════════════════════════════════════════════════════ */

test("fingerprint: ignores key order and renderer-internal keys", function () {
  var a = { root: { key: "A", type: "object", children: [] } };
  var b = { root: { type: "object", children: [], key: "A" } };
  var c = { root: { type: "object", children: [], key: "A", __id: "n7", __items: {} } };
  equal(P.fingerprint(a), P.fingerprint(b), "key order changed the fingerprint");
  equal(P.fingerprint(a), P.fingerprint(c), "a renderer-internal key changed the fingerprint");
  assert(P.fingerprint(a) !== P.fingerprint({ root: { key: "B", type: "object", children: [] } }),
    "a real change must change the fingerprint");
  return P.fingerprint(a);
});

test("case ids are content-addressed, so adding a field does not renumber the suite", function () {
  var before = P.plan(load("example-basics.json"), { model: MODEL, properties: PROPERTIES, tier: "smoke" });
  var grown = load("example-basics.json");
  grown.root.item.children.push({ type: "leaf", key: "Extra", constant: "x" });
  var after = P.plan(grown, { model: MODEL, properties: PROPERTIES, tier: "smoke" });
  var beforeIds = before.cases.map(function (c) { return c.caseId; });
  var kept = after.cases.filter(function (c) { return beforeIds.indexOf(c.caseId) >= 0; });
  equal(kept.length, before.cases.length, "every original case should keep its id");
});

test("plan: the case budget is reported rather than silently applied", function () {
  var planned = P.plan(load("example-nested.json"),
    { model: MODEL, properties: PROPERTIES, tier: "paranoid", maxCases: 25 });
  equal(planned.cases.length, 25, "capped");
  assert(planned.truncated > 0, "the number dropped must be reported, not swallowed");
  return planned.truncated + " cases dropped and said so";
});

test("plan: paths absent from the sample are reported as untested, not skipped quietly", function () {
  var planned = P.plan(load("example-nested.json"), { model: MODEL, properties: PROPERTIES });
  assert(planned.skipped.length, "expected the broken demo path to be listed as untestable");
  assert(planned.skipped.some(function (s) { return s.reason === "PATH_ABSENT_AT_BASELINE"; }), "reason");
  return planned.skipped.length + " pointers absent at baseline";
});

testAsync("a run is deterministic", function () {
  var config = load("example-basics.json");
  return Promise.all([sweep(config), sweep(config)]).then(function (runs) {
    equal(JSON.stringify(runs[0].results), JSON.stringify(runs[1].results), "two runs differ");
  });
});

testAsync("a run can be stopped between chunks", function () {
  var config = load("example-nested.json");
  var planned = P.plan(config, { model: MODEL, properties: PROPERTIES, tier: "standard" });
  var seen = 0;
  return P.run({
    config: config, compiled: jsonata(N.generate(config)), model: MODEL, properties: PROPERTIES,
    cases: planned.cases, deps: planned.deps, chunk: 4,
    onProgress: function (done) { seen = done; },
    shouldStop: function () { return seen >= 8; }
  }).then(function (run) {
    assert(run.stopped, "the run should report that it was stopped");
    assert(run.ran < planned.cases.length, "it should not have finished all " + planned.cases.length);
    return "stopped after " + run.ran + " of " + planned.cases.length;
  });
});

testAsync("the index gives each field the two numbers its badge needs", function () {
  return sweep(load("example-nested.json")).then(function (run) {
    var byPath = P.index(run.results, run.findings);
    var paths = Object.keys(byPath);
    assert(paths.length, "expected some fields to carry findings");
    paths.forEach(function (p) {
      var entry = byPath[p];
      assert(typeof entry.fail === "number" && typeof entry.warn === "number" &&
        typeof entry.broken === "number", p + " is missing a count");
    });
    return paths.length + " fields carry a risk badge";
  });
});

/* ══ summary ═══════════════════════════════════════════════════════════════════════════ */

Promise.all(pending).then(function () {
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
});
