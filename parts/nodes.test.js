/* ══════════════════════════════════════════════════════════════════════════════════════
   nodes.js — the tests the live generator never had. Plain node, no jest.

     cd parts && node nodes.test.js

   parser.test.js covers generator.js and parser.js, which build.mjs stopped inlining when
   the flat model was replaced. Everything the page actually runs — generate, validate,
   readings — had zero coverage, which is a poor foundation for a feature whose whole job is
   to make claims about what the generated expression does.

   jsonata is not a dependency of this folder, so it is looked for in a few likely places.
   Point JSONATA_MODULE at an install to skip the search:

     JSONATA_MODULE=/path/to/node_modules/jsonata node nodes.test.js
   ══════════════════════════════════════════════════════════════════════════════════════ */
"use strict";

var path = require("path");
var fs = require("fs");
var N = require("./nodes.js");

/* ── jsonata ─────────────────────────────────────────────────────────────────────────── */

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

/* ── tiny test harness ───────────────────────────────────────────────────────────────── */

var passed = 0;
var failed = 0;
var pending = [];

function report(ok, name, note) {
  if (ok) { passed++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (note ? "\n        " + String(note).split("\n").join("\n        ") : "")); }
}

function test(name, body) {
  var note;
  try {
    note = body();
    report(true, name);
    if (note) console.log("        " + String(note).split("\n").join("\n        "));
  } catch (e) {
    report(false, name, (e && e.stack) ? e.stack.split("\n").slice(0, 6).join("\n") : String(e));
  }
}

/** Async tests are collected and awaited at the end so the summary is not printed early. */
function testAsync(name, body) {
  pending.push(
    Promise.resolve()
      .then(body)
      .then(function (note) { report(true, name); if (note) console.log("        " + note); })
      .catch(function (e) { report(false, name, (e && e.stack) ? e.stack.split("\n").slice(0, 6).join("\n") : String(e)); })
  );
}

/**
 * A defect that is understood, reproduced and deliberately not fixed yet. It is reported every
 * run — loudly enough that nobody rediscovers it from scratch — but it does not fail the suite,
 * because a red build that is always red stops being read. The body must THROW while the bug is
 * present; the day it starts passing, that is reported too, as a signal to promote it to test().
 */
function known(name, note, body) {
  pending.push(
    Promise.resolve()
      .then(body)
      .then(function () {
        failed++;
        console.log("FIXED " + name + "\n        this no longer reproduces — promote it to test()");
      })
      .catch(function () {
        console.log("KNOWN " + name + "\n        " + String(note).split("\n").join("\n        "));
      })
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || "not equal") +
      "\n  expected: " + JSON.stringify(expected) +
      "\n  actual:   " + JSON.stringify(actual));
  }
}

function sorted(list) { return list.slice().sort(); }

/* ── fixtures ────────────────────────────────────────────────────────────────────────── */

function load(name) { return JSON.parse(fs.readFileSync(path.join(__dirname, name), "utf8")); }

var EXAMPLES = ["example-basics.json", "example-nested.json"];
var SAMPLE_INPUT = load("sample-input.json");
var SAMPLE_PROPERTIES = load("sample-properties.json");

function envelope(model, properties) {
  return { model: model, properties: properties || SAMPLE_PROPERTIES };
}

/* ══ pathRef / parsePath ═══════════════════════════════════════════════════════════════
   pathRef is the single authority on quoting and on "0 means index, not key" — its own
   comment says so, because splicing paths raw once dropped fields silently. parsePath was
   extracted from it so the probe can FOLLOW a path rather than render one; these pin the two
   to each other so the extraction can never disagree with the emission. */

test("parsePath: the three token kinds", function () {
  equal(N.parsePath("$index").kind, "index", "$index");
  ["$self", ".", "$"].forEach(function (token) {
    equal(N.parsePath(token).kind, "self", "self token " + JSON.stringify(token));
  });
  equal(N.parsePath("header.orderNo").kind, "segments", "ordinary path");
});

test("parsePath: a numeric segment is a number, not a string", function () {
  var segments = N.parsePath("items.0.name").segments;
  equal(JSON.stringify(segments), '["items",0,"name"]', "items.0.name");
  equal(typeof segments[1], "number", "the index is typed");
  /* A whole path of "0" is still an index — the same decision, at the first segment. */
  equal(typeof N.parsePath("0").segments[0], "number", "leading index");
});

test("parsePath: empty steps are dropped, matching pathRef", function () {
  equal(JSON.stringify(N.parsePath("a..b").segments), '["a","b"]', "a..b");
  equal(JSON.stringify(N.parsePath("  spaced  ").segments), '["spaced"]', "outer whitespace");
});

test("pathRef: renders parsePath, including every escape", function () {
  var table = {
    "order-no": "`order-no`",          // hyphen compiles as subtraction if left bare
    "a b": "`a b`",
    "in": "`in`",                       // reserved word
    "true": "`true`",
    "items.0.name": "items[0].name",
    "$index": "$index",
    "$self": "$",
    ".": "$",
    "$": "$",
    "a`b": "`ab`",                      // a backtick cannot be escaped inside one
    "a..b": "a.b",
    "  spaced  ": "spaced",
    "0": "[0]",
    "Order Ref.sub": "`Order Ref`.sub"
  };
  Object.keys(table).forEach(function (input) {
    equal(N.pathRef(input), table[input], "pathRef(" + JSON.stringify(input) + ")");
  });
});

test("pathRef: agrees with parsePath on every path in the shipped examples", function () {
  var count = 0;
  EXAMPLES.forEach(function (name) {
    (function walk(node) {
      if (!node) return;
      ["source", "fallbackSource", "filterPath"].forEach(function (key) {
        if (typeof node[key] !== "string" || !node[key].trim()) return;
        count++;
        var parsed = N.parsePath(node[key]);
        var rendered = N.pathRef(node[key]);
        if (parsed.kind === "index") { equal(rendered, "$index", node[key]); return; }
        if (parsed.kind === "self") { equal(rendered, "$", node[key]); return; }
        /* Every non-index segment must appear in the rendered reference, quoted or not. */
        parsed.segments.forEach(function (step) {
          if (typeof step === "number") {
            assert(rendered.indexOf("[" + step + "]") >= 0, node[key] + " lost index " + step);
          } else {
            assert(rendered.indexOf(step.replace(/`/g, "")) >= 0, node[key] + " lost segment " + step);
          }
        });
      });
      if (node.item) walk(node.item);
      (node.children || []).forEach(walk);
    })(load(name).root);
  });
  assert(count > 20, "expected the examples to carry plenty of paths, saw " + count);
  return count + " paths cross-checked";
});

/* ══ generate ══════════════════════════════════════════════════════════════════════════ */

test("generate: an empty config is a valid empty object, not a crash", function () {
  equal(N.generate({}), "(\n  {}\n)\n", "generate({})");
  equal(N.generate(), "(\n  {}\n)\n", "generate()");
  equal(N.generate({ root: { type: "object", children: [] } }), "(\n  {}\n)\n", "empty root");
});

EXAMPLES.forEach(function (name) {
  test("generate: " + name + " compiles", function () {
    var expr = N.generate(load(name));
    jsonata(expr);   // throws on a syntax error
    return expr.split("\n").length + " lines";
  });

  testAsync("generate: " + name + " evaluates against the sample input", function () {
    var expr = N.generate(load(name));
    return jsonata(expr).evaluate(envelope(SAMPLE_INPUT)).then(function (output) {
      assert(output !== undefined && output !== null, "produced nothing at all");
      return JSON.stringify(output).length + " chars of payload";
    });
  });
});

test("generate: is deterministic", function () {
  EXAMPLES.forEach(function (name) {
    var config = load(name);
    equal(N.generate(config), N.generate(config), name + " differs between two runs");
  });
});

/* alwaysArray exists because JSONata collapses a one-element sequence to the bare value, so a
   target expecting a list gets an object instead. The comment at nodes.js:268 documents the
   bug; nothing pinned the fix. */
[
  { label: "zero", rows: [] },
  { label: "one", rows: [{ id: "A" }] },
  { label: "many", rows: [{ id: "A" }, { id: "B" }, { id: "C" }] }
].forEach(function (shape) {
  testAsync("alwaysArray: stays a list at cardinality " + shape.label, function () {
    var config = { root: { type: "array", key: "Rows", source: "rows",
      item: { type: "object", children: [{ type: "leaf", key: "Id", source: "id" }] } } };
    return jsonata(N.generate(config)).evaluate(envelope({ rows: shape.rows })).then(function (out) {
      assert(Array.isArray(out), shape.label + " collapsed to " + JSON.stringify(out));
      equal(out.length, shape.rows.length, shape.label + " element count");
    });
  });
});

testAsync("alwaysArray: false lets a single element collapse, as advertised", function () {
  var config = { root: { type: "array", key: "Rows", source: "rows", alwaysArray: false,
    item: { type: "leaf", source: "id" } } };
  return jsonata(N.generate(config)).evaluate(envelope({ rows: [{ id: "A" }] })).then(function (out) {
    assert(!Array.isArray(out), "expected the collapse that alwaysArray:false opts into");
  });
});

/* A JSON null source is a value, so [null] iterated once and produced a phantom empty record.
   APIs return "lines": null all the time; that has to mean no records. */
[
  { label: "null", model: { rows: null } },
  { label: "absent", model: {} },
  { label: "empty", model: { rows: [] } }
].forEach(function (shape) {
  testAsync("array source " + shape.label + " yields [], not a phantom record", function () {
    var config = { root: { type: "array", key: "Rows", source: "rows",
      item: { type: "object", children: [{ type: "leaf", key: "Id", source: "id" }] } } };
    return jsonata(N.generate(config)).evaluate(envelope(shape.model)).then(function (out) {
      equal(JSON.stringify(out), "[]", shape.label + " source");
    });
  });
});

/* An array nested directly inside another array — no object in between — is the shape the
   insideArray rule at nodes.js:305 exists for. It holds as long as the OUTER array has more
   than one element. */
function nestedArrays() {
  return { root: { type: "array", key: "L1", source: "l1",
    item: { type: "array", key: "L2", source: "l2",
      item: { type: "object", children: [{ type: "leaf", key: "V", source: "v" }] } } } };
}

testAsync("nested arrays keep their depth when the outer array has several elements", function () {
  var model = { l1: [{ l2: [{ v: "a" }, { v: "b" }] }, { l2: [{ v: "c" }] }] };
  return jsonata(N.generate(nestedArrays())).evaluate(envelope(model)).then(function (out) {
    equal(JSON.stringify(out), '[[{"V":"a"},{"V":"b"}],[{"V":"c"}]]', "two outer elements");
  });
});

testAsync("an array inside an object inside an array keeps its depth at any cardinality", function () {
  var config = { root: { type: "array", key: "L1", source: "l1",
    item: { type: "object", children: [
      { type: "array", key: "L2", source: "l2",
        item: { type: "object", children: [{ type: "leaf", key: "V", source: "v" }] } }
    ] } } };
  var model = { l1: [{ l2: [{ v: "a" }] }] };
  return jsonata(N.generate(config)).evaluate(envelope(model)).then(function (out) {
    equal(JSON.stringify(out), '[{"L2":[{"V":"a"}]}]', "the object between the arrays protects the level");
  });
});

/* ── a known, reproduced, unfixed defect ───────────────────────────────────────────────
   $map over a ONE-element sequence returns that element's result directly rather than a
   one-element sequence, and JSONata cannot tell "a sequence holding one array" from "that
   array". So an array nested directly inside an array loses a level exactly when the outer
   array holds one element — which is the common case: sample-input.json carries a single work
   order. The insideArray rule at nodes.js:305 compensates in the wrong dimension; it wraps by
   ELEMENT TYPE, but the collapse depends on OUTER CARDINALITY, which no static wrap can track.

   A verified cardinality-independent fix exists — fold with $reduce/$append instead of $map:

     $append([], $reduce(<src>, function($acc, $item) { $append($acc, [<body>]) }, []))

   correct at 0, 1 and N elements for both object items and nested-array items. It is not
   applied here because it rewrites the emitted expression for EVERY array node in every
   existing mapping, which is a deliberate decision, not a drive-by. This is precisely the
   class of surprise the probe exists to report. */
known("nested arrays lose a level when the outer array holds exactly one element",
  "expected [[{\"V\":\"a\"},{\"V\":\"b\"}]], got [{\"V\":\"a\"},{\"V\":\"b\"}] — see the note above nodes.test.js:known",
  function () {
    var model = { l1: [{ l2: [{ v: "a" }, { v: "b" }] }] };
    return jsonata(N.generate(nestedArrays())).evaluate(envelope(model)).then(function (out) {
      equal(JSON.stringify(out), '[[{"V":"a"},{"V":"b"}]]', "single outer element");
    });
  });

/* ══ validate ══════════════════════════════════════════════════════════════════════════
   Every code, on a minimal offending config, reported at the nodePath the form can find. A
   diagnostic that names the wrong node is worse than none. */

function codesFor(config) {
  return N.validate(config).map(function (p) { return p.code; });
}

function problemAt(config, code) {
  var hit = N.validate(config).filter(function (p) { return p.code === code; });
  assert(hit.length === 1, "expected exactly one " + code + ", got " + hit.length +
    " (" + codesFor(config).join(", ") + ")");
  return hit[0];
}

test("validate: LEAF_NO_VALUE names the leaf", function () {
  var problem = problemAt({ root: { type: "object", children: [{ type: "leaf", key: "Empty" }] } }, "LEAF_NO_VALUE");
  equal(problem.nodePath, "/Empty", "nodePath");
  equal(problem.level, "error", "level");
});

test("validate: KEY_DUPLICATE names the second occurrence", function () {
  var problem = problemAt({ root: { type: "object", children: [
    { type: "leaf", key: "Same", source: "a" },
    { type: "leaf", key: "Same", source: "b" }
  ] } }, "KEY_DUPLICATE");
  equal(problem.nodePath, "/Same", "nodePath");
  equal(problem.level, "error", "level");
});

test("validate: KEY_BLANK names the unnamed entry by index", function () {
  var problem = problemAt({ root: { type: "object", children: [
    { type: "leaf", key: "Fine", source: "a" },
    { type: "leaf", source: "b" }
  ] } }, "KEY_BLANK");
  equal(problem.nodePath, "/[1]", "nodePath");
});

test("validate: PATH_BACKTICK and PATH_MALFORMED are errors, not warnings", function () {
  var tick = problemAt({ root: { type: "object", children: [
    { type: "leaf", key: "A", source: "a`b" }
  ] } }, "PATH_BACKTICK");
  equal(tick.level, "error", "backtick level");
  equal(tick.nodePath, "/A", "backtick nodePath");

  var malformed = problemAt({ root: { type: "object", children: [
    { type: "leaf", key: "A", source: "a..b" }
  ] } }, "PATH_MALFORMED");
  equal(malformed.level, "error", "malformed level");
});

test("validate: PATH_QUOTED is a warning — the path still works", function () {
  var problem = problemAt({ root: { type: "object", children: [
    { type: "leaf", key: "A", source: "order-no" }
  ] } }, "PATH_QUOTED");
  equal(problem.level, "warn", "level");
});

test("validate: ARRAY_NO_ITEM warns when an array does not say what it holds", function () {
  var problem = problemAt({ root: { type: "array", key: "Rows", source: "rows" } }, "ARRAY_NO_ITEM");
  equal(problem.level, "warn", "level");
  equal(problem.nodePath, "", "nodePath is the root");
});

test("validate: FILTER_EMPTY_LIST is an error — the filter removes everything", function () {
  var problem = problemAt({ root: { type: "array", key: "Rows", source: "rows",
    filterPath: "status", filterOperator: "in", filterValue: "",
    item: { type: "leaf", source: "$self" } } }, "FILTER_EMPTY_LIST");
  equal(problem.level, "error", "level");
});

test("validate: FILTER_NO_PATH warns that the filter is ignored", function () {
  var problem = problemAt({ root: { type: "array", key: "Rows", source: "rows",
    filterOperator: "exists", item: { type: "leaf", source: "$self" } } }, "FILTER_NO_PATH");
  equal(problem.level, "warn", "level");
});

test("validate: CONTAINER_EMPTY warns on an object with nothing inside", function () {
  var problem = problemAt({ root: { type: "object", children: [
    { type: "object", key: "Hollow", children: [] }
  ] } }, "CONTAINER_EMPTY");
  equal(problem.nodePath, "/Hollow", "nodePath");
});

/* An array's body is its item. Walking children as well reported every problem twice, the
   second copy at a path no rendered card matches. */
test("validate: an array's problems are reported once, not twice", function () {
  var problems = N.validate({ root: { type: "array", key: "Rows", source: "rows",
    item: { type: "object", children: [{ type: "leaf", key: "Broken" }] } } });
  var leafProblems = problems.filter(function (p) { return p.code === "LEAF_NO_VALUE"; });
  equal(leafProblems.length, 1, "expected one report, got " + leafProblems.length);
  equal(leafProblems[0].nodePath, "/(each item)/Broken", "nodePath");
});

test("validate: appendIndex alone counts as a value", function () {
  equal(codesFor({ root: { type: "object", children: [
    { type: "leaf", key: "Position", appendIndex: true }
  ] } }).indexOf("LEAF_NO_VALUE"), -1, "the position is a value in its own right");
});

test("validate: the shipped examples carry no errors", function () {
  var notes = [];
  EXAMPLES.forEach(function (name) {
    var errors = N.validate(load(name)).filter(function (p) { return p.level === "error"; });
    equal(errors.length, 0, name + " has errors: " +
      errors.map(function (e) { return e.code + " at " + e.nodePath; }).join(", "));
    notes.push(name.replace("example-", "").replace(".json", "") + " clean");
  });
  return notes.join(" · ");
});

/* ══ readings ══════════════════════════════════════════════════════════════════════════
   readings() keys the per-node readout the form shows, and its nodePath rule is duplicated in
   paintOutline and in validate. If the three ever disagree, values land on the wrong card and
   it looks like a data bug rather than a path bug. This is the join key the probe rests on. */

/** paintOutline's walk (tree-ui.js:521-523), reproduced exactly. */
function outlinePaths(config) {
  var paths = [];
  (function walk(node, nodePath) {
    if (!node) return;
    paths.push(nodePath);
    if (node.item) walk(node.item, nodePath + "/(each item)");
    (node.children || []).forEach(function (child, index) {
      walk(child, nodePath + "/" + (child.key || "[" + index + "]"));
    });
  })((config || {}).root, "");
  return paths;
}

EXAMPLES.forEach(function (name) {
  testAsync("readings: keys are exactly the outline's nodePaths — " + name, function () {
    var config = load(name);
    return jsonata(N.generate(config)).evaluate(envelope(SAMPLE_INPUT)).then(function (output) {
      var fromReadings = sorted(Object.keys(N.readings(config, output)));
      var fromOutline = sorted(outlinePaths(config));
      var missing = fromOutline.filter(function (p) { return fromReadings.indexOf(p) < 0; });
      var extra = fromReadings.filter(function (p) { return fromOutline.indexOf(p) < 0; });
      assert(!missing.length, "outline paths with no reading: " + missing.slice(0, 3).join(" · "));
      assert(!extra.length, "readings with no outline row: " + extra.slice(0, 3).join(" · "));
      return fromReadings.length + " nodePaths agree";
    });
  });
});

testAsync("readings: an array reports its count, pluralised", function () {
  var config = { root: { type: "array", key: "Rows", source: "rows",
    item: { type: "object", children: [{ type: "leaf", key: "Id", source: "id" }] } } };
  var expr = jsonata(N.generate(config));
  return expr.evaluate(envelope({ rows: [{ id: "A" }] })).then(function (one) {
    equal(N.readings(config, one)[""][0], "1 item", "singular");
    return expr.evaluate(envelope({ rows: [{ id: "A" }, { id: "B" }] }));
  }).then(function (two) {
    equal(N.readings(config, two)[""][0], "2 items", "plural");
  });
});

/* A list flattens N children into one array, so child i does NOT live at output[0]. The
   matcher picks the first element carrying that child's own keys. */
testAsync("readings: a list matches each child to the element carrying its keys", function () {
  var config = { root: { type: "list", key: "All", children: [
    { type: "array", key: "Alpha", source: "a",
      item: { type: "object", children: [{ type: "leaf", key: "AlphaId", source: "id" }] } },
    { type: "array", key: "Beta", source: "b",
      item: { type: "object", children: [{ type: "leaf", key: "BetaId", source: "id" }] } }
  ] } };
  var model = { a: [{ id: "a1" }], b: [{ id: "b1" }] };
  return jsonata(N.generate(config)).evaluate(envelope(model)).then(function (out) {
    var found = N.readings(config, out);
    equal(found["/Alpha/(each item)/AlphaId"][0], "a1", "alpha child");
    equal(found["/Beta/(each item)/BetaId"][0], "b1", "beta child");
  });
});

/* ══ the envelope contract ═════════════════════════════════════════════════════════════
   The mapper action always evaluates against { model, properties }. generate() only ever
   emits `model`; properties is reachable only through the raw escape hatches. These pin the
   binding rules the probe's envelope cases depend on. */

testAsync("envelope: generated expressions only ever read `model`", function () {
  EXAMPLES.forEach(function (name) {
    var expr = N.generate(load(name));
    assert(expr.indexOf("properties") < 0, name + " emits a properties reference");
    assert(expr.indexOf("model") >= 0, name + " never reads model");
  });
  return Promise.resolve("three examples");
});

testAsync("envelope: `model` resolves inside a $map lambda, but not inside a filter predicate", function () {
  var env = envelope({ rows: [{ id: "A" }], plant: "P1" });
  return Promise.all([
    /* A lambda does not rebind the context, so a bare reference still reaches the envelope. */
    jsonata('$map([model.rows], function($i, $x) { { "p": model.plant } })').evaluate(env),
    /* A predicate DOES rebind it to each element, so the bare reference finds nothing —
       this is the footgun the probe reports statically as FILTER_CONTEXT. */
    jsonata('(model.rows)[model.plant = "P1"]').evaluate(env),
    jsonata('(model.rows)[$$.model.plant = "P1"]').evaluate(env)
  ]).then(function (results) {
    /* One row in, so $map's singleton sequence collapses to the bare object — the same
       collapse the known() defect above is about, seen here in its harmless form. */
    equal(JSON.stringify(results[0]), '{"p":"P1"}', "bare model inside a lambda");
    equal(results[1], undefined, "bare model inside a predicate must resolve to nothing");
    equal(JSON.stringify(results[2]), '{"id":"A"}', "$$.model inside a predicate");
  });
});

testAsync("envelope: $$.properties reaches flow properties at every depth", function () {
  var env = envelope({ rows: [{ id: "A" }] });
  return jsonata('$map([model.rows], function($i, $x) { $$.properties.Existing[0].Id })')
    .evaluate(env).then(function (out) {
      assert(out !== undefined, "properties unreachable from inside a lambda");
    });
});

/* ══ summary ═══════════════════════════════════════════════════════════════════════════ */

Promise.all(pending).then(function () {
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
});
