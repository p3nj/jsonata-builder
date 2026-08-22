/* ══════════════════════════════════════════════════════════════════════════════════════
   Dynamic JSONata Mapping Generator — demo harness.

   Injected by build.mjs:
     window.__SAMPLE_INPUT__      mock system response
     window.__SAMPLE_NODES__      the mapping, as a node tree
     window.__SAMPLE_PROPERTIES__ mock flow properties

   This file is the harness: it owns the page state, the debounced evaluate loop and the
   panels. The mapping model lives in nodes.js (config -> JSONata, plus validation) and the
   form is drawn by tree-ui.js, which renders every level of the tree the same way. There is
   no schema-driven renderer any more, and no importer — the deliverable is the generated
   expression, copied out.
   ══════════════════════════════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var SAMPLE_INPUT = window.__SAMPLE_INPUT__;
  var SAMPLE_NODES = window.__SAMPLE_NODES__;
  var EXAMPLES = window.__EXAMPLES__ || [];
  var FLOW_PROPERTIES = window.__SAMPLE_PROPERTIES__ || {};

  var clone = function (v) { return JSON.parse(JSON.stringify(v)); };
  var $ = function (id) { return document.getElementById(id); };

  var versions = null;   // MappingHistory controller, wired in boot()

  var state = {
    inputText: JSON.stringify(SAMPLE_INPUT, null, 2),
    expr: "",
    data: clone(SAMPLE_NODES),
    collapsed: {},
    paths: [],
    arrayPaths: [],
    output: null,
    readings: {},        // nodePath -> what that node actually produced
    problems: [],        // validate() output, rendered on the node itself
    notes: [],
    stats: null,
    error: null,
    probe: null,         // the last completed fault-injection run
    probeStale: false,   // ...and whether the mapping has moved since
    probeStamp: null
  };

  var tree = null;       // MappingTreeUI controller, wired in boot()
  var probe = null;      // MappingProbeUI controller, wired in boot()

  /**
   * What the mapper action passes at run time, in one place. The literal used to appear twice
   * — the evaluate loop and the playground hand-off — and the fault-injection run would have
   * made three copies of a contract that has to be identical in all of them.
   */
  function envelope(model) {
    return { model: model, properties: Object.assign({ Mapping: state.data }, FLOW_PROPERTIES) };
  }

  function downloadJson(filename, value) {
    var blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    /* Revoking synchronously after click() races the download in Safari. */
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ── Data access by path ───────────────────────────────────────────────────────── */

  /* MappingTreeUI holds this object by reference, so replacing it would orphan the tree's
     copy and collapse state would never actually reset. */
  var actionsChanged = function () {};

  /** __id is assigned by the renderer for focus and collapse; it is not part of the mapping. */
  function strippedConfig() {
    return JSON.parse(JSON.stringify(state.data, function (key, value) {
      return key.indexOf("__") === 0 ? undefined : value;
    }));
  }

  /** Every container in the tree with the depth it renders at. */
  function containerNodes() {
    var out = [];
    (function walk(node, depth) {
      if (!node) return;
      if ((node.type || "leaf") !== "leaf" && node.__id) out.push({ id: node.__id, depth: depth });
      if (node.item) walk(node.item, depth + 1);
      (node.children || []).forEach(function (child) { walk(child, depth + 1); });
    })((state.data || {}).root, 0);
    return out;
  }

  /**
   * The renderer defaults an unrecorded node to OPEN — the merged tree is the only map of
   * the structure now, and a map that starts folded shows nothing. This must read the map
   * the same way, or the first click of the collapse button appears to do nothing.
   */
  function isNodeOpen(entry) {
    return entry.id in state.collapsed ? !state.collapsed[entry.id] : true;
  }

  /** The button says what clicking it will do, not what just happened. */
  function refreshCollapseLabel() {
    var button = $("btn-collapse");
    if (!button) return;
    var anyOpen = containerNodes().some(function (entry) {
      return entry.depth > 0 && isNodeOpen(entry);
    });
    button.textContent = anyOpen ? "Collapse all" : "Expand all";
  }

  function clearCollapsed() {
    Object.keys(state.collapsed).forEach(function (key) { delete state.collapsed[key]; });
  }





  /* ── Source-path discovery from the input JSON ─────────────────────────────────── */
  function discoverPaths(root) {
    var absolute = new Set();
    var arrays = new Set();

    function walk(node, prefix, relativeRoot) {
      if (Array.isArray(node)) {
        if (prefix) arrays.add(prefix);
        if (node.length) walk(node[0], prefix, true);
        return;
      }
      if (!node || typeof node !== "object") return;
      Object.keys(node).forEach(function (key) {
        var next = prefix ? prefix + "." + key : key;
        absolute.add(next);
        walk(node[key], next, false);
        if (relativeRoot) {
          // Paths relative to an array element — what an instance-scoped field uses.
          absolute.add(key);
          if (node[key] && typeof node[key] === "object" && !Array.isArray(node[key])) {
            Object.keys(node[key]).forEach(function (sub) { absolute.add(key + "." + sub); });
          }
        }
      });
    }

    walk(root, "", false);
    return {
      paths: Array.from(absolute).sort(),
      arrayPaths: Array.from(arrays).sort()
    };
  }

  function refreshDatalists() {
    var fill = function (id, values) {
      var list = $(id);
      list.textContent = "";
      values.forEach(function (value) {
        var option = document.createElement("option");
        option.value = value;
        list.appendChild(option);
      });
    };
    fill("paths-all", state.paths);
    fill("paths-array", instanceArrayPaths());
  }

  /** The repeating-array suggestions are relative to the outermost record. */
  function instanceArrayPaths() {
    var root = (((state.data || {}).root || {}).source || "").trim();
    if (!root) return state.arrayPaths;
    var prefix = root + ".";
    var relative = [];
    state.arrayPaths.forEach(function (path) {
      if (path.indexOf(prefix) === 0 && path.slice(prefix.length)) relative.push(path.slice(prefix.length));
    });
    return relative.length ? relative : state.arrayPaths;
  }

  /* ── Control rendering ─────────────────────────────────────────────────────────── */
  /**
   * Dropdowns showed raw code identifiers — "notExists", "notIn" — to an audience that is
   * explicitly not expected to read code. The stored VALUE is untouched (the generator reads
   * it); only the visible label changes.
   */






  var isExpressionKey = function (key) {
    return key === "expression" || /Expression$/.test(key);
  };






  /* An input that renames a value used as a key by other rows (a group or section
     identifier), carrying every field row that points at it along with the rename. */

  /* groups[] and fields[] are stored flat, side by side; this view rebuilds the
     tree from the group/section names each field row carries. */





  /* ── JSON highlighting ─────────────────────────────────────────────────────────── */
  function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function highlightJson(value) {
    var text = escapeHtml(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    return text.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      function (match) {
        var cls = "n";
        if (/^"/.test(match)) cls = /:$/.test(match) ? "k" : "s";
        else if (/true|false|null/.test(match)) cls = "l";
        return '<span class="' + cls + '">' + match + "</span>";
      }
    );
  }

  /**
   * One tokenising pass, not three sequential replaces: a second pass would match inside the
   * markup the first one just inserted — `class="c"` reads as a string — which produced
   * broken HTML and a displayed expression that no longer parsed.
   */
  function highlightJsonata(text) {
    return escapeHtml(text).replace(
      /(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*")|(\$[A-Za-z_][A-Za-z0-9_]*)/g,
      function (match, comment, str, variable) {
        if (comment) return '<span class="c">' + comment + "</span>";
        if (str) return '<span class="s">' + str + "</span>";
        return '<span class="k">' + variable + "</span>";
      }
    );
  }

  /* ── Diagnostics ───────────────────────────────────────────────────────────────── */
  /**
   * Generic counters and diagnostics. The old analyse() walked a hardcoded
   * Content.Groups[].Sections[].Fields[].Instances shape, so it silently stopped counting
   * the moment the payload shape changed — which is now the normal case.
   */
  function summarise(config, output) {
    var stats = { nodes: 0, values: 0, containers: 0, problems: 0, records: 0 };

    (function walk(node) {
      if (!node) return;
      stats.nodes++;
      if ((node.type || "leaf") === "leaf") stats.values++; else stats.containers++;
      if (node.item) walk(node.item);          // an array's element is a node too
      (node.children || []).forEach(walk);
    })((config || {}).root);

    stats.records = Array.isArray(output) ? output.length : output ? 1 : 0;
    stats.problems = (state.problems || []).length;

    var notes = (state.problems || []).map(function (problem) {
      return {
        level: problem.level === "error" ? "bad" : "warn",
        tag: problem.code.split("_")[0],
        text: (problem.nodePath || "(root)") + " — " + problem.message
      };
    });
    if (!notes.length) {
      notes.push({ level: "ok", tag: "OK", text: "Every node in the mapping produced a value against this response." });
    }
    return { notes: notes, stats: stats };
  }




  /* ── Evaluation ────────────────────────────────────────────────────────────────── */
  var timer = null;
  var runToken = 0;
  var lastRoot = null;

  /**
   * Every edit funnels through here, because setAt — the one writer of state.data — calls it.
   * Generating is string building over a small config, so it happens on the spot and the code
   * display is never a step behind the form. Only evaluating, which compiles the expression and
   * walks the whole example input, is worth debouncing.
   */
  function notifyChange() {
    try {
      state.problems = MappingNodes.validate(state.data);
      state.expr = MappingNodes.generate(state.data);
    } catch (error) {
      state.error = "Could not generate the mapping — " + (error.message || String(error));
      paintOutput();
      return;
    }
    paintExpression();
    actionsChanged();

    /* The array suggestions are relative to the outermost record, so they go stale the moment
       that record's own path changes. */
    var root = (((state.data || {}).root || {}).source || "");
    if (root !== lastRoot) { lastRoot = root; refreshDatalists(); }

    scheduleEvaluate();
    /* Any edit invalidates a run in flight, and ages a finished one. Both are cheap; the sweep
       itself waits for the page to go quiet. */
    cancelProbe();
    markProbeStale();
    scheduleProbe("standard");
    if (versions) versions.notifyChange();
  }

  function scheduleEvaluate() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(evaluate, 220);
  }

  /* The direct-mutation call sites — the section rename, the input editor, reset — do not go
     through setAt, so they say so themselves. */
  function scheduleRun() { notifyChange(); }

  /* Import and history restore replace state.data wholesale and want the result immediately. */
  function run() { notifyChange(); evaluate(); }

  function evaluate() {
    if (timer) { clearTimeout(timer); timer = null; }
    /* An evaluation that is already in flight when the next edit lands must not paint over the
       newer one when it finally resolves. */
    var token = ++runToken;
    var model;
    try {
      model = JSON.parse(state.inputText);
    } catch (error) {
      state.error = "Source response is not valid JSON — " + error.message;
      paintOutput();
      render();
      return;
    }


    var expression;
    try {
      expression = jsonata(state.expr);
    } catch (error) {
      state.error = "JSONata will not compile — " + error.message + (error.position ? " (position " + error.position + ")" : "");
      paintOutput();
      render();
      return;
    }

    expression
      .evaluate(envelope(model))
      .then(function (output) {
        if (token !== runToken) return;
        state.error = null;
        state.output = output === undefined ? {} : output;
        state.readings = MappingNodes.readings(state.data, state.output);
        var report = summarise(state.data, state.output);
        state.notes = report.notes;
        state.stats = report.stats;
        paintOutput();
        render();          // repaint so every node shows what it just produced
      })
      .catch(function (error) {
        if (token !== runToken) return;
        state.error = "Evaluation failed — " + (error.message || String(error));
        paintOutput();
        render();
      });
  }

  /* ── Fault injection ───────────────────────────────────────────────────────────────
     A sweep is seconds, not milliseconds, so unlike evaluate() it must not be allowed to land
     on a mapping that has moved underneath it — results naming fields that no longer exist are
     worse than no results. The token is checked BETWEEN CHUNKS as well as at the end, so a
     cancelled run stops burning CPU rather than merely being ignored when it finishes. */
  var probeToken = 0;
  var probeTimer = null;
  /* Stopping and being cancelled are not the same event. An edit invalidates the run outright,
     because its findings name a mapping that has moved. Pressing Stop is a person saying "that
     is enough" — what was found so far is still about the mapping in front of them, so it is
     kept and labelled partial rather than thrown away. */
  var probeStopped = false;

  /* Long enough that it does not fire between keystrokes, short enough that it feels like the
     page noticing rather than a job you started. evaluate() debounces at 220ms; this is the
     same idea an order of magnitude out, because the work is an order of magnitude bigger. */
  var PROBE_IDLE = 1500;

  /** Two mappings are the same run if the config AND the example input are unchanged. */
  function probeStamp() {
    return JSON.stringify(strippedConfig()) + "\u0000" + state.inputText;
  }

  function cancelProbe() {
    probeToken++;
    probeStopped = false;
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    if (probe) probe.setRunning(false, null);
  }

  /** Stop where it is, but commit what it found. */
  function stopProbe() {
    probeStopped = true;
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
  }

  /* A completed run is never thrown away, only marked stale — the same stance the output pane
     takes on a failed evaluation. "This field broke last time you checked" is still true. */
  function markProbeStale() {
    if (!state.probe) return;
    var moved = probeStamp() !== state.probeStamp;
    if (moved === state.probeStale) return;
    state.probeStale = moved;
    if (probe) probe.setStale(moved);
    render();
  }

  function scheduleProbe(tier) {
    if (!window.MappingProbe || !probe) return;
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = setTimeout(function () { runProbe(tier || "standard"); }, PROBE_IDLE);
  }

  function runProbe(tier) {
    if (!window.MappingProbe || !probe) return;
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    var token = ++probeToken;
    probeStopped = false;

    var model, compiled;
    try { model = JSON.parse(state.inputText); } catch (error) { return; }
    try { compiled = jsonata(state.expr); } catch (error) { return; }

    var context = envelope(model);
    var stamp = probeStamp();
    var planned;
    try {
      planned = MappingProbe.plan(state.data, {
        model: model, properties: context.properties, tier: tier || "standard"
      });
    } catch (error) { return; }

    probe.setRunning(true, { done: 0, total: planned.cases.length });

    MappingProbe.run({
      config: state.data,
      compiled: compiled,
      model: model,
      properties: context.properties,
      cases: planned.cases,
      deps: planned.deps,
      /* Two dozen cases is about 25ms of work — under a frame, so Stop still feels instant —
         while cutting the number of yields, and therefore the yield overhead, by two thirds. */
      chunk: 24,
      onProgress: function (done, total) {
        if (token !== probeToken) return;
        /* Only the counter moves per chunk. Repainting the tree here would rebuild every card
           and re-run the focus capture eight times a second. */
        probe.setRunning(true, { done: done, total: total });
      },
      shouldStop: function () { return token !== probeToken || probeStopped; }
    }).then(function (result) {
      if (token !== probeToken) return;
      result.planned = planned;
      state.probe = result;
      state.probeStamp = stamp;
      state.probeStale = false;
      probe.setRunning(false, null);
      probe.setRun(result);
      /* Once, at the end — this is what puts the marks on the cards. */
      render();
    }).catch(function () {
      if (token !== probeToken) return;
      probe.setRunning(false, null);
    });
  }

  /**
   * The run's findings, in the shape validate() returns — which is the whole reason the engine
   * emits that shape. tree-ui.js filters problems by nodePath and paints them onto the node,
   * so a fault-injection finding lands on the right card with no renderer change at all.
   *
   * Deduplicated hard, because one field can fail under a dozen cases and a card carrying a
   * dozen near-identical sentences is a card nobody reads. One line per KIND of failure, with
   * the case count when there is more than one.
   */
  function probeProblems() {
    if (!state.probe) return [];
    var seen = {};
    var out = [];

    function add(nodePath, code, level, message) {
      var key = nodePath + "\u0001" + code;
      if (seen[key]) { seen[key].count++; return; }
      var entry = { level: level, code: code, nodePath: nodePath, message: message, count: 1 };
      seen[key] = entry;
      out.push(entry);
    }

    (state.probe.findings || []).forEach(function (f) {
      if (f.severity === "pass") return;
      add(f.nodePath, f.code, f.level || "warn", f.message);
    });
    (state.probe.results || []).forEach(function (r) {
      if (r.severity === "pass") return;
      add(r.nodePath, r.code, r.level, r.message);
    });

    return out.map(function (entry) {
      return {
        level: entry.level,
        code: entry.code,
        nodePath: entry.nodePath,
        message: entry.count > 1
          ? entry.message + " (and " + (entry.count - 1) + " more like it)"
          : entry.message
      };
    });
  }

  /* ── Flow properties ───────────────────────────────────────────────────────────────
     Nothing in the vocabulary names a flow property: the only route from a mapping to one is a
     hand-written $$.properties.X, which is why isExpressionKey has sat here unused since the
     model changed. So the dependency list is a scan, and the ticks below exist only to correct
     what the scan cannot see — a property whose name is assembled at run time, say. */

  function requiredProperties() {
    var declared = ((state.data || {}).probe || {}).properties || {};
    var optional = declared.optional || [];
    var discovered = window.MappingProbe ? MappingProbe.discoverProperties(state.data) : {};
    var names = Object.keys(discovered);
    (declared.required || []).forEach(function (name) {
      if (names.indexOf(name) < 0) names.push(name);
    });
    return names.sort().map(function (name) {
      return {
        name: name,
        usedBy: discovered[name] || [],
        /* Discovered-but-undeclared defaults to required: the probe then generates the
           absence case, and a mapping that genuinely tolerates it just collects a pass. */
        required: optional.indexOf(name) < 0,
        present: Object.prototype.hasOwnProperty.call(FLOW_PROPERTIES, name)
      };
    });
  }

  function setPropertyRequired(name, required) {
    state.data.probe = state.data.probe || {};
    var slot = state.data.probe.properties = state.data.probe.properties || {};
    slot.optional = (slot.optional || []).filter(function (n) { return n !== name; });
    slot.required = (slot.required || []).filter(function (n) { return n !== name; });
    (required ? slot.required : slot.optional).push(name);
    paintProperties();
    scheduleRun();
  }

  function paintProperties() {
    var box = $("properties-required");
    var json = $("properties-json");
    if (json) json.innerHTML = highlightJson(FLOW_PROPERTIES);
    if (!box) return;
    box.textContent = "";

    var list = requiredProperties();
    var head = document.createElement("div");
    head.className = "card__meta";
    head.textContent = list.length
      ? "Required by this mapping"
      : "This mapping does not read any flow properties.";
    box.appendChild(head);

    list.forEach(function (entry) {
      var row = document.createElement("div");
      row.className = "proprow";

      var tick = document.createElement("input");
      tick.type = "checkbox";
      tick.checked = entry.required;
      tick.title = "Test what happens when this property is not set";
      tick.addEventListener("change", function () { setPropertyRequired(entry.name, tick.checked); });
      row.appendChild(tick);

      row.appendChild(Object.assign(document.createElement("span"), {
        className: "proprow__name", textContent: entry.name
      }));
      row.appendChild(Object.assign(document.createElement("span"), {
        className: "card__meta",
        textContent: entry.usedBy.length
          ? entry.usedBy.length + " field" + (entry.usedBy.length === 1 ? "" : "s")
          : "added by hand"
      }));

      /* Referenced but absent from the properties the flow actually passes — worth saying
         before any test runs, because it is already broken. */
      if (!entry.present) {
        row.appendChild(Object.assign(document.createElement("span"), {
          className: "note note--bad", textContent: "not in the properties above"
        }));
      }

      if (entry.usedBy.length) {
        var go = document.createElement("button");
        go.type = "button";
        go.className = "btn btn--ghost btn--tiny";
        go.textContent = "Show me";
        go.addEventListener("click", function () { if (tree) tree.revealPath(entry.usedBy[0]); });
        row.appendChild(go);
      }
      box.appendChild(row);
    });
  }

  /* ── Playground hand-off ───────────────────────────────────────────────────────────
     Seeded from a failing case rather than from the happy path, so what opens is the exact
     envelope that broke the field. The injured input is rebuilt here on demand: a run holds
     hundreds of cases, and retaining a deep clone of the response for each one is how this
     feature would run the tab out of memory. */
  function openInPlayground(row) {
    if (!window.MappingPlayground || !window.MappingProbe) return;
    var model;
    try { model = JSON.parse(state.inputText); } catch (error) { model = {}; }
    var injured = row && row.mutation
      ? MappingProbe.applyCase(row.mutation, envelope(model))
      : envelope(model);
    var opened = MappingPlayground.open({
      expression: state.expr,
      input: JSON.stringify(injured, null, 2),
      title: "JSONata playground — " + (row && row.label ? row.label : "generated mapping")
    });
    if (!opened.ok) {
      var status = $("output-status");
      status.className = "status is-bad";
      status.textContent = opened.message;
    }
  }

  /**
   * The run, as a committed regression pack. What is written down is each case's VERDICT, not
   * the payload it produced — so the file stays reviewable, its diff stays proportional to the
   * change, and a case that silently turns from "only the fields reading it are affected" into
   * "damages something else" cannot slip past.
   */
  function testReport() {
    var run = state.probe;
    if (!run || !window.MappingProbe) return { kind: "jsonata-mapping-suite", version: 1, cases: [] };
    var model;
    try { model = JSON.parse(state.inputText); } catch (error) { model = null; }
    return MappingProbe.toSuite(strippedConfig(), run.planned, run, {
      tier: run.planned && run.planned.tier,
      model: model,
      properties: FLOW_PROPERTIES,
      modelSource: "parts/sample-input.json",
      propertiesSource: "parts/sample-properties.json"
    });
  }

  /* One row's resolved value. Absent from the index means the row produced nothing, which
     is the failure the old UI left completely silent. */


  function paintOutput() {
    var status = $("output-status");
    var banner = $("output-banner");

    if (state.error) {
      /* Blanking the payload, the counters AND the diagnostics on any error meant one bad
         character wiped the whole right-hand side, leaving an 11px message at the very
         bottom edge as the only clue. The last good result stays, marked stale. */
      if (banner) {
        banner.className = "banner banner--bad";
        banner.textContent = state.error;
      }
      status.className = "status is-bad";
      status.textContent = state.error;
      $("output-json").classList.add("is-stale");
      return;
    }

    if (banner) { banner.className = "banner hidden"; banner.textContent = ""; }
    $("output-json").classList.remove("is-stale");

    var stats = state.stats || {};
    status.className = "status";
    status.innerHTML =
      "<span><b>" + stats.records + "</b> records</span>" +
      "<span class='p'>·</span><span><b>" + stats.nodes + "</b> nodes</span>" +
      "<span class='p'>·</span><span><b>" + stats.values + "</b> values</span>" +
      "<span class='p'>·</span><span><b>" + stats.containers + "</b> containers</span>" +
      "<span class='p'>·</span><span><b>" + stats.problems + "</b> problems</span>";

    $("output-json").innerHTML = highlightJson(state.output);
    var folded = $("output-collapsed-summary");
    if (folded) {
      folded.textContent = stats.records + " records · " + stats.problems + " problems";
      folded.className = "card__meta" + (stats.problems ? " is-bad" : "");
    }

    $("output-stats").innerHTML =
      ["records", "nodes", "values", "containers", "problems"].map(function (key) {
        return "<div class='stat'><b>" + (stats[key] || 0) + "</b><span>" + key + "</span></div>";
      }).join("");

    $("output-notes").innerHTML = state.notes.map(function (note) {
      return "<div class='note note--" + note.level + "'><span class='note__tag'>" + note.tag + "</span><span>" +
        escapeHtml(note.text).replace(/“([^”]*)”/g, "<code>$1</code>") + "</span></div>";
    }).join("");
  }

  /* ── Painting the static panels ────────────────────────────────────────────────── */
  /* The generated expression is the deliverable — what goes into the config var the
     mapping component reads. */
  function paintExpression() {
    var painted = highlightJsonata(state.expr);
    ["expr-view", "expr-view-2"].forEach(function (id) {
      var node = $(id);
      if (node) node.innerHTML = painted;
    });
    $("expr-size").textContent = state.expr.split("\n").length + " lines";
  }

  /* One recursive renderer for every level. The old path built a hardcoded header block
     from UISCHEMA plus a bespoke groups composite; both are gone. */
  function render() {
    if (!tree) return;
    tree.paint();
    refreshCollapseLabel();
    /* The required-property list is derived from the mapping by scanning it, so it goes stale
       the moment the mapping changes — importing one that reads a property it never had, most
       obviously. */
    paintProperties();
    if (probe) probe.paint();
  }

  /**
   * A mapping that no longer exists cannot have test results. The example picker, import and
   * clear all replace state.data wholesale, and results keyed to the previous tree would keep
   * marking cards that are gone.
   */
  function resetProbe() {
    cancelProbe();
    state.probe = null;
    state.probeStale = false;
    state.probeStamp = null;
    if (probe) probe.clear();
  }

  /* ── Copy buttons ──────────────────────────────────────────────────────────────── */
  /**
   * Copying has to survive a sandboxed iframe. The async Clipboard API is gated behind a
   * permissions policy the artifact host does not grant, so it rejects there; the old
   * execCommand path still works inside a user gesture. If both fail, the text is put in a
   * textarea and selected, so ⌘C / Ctrl+C finishes the job.
   */
  function writeViaTextarea(text) {
    var scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.position = "fixed";
    scratch.style.top = "0";
    scratch.style.left = "0";
    scratch.style.width = "1px";
    scratch.style.height = "1px";
    scratch.style.opacity = "0";
    document.body.appendChild(scratch);

    var selection = document.getSelection();
    var previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    scratch.focus();
    scratch.select();
    scratch.setSelectionRange(0, text.length);

    var copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (error) {
      copied = false;
    }

    document.body.removeChild(scratch);
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
    return copied;
  }

  /** Last resort: show the text selected so the keyboard shortcut can take it. */
  function offerManualCopy(text) {
    var host = $("manual-copy");
    var field = $("manual-copy-text");
    field.value = text;
    host.classList.remove("hidden");
    field.focus();
    field.select();
  }

  function copyToClipboard(text, button) {
    /* Remember the real label once: clicking again while "Copied" is showing would
       otherwise capture that as the label and leave the button stuck on it. */
    if (!button.dataset.label) button.dataset.label = button.textContent;
    var restore = button.dataset.label;
    if (button.dataset.timer) clearTimeout(Number(button.dataset.timer));

    var settle = function (message, ok) {
      button.textContent = message;
      button.classList.toggle("is-copied", ok);
      button.dataset.timer = String(setTimeout(function () {
        button.textContent = restore;
        button.classList.remove("is-copied");
        delete button.dataset.timer;
      }, 1600));
    };

    var fallback = function () {
      if (writeViaTextarea(text)) {
        settle("Copied", true);
      } else {
        offerManualCopy(text);
        settle("Press " + (/Mac|iP(hone|ad)/.test(navigator.platform) ? "⌘C" : "Ctrl+C"), false);
      }
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { settle("Copied", true); }, fallback);
    } else {
      fallback();
    }
  }

  /**
   * Each panel that holds something you paste somewhere else gets its own copy button,
   * pinned to the top of that panel so it stays reachable while the content scrolls.
   */
  function addCopyButtons() {
    var panels = [
      { id: "panel-properties", label: "Copy flow properties", get: function () { return JSON.stringify(FLOW_PROPERTIES, null, 2); } },
      { id: "panel-expr", label: "Copy generated JSONata", get: function () { return state.expr; } },
      { id: "panel-source", label: "Copy generated JSONata", get: function () { return state.expr; } },
      { id: "panel-tests", label: "Copy test report", get: function () { return probe ? probe.asText() : ""; } }
    ];

    panels.forEach(function (panel) {
      var host = $(panel.id);
      if (!host) return;
      var bar = document.createElement("div");
      bar.className = "copybar";
      var button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn--tiny";
      button.textContent = panel.label;
      button.addEventListener("click", function () { copyToClipboard(panel.get(), button); });
      bar.appendChild(button);
      host.insertBefore(bar, host.firstChild);
    });
  }





  /* ── Tabs ──────────────────────────────────────────────────────────────────────── */
  function wireTabs(stripId) {
    var strip = $(stripId);
    strip.addEventListener("click", function (event) {
      var tab = event.target.closest(".tab");
      if (!tab) return;
      Array.prototype.forEach.call(strip.querySelectorAll(".tab"), function (other) {
        var selected = other === tab;
        other.setAttribute("aria-selected", String(selected));
        var panel = $(other.dataset.panel);
        if (panel) panel.classList.toggle("hidden", !selected);
      });
    });
  }

  /* ── Boot ──────────────────────────────────────────────────────────────────────── */
  function boot() {
    var input = $("input-editor");
    input.value = state.inputText;
    input.addEventListener("input", function () {
      state.inputText = input.value;
      try {
        var discovered = discoverPaths(JSON.parse(state.inputText));
        state.paths = discovered.paths;
        state.arrayPaths = discovered.arrayPaths;
        refreshDatalists();
      } catch (error) { /* keep the previous suggestions until the JSON parses again */ }
      scheduleRun();
    });

    tree = MappingTreeUI.create({
      host: $("form-host"),
      getConfig: function () { return state.data; },
      getReadings: function () { return state.readings; },
      /* validate()'s problems and the run's findings, together — they are the same shape and
         the same question ("what is wrong with this field"), so the form draws them the same
         way and the reader never has to know which layer noticed. */
      getProblems: function () { return state.problems.concat(probeProblems()); },
      /* The fault-injection marks, per field and per branch. Guarded rather than assumed:
         build.mjs filters out a missing part file, so the page has to survive probe.js not
         being in it at all. */
      getRisk: function (path) { return probe ? probe.riskFor(path) : null; },
      getRiskBranch: function (path) { return probe ? probe.riskBranch(path) : null; },
      onRiskClick: function (path) {
        var tab = document.querySelector('#config-tabs [data-panel="panel-tests"]');
        if (tab) tab.click();
        /* The badge asked one question — what is wrong with this field — so the report opens
           on the answer rather than on three hundred cases the reader has to search. */
        if (probe) probe.focus(path);
      },
      collapsed: state.collapsed,
      /* A value edit only needs the expression regenerated; adding or removing a node needs
         the form rebuilt as well. */
      onChange: function () { scheduleRun(); },
      onStructureChange: function () { render(); scheduleRun(); }
    });

    /* Import always works — there is nothing to lose when the mapping is empty. Export and
       Clear only mean something once there IS a mapping, so they are disabled until then
       rather than failing quietly. */
    function hasContent() {
      var root = (state.data || {}).root;
      return !!(root && ((root.children || []).length || root.item));
    }
    function refreshActions() {
      var on = hasContent();
      ["btn-export-config", "btn-clear"].forEach(function (id) {
        var button = $(id);
        if (!button) return;
        button.disabled = !on;
        button.title = on
          ? (id === "btn-clear" ? "Remove everything and start from an empty mapping"
                                : "Download this mapping as a JSON file")
          : "Nothing to " + (id === "btn-clear" ? "clear" : "export") + " — the mapping is empty";
      });
    }
    actionsChanged = refreshActions;

    $("btn-export-config").addEventListener("click", function () {
      if (!hasContent()) return;
      downloadJson("mapping.json", strippedConfig());
    });

    /* Worked examples, so the model can be learned by reading one rather than guessed at. */
    var picker = $("example-picker");
    var lead = document.createElement("option");
    lead.value = "";
    lead.textContent = "Load an example…";
    picker.appendChild(lead);
    EXAMPLES.forEach(function (example) {
      var option = document.createElement("option");
      option.value = example.id;
      option.textContent = example.name;
      option.title = example.blurb;
      picker.appendChild(option);
    });
    picker.addEventListener("change", function () {
      var chosen = EXAMPLES.filter(function (e) { return e.id === picker.value; })[0];
      if (!chosen) { picker.value = ""; return; }
      /* Only warn when there is actual work to lose. Swapping between untouched examples —
         the whole point of a picker — should not put a modal in the way. Confirm BEFORE
         resetting the control, so cancelling leaves the box showing what is loaded. */
      picker.value = "";
      /* No modal: the current mapping is snapshotted first, so switching examples is always
         recoverable from History. Comparing against the shipped files to decide whether to
         warn was unreliable anyway — the renderer assigns ids, so a freshly loaded example
         never matches its own file. */
      if (versions && hasContent()) versions.save("Before loading " + chosen.name);
      state.data = clone(chosen.config);
      resetProbe();
      state.inputText = JSON.stringify(SAMPLE_INPUT, null, 2);
      $("input-editor").value = state.inputText;
      clearCollapsed();
      state.error = null;
      render();
      run();
      if (versions) versions.save("Loaded example: " + chosen.name);
    });

    $("btn-import-config").addEventListener("click", function () { $("import-file").click(); });

    $("import-file").addEventListener("change", function (event) {
      var file = event.target.files && event.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var incoming;
        try { incoming = JSON.parse(String(reader.result)); }
        catch (error) {
          state.error = "That file is not valid JSON — " + error.message;
          paintOutput();
          return;
        }
        /* Refused rather than half-loaded: a file without a root is not a mapping this
           builder produced, and quietly replacing the tree with an empty one is worse
           than saying so. */
        if (!incoming || typeof incoming !== "object" || !incoming.root) {
          state.error = "That file is not a mapping — it has no root node.";
          paintOutput();
          return;
        }
        state.data = incoming;
        resetProbe();
        clearCollapsed();
        state.error = null;
        render();
        run();
        if (versions) versions.save("Imported " + file.name);
      };
      reader.readAsText(file);
      event.target.value = "";      // so re-picking the same file fires again
    });

    $("btn-clear").addEventListener("click", function () {
      if (!hasContent()) return;
      if (!window.confirm("Remove every node and start from an empty mapping?")) return;
      state.data = { root: { type: "object", children: [] } };
      resetProbe();
      clearCollapsed();
      render();
      run();
      if (versions) versions.save("Cleared");
    });

    $("btn-output-collapse").addEventListener("click", function () {
      var bench = document.querySelector(".workbench");
      var collapsed = bench.classList.toggle("output-collapsed");
      var button = $("btn-output-collapse");
      button.textContent = collapsed ? "▲" : "▼";
      button.setAttribute("aria-expanded", String(!collapsed));
      button.title = collapsed ? "Show the result" : "Hide the result to give the form more room";
    });

    $("btn-input-collapse").addEventListener("click", function () {
      var bench = document.querySelector(".workbench");
      var collapsed = bench.classList.toggle("input-collapsed");
      var button = $("btn-input-collapse");
      button.textContent = collapsed ? "▶" : "◀";
      button.setAttribute("aria-expanded", String(!collapsed));
      button.title = collapsed ? "Show the example input" : "Hide the example input to give the form more room";
    });

    if (window.MappingProbeUI && window.MappingProbe) {
      probe = MappingProbeUI.create({
        host: $("probe-host"),
        onRun: function (tier) { runProbe(tier); },
        onStop: function () { stopProbe(); },
        onExport: function () { downloadJson("mapping-tests.json", testReport()); },
        onReveal: function (nodePath) { if (tree) tree.revealPath(nodePath); },
        onPlayground: function (row) { openInPlayground(row); }
      });
      probe.paint();
    } else {
      /* build.mjs silently drops a part file that is not on disk, so the page has to be honest
         about a Tests tab that cannot do anything rather than sit there looking broken. */
      var host = $("probe-host");
      if (host) {
        var note = document.createElement("div");
        note.className = "banner banner--warn";
        note.textContent = "The test engine is not built into this page.";
        host.appendChild(note);
      }
    }

    paintProperties();
    wireTabs("config-tabs");
    wireTabs("output-tabs");


    $("btn-collapse").addEventListener("click", function () {
      var nodes = containerNodes();
      /* Collapse if anything below the root is open, otherwise expand. The root itself stays
         open so the form never goes completely blank. */
      var anyOpen = nodes.some(function (entry) { return entry.depth > 0 && isNodeOpen(entry); });
      nodes.forEach(function (entry) {
        state.collapsed[entry.id] = entry.depth === 0 ? false : anyOpen;
      });
      render();
    });

    if (window.MappingHistory) {
      versions = MappingHistory.init({
        getConfig: function () { return state.data; },
        setConfig: function (config) { state.data = config; },
        getExpression: function () { return state.expr; },
        onRestore: function () {
          clearCollapsed();
          state.expanded = {};
          render();
          run();
        }
      });
      versions.renderInto("history-host");
    }

    addCopyButtons();

    $("btn-playground").addEventListener("click", function () {
      if (!window.MappingPlayground) return;
      /* Seed the same context run() evaluates against: the generated expression reads
         model.… and $$.properties.…, so the bare source JSON alone would not work. */
      openInPlayground(null);
    });

    $("manual-copy-close").addEventListener("click", function () {
      $("manual-copy").classList.add("hidden");
    });

    Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"), function (button) {
      button.addEventListener("click", function () {
        var kind = button.dataset.copy;
        var payload = kind === "output"
          ? JSON.stringify(state.output, null, 2)
          : state.expr;
        copyToClipboard(payload, button);
      });
    });

    var discovered = discoverPaths(SAMPLE_INPUT);
    state.paths = discovered.paths;
    state.arrayPaths = discovered.arrayPaths;
    refreshDatalists();
    render();
    run();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
