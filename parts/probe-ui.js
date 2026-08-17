/* ══════════════════════════════════════════════════════════════════════════════════════
   probe-ui.js — the Tests panel, and the index the form's badges read.

   probe.js decides what is broken; this decides how a person finds out. Two surfaces, and the
   panel is the lesser of them: a report you have to cross-reference by hand against a 214-node
   form is a report nobody reads twice. The badge on the card you are editing is the product.
   So this module owns the INDEX — one lookup from nodePath to "how bad is this field" — and
   the tree renderer asks it rather than walking results itself.

   Layout below is deliberately the page's own vocabulary: .stat for the summary, .note for a
   verdict, .btn--tiny for the chips. A test report that looks like a different application
   reads as a different application.

   UMD like history.js, with document injectable so it can be exercised headlessly.
   ══════════════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MappingProbeUI = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* One group's rows are capped, because a run over a large mapping can produce hundreds of
     cases in a single verdict and the browser is the one that pays. history.js caps its diff
     the same way and for the same reason. */
  var ROW_CAP = 200;

  /* Worst first. The order is the order someone should read them in. */
  var ORDER = ["blocker", "high", "medium", "low", "pass"];

  var GROUPS = {
    blocker: { label: "Breaks the whole payload", tone: "bad" },
    /* Not "breaks other fields": this bucket also holds fields that are already broken against
       the healthy response, and a group heading that misdescribes its own contents is how a
       reader learns to distrust the rest. */
    high: { label: "Badly broken", tone: "bad" },
    medium: { label: "Quietly wrong", tone: "warn" },
    low: { label: "Worth a look", tone: "warn" },
    pass: { label: "Holds up", tone: "ok" }
  };

  /* What each verdict means, in the words of someone who did not write the engine. */
  var CODES = {
    THROWS: "the whole payload is lost",
    PAYLOAD_COLLAPSE: "the payload comes out empty",
    CARDINALITY: "stops being a list",
    COLLATERAL: "damages a field that does not read it",
    LIST_SHRINKS: "rows disappear silently",
    SILENT_SUBSTITUTION: "reads the wrong record",
    ARTEFACT: "emits something that is not data",
    EXPECTED_ABSENCE: "only the fields reading it are affected",
    NO_EFFECT: "nothing changes",
    DEAD_AT_BASELINE: "produces nothing even before anything is injured",
    COVERAGE_GAP: "cannot be tested",
    FILTER_CONTEXT: "a filter that finds nothing",
    NON_DETERMINISTIC: "changes every run",
    BASELINE_THROWS: "the mapping does not run at all"
  };

  function create(options) {
    var doc = options.document || document;
    var host = options.host;
    var onRun = options.onRun || function () {};
    var onStop = options.onStop || function () {};
    var onExport = options.onExport || function () {};
    var onReveal = options.onReveal || function () {};
    var onPlayground = options.onPlayground || function () {};

    var state = {
      run: null,          // { results, findings, planned, stopped, ms }
      stale: false,
      running: false,
      progress: null,     // { done, total }
      filter: null,       // a severity, or null for "everything that is not a pass"
      focusPath: null,    // set by clicking a badge on the form: show only that field's cases
      open: {},           // caseId -> expanded
      expandedGroups: {},
      indexed: {},        // nodePath -> { fail, warn, broken, stale }
      branch: {}          // nodePath -> the same, summed over the branch
    };

    function el(tag, cls, text) {
      var node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function button(label, cls, onClick) {
      var b = el("button", cls || "btn btn--tiny", label);
      b.type = "button";
      b.addEventListener("click", onClick);
      return b;
    }

    /* ── the index the form reads ────────────────────────────────────────────────────── */

    /**
     * Results are a flat list keyed by case; the form needs the opposite shape, keyed by field,
     * and it needs it for every repaint of every card. Building it once per run rather than
     * scanning the list per card is the difference between a repaint and a stall.
     */
    function reindex() {
      state.indexed = {};
      state.branch = {};
      if (!state.run) return;

      function bump(map, path, entry) {
        var slot = map[path] || (map[path] = { fail: 0, warn: 0, broken: 0, stale: state.stale });
        slot.fail += entry.fail;
        slot.warn += entry.warn;
        slot.broken += entry.broken;
        slot.stale = state.stale;
      }

      var rows = [];
      (state.run.findings || []).forEach(function (f) {
        if (f.severity === "pass") return;
        rows.push({ nodePath: f.nodePath, fail: f.level === "error" ? 1 : 0, warn: f.level === "error" ? 0 : 1, broken: 0 });
      });
      (state.run.results || []).forEach(function (r) {
        if (r.severity === "pass") return;
        /* Collateral is counted separately: "something else broke me" is a different problem
           from "I break", and a field that is only ever collateral damage is not at fault. */
        var broken = r.code === "COLLATERAL" ? 1 : 0;
        rows.push({
          nodePath: r.nodePath, broken: broken,
          fail: !broken && r.level === "error" ? 1 : 0,
          warn: !broken && r.level !== "error" ? 1 : 0
        });
      });

      rows.forEach(function (row) {
        bump(state.indexed, row.nodePath, row);
        /* Every ancestor carries it too, so a collapsed card can say that something inside it
           is broken without the reader having to open every branch to find out. */
        var parts = String(row.nodePath).split("/");
        bump(state.branch, row.nodePath, row);
        while (parts.length > 1) {
          parts.pop();
          bump(state.branch, parts.join("/"), row);
        }
      });
    }

    function riskFor(nodePath) { return state.indexed[nodePath] || null; }
    function riskBranch(nodePath) { return state.branch[nodePath] || null; }

    /* ── grouping ────────────────────────────────────────────────────────────────────── */

    function allRows() {
      if (!state.run) return [];
      var findings = (state.run.findings || []).map(function (f) {
        return {
          caseId: "static-" + f.code + "-" + f.nodePath, nodePath: f.nodePath, code: f.code,
          severity: f.severity || "medium", message: f.message, label: null, mutation: null
        };
      });
      return findings.concat(state.run.results || []);
    }

    function grouped() {
      var buckets = {};
      allRows().forEach(function (row) {
        /* Arriving from a badge on the form means one question: what is wrong with THIS field.
           Everything under it counts too — a container's badge is about its branch. */
        if (state.focusPath !== null) {
          var path = row.nodePath || "";
          if (path !== state.focusPath && path.indexOf(state.focusPath + "/") !== 0) return;
        }
        var severity = row.severity || "low";
        (buckets[severity] = buckets[severity] || []).push(row);
      });
      return buckets;
    }

    /* ── painting ────────────────────────────────────────────────────────────────────── */

    function paintToolbar(bar) {
      bar.textContent = "";
      if (state.running) {
        bar.appendChild(button("Stop", "btn btn--tiny", function () { onStop(); }));
      } else {
        bar.appendChild(button(state.run ? "Run again" : "Run tests", "btn btn--tiny",
          function () { onRun("standard"); }));
        bar.appendChild(button("Run every case", "btn btn--tiny", function () { onRun("paranoid"); }));
      }

      if (state.focusPath !== null) {
        bar.appendChild(button("Showing one field — show all", "btn btn--tiny", function () {
          state.focusPath = null;
          paint();
        }));
      }

      var spacer = el("div");
      spacer.style.flex = "1";
      bar.appendChild(spacer);

      if (state.run) {
        var blockers = (state.run.results || []).filter(function (r) { return r.severity === "blocker"; });
        if (blockers.length) {
          /* The single most useful control in the panel: the first thing that is actually
             broken, one click away, in the form where it can be fixed. */
          bar.appendChild(button("Go to first failure", "btn btn--tiny", function () {
            onReveal(blockers[0].nodePath);
          }));
        }
        var exportBtn = button("Export suite", "btn btn--tiny", function () { onExport(); });
        bar.appendChild(exportBtn);
      }
    }

    function paintProgressInto(node) {
      node.textContent = "";
      if (!state.running || !state.progress) { node.className = "probe__progress hidden"; return; }
      node.className = "probe__progress";
      var bar = el("div", "probe__bar");
      var fill = el("div", "probe__bar-fill");
      var ratio = state.progress.total ? state.progress.done / state.progress.total : 0;
      fill.style.width = Math.round(ratio * 100) + "%";
      bar.appendChild(fill);
      node.appendChild(bar);
      node.appendChild(el("span", "card__meta",
        state.progress.done + " of " + state.progress.total + " cases"));
    }

    function paintSummary(node) {
      node.textContent = "";
      if (!state.run) return;
      var buckets = grouped();
      var counts = [
        { key: "cases", value: (state.run.planned && state.run.planned.cases.length) || 0 },
        { key: "breaks everything", value: (buckets.blocker || []).length },
        { key: "badly broken", value: (buckets.high || []).length },
        { key: "quietly wrong", value: (buckets.medium || []).length },
        { key: "holds up", value: (buckets.pass || []).length }
      ];
      counts.forEach(function (entry) {
        var stat = el("div", "stat");
        stat.appendChild(el("b", null, String(entry.value)));
        stat.appendChild(el("span", null, entry.key));
        node.appendChild(stat);
      });
    }

    function paintChips(node) {
      node.textContent = "";
      if (!state.run) return;
      var buckets = grouped();
      ORDER.forEach(function (severity) {
        var rows = buckets[severity] || [];
        if (!rows.length) return;
        var chip = button(GROUPS[severity].label + " " + rows.length, "btn btn--tiny", function () {
          state.filter = state.filter === severity ? null : severity;
          paint();
        });
        chip.setAttribute("aria-pressed", state.filter === severity ? "true" : "false");
        node.appendChild(chip);
      });
    }

    function paintCaseDetail(row) {
      var detail = el("div", "probe__detail");
      detail.appendChild(el("div", "note note--" + (row.severity === "pass" ? "ok" :
        row.severity === "medium" || row.severity === "low" ? "warn" : "bad"), row.message));

      if (row.nodePath !== undefined && row.nodePath !== null) {
        var where = el("div", "probe__where");
        where.appendChild(el("span", "card__meta", row.nodePath || "(the whole payload)"));
        where.appendChild(button("Show me in the form", "btn btn--ghost btn--tiny", function () {
          onReveal(row.nodePath);
        }));
        if (row.mutation) {
          /* Seeded from a failing case the playground shows the exact envelope that broke the
             field, which is the only way to poke at it by hand. */
          where.appendChild(button("Open in playground", "btn btn--ghost btn--tiny", function () {
            onPlayground(row);
          }));
        }
        detail.appendChild(where);
      }
      return detail;
    }

    function paintRows(node) {
      node.textContent = "";
      if (!state.run) {
        node.appendChild(el("div", "hint",
          "Nothing has been tested yet. A run injures the example input one path at a time — " +
          "removing a key, blanking a value, emptying a list — and reports which fields stop " +
          "working and which quietly start lying."));
        return;
      }

      var buckets = grouped();
      var shown = state.filter ? [state.filter] : ORDER;

      shown.forEach(function (severity) {
        var rows = buckets[severity] || [];
        if (!rows.length) return;

        var group = el("div", "probe__group");
        var isPass = severity === "pass";
        /* Everything that holds up is one line by default: it is the bulk of the run and the
           least interesting part of it, and building its rows costs more than reading them. */
        var open = state.expandedGroups[severity] === undefined ? !isPass : state.expandedGroups[severity];

        var head = el("div", "probe__group-head");
        head.appendChild(el("span", "note__tag note__tag--" + GROUPS[severity].tone,
          GROUPS[severity].label));
        head.appendChild(el("span", "card__meta", rows.length + " case" + (rows.length === 1 ? "" : "s")));
        head.addEventListener("click", function () {
          state.expandedGroups[severity] = !open;
          paint();
        });
        group.appendChild(head);

        if (open) {
          rows.slice(0, ROW_CAP).forEach(function (row) {
            var line = el("div", "probe__row");
            var isOpen = !!state.open[row.caseId];
            line.appendChild(el("span", "probe__code", CODES[row.code] || row.code));
            line.appendChild(el("span", "probe__label", row.label || row.message));
            line.addEventListener("click", function () {
              state.open[row.caseId] = !isOpen;
              paint();
            });
            group.appendChild(line);
            if (isOpen) group.appendChild(paintCaseDetail(row));
          });
          if (rows.length > ROW_CAP) {
            group.appendChild(el("div", "hint",
              (rows.length - ROW_CAP) + " more not shown — narrow it down with the filters above."));
          }
        }
        node.appendChild(group);
      });
    }

    /* ── assembly ────────────────────────────────────────────────────────────────────── */

    var bar, progress, banner, summary, chips, rows;

    function build() {
      host.textContent = "";
      bar = el("div", "probe__head");
      progress = el("div", "probe__progress hidden");
      banner = el("div", "banner hidden");
      summary = el("div", "stats");
      chips = el("div", "probe__chips");
      rows = el("div", "probe__rows");
      [bar, progress, banner, summary, chips, rows].forEach(function (n) { host.appendChild(n); });
    }

    function paint() {
      if (!host) return;
      if (!bar) build();
      paintToolbar(bar);
      paintProgressInto(progress);

      if (state.stale && state.run) {
        banner.className = "banner banner--warn";
        banner.textContent = "The mapping has changed since this ran. These results describe the " +
          "mapping as it was — run again to bring them up to date.";
      } else if (state.run && state.run.stopped) {
        banner.className = "banner banner--warn";
        banner.textContent = "Stopped early — " + state.run.ran + " of " +
          (state.run.planned ? state.run.planned.cases.length : "?") + " cases ran.";
      } else if (state.run && state.run.planned && state.run.planned.truncated) {
        banner.className = "banner banner--warn";
        banner.textContent = state.run.planned.truncated + " cases were left out to keep the run " +
          "quick. Use “Run every case” for the full sweep.";
      } else {
        banner.className = "banner hidden";
        banner.textContent = "";
      }

      paintSummary(summary);
      paintChips(chips);
      paintRows(rows);
    }

    return {
      paint: paint,
      riskFor: riskFor,
      riskBranch: riskBranch,
      setRunning: function (running, progressState) {
        state.running = running;
        state.progress = progressState || null;
        paint();
      },
      setRun: function (run) {
        state.run = run;
        state.stale = false;
        state.open = {};
        state.filter = null;
        state.focusPath = null;
        state.expandedGroups = {};
        reindex();
        paint();
      },
      /** Arriving from a badge on the form: narrow the report to that field and its children. */
      focus: function (nodePath) {
        state.focusPath = nodePath;
        state.filter = null;
        state.expandedGroups = {};
        paint();
      },
      setStale: function (stale) {
        if (state.stale === stale) return;
        state.stale = stale;
        reindex();
        paint();
      },
      clear: function () {
        state.run = null;
        state.stale = false;
        reindex();
        paint();
      },
      /* The report as text, for the copy button — the same three-tier clipboard fallback the
         other panels use, so this needs nothing of its own. */
      asText: function () {
        if (!state.run) return "No test run yet.";
        var lines = [];
        var buckets = grouped();
        ORDER.forEach(function (severity) {
          var group = buckets[severity] || [];
          if (!group.length || severity === "pass") return;
          lines.push("");
          lines.push(GROUPS[severity].label.toUpperCase() + " — " + group.length);
          group.slice(0, ROW_CAP).forEach(function (row) {
            lines.push("  " + (row.nodePath || "(payload)"));
            lines.push("    " + row.message);
          });
        });
        if (!lines.length) return "Every case holds up.";
        return lines.join("\n").replace(/^\n/, "");
      }
    };
  }

  return { create: create };
});
