/* ══════════════════════════════════════════════════════════════════════════════════════
   probe.js — what happens when the next response is not the sample one.

   The page evaluates the generated JSONata against one example input and shows the payload.
   That answers "does this work", never "does this hold up". The responses that break a
   mapping in production are the ordinary ones: a key absent, a value null, a list empty, a
   number that arrived as "n/a". Finding those by waiting for them is expensive.

   So: derive from the mapping every path in `model` it actually reads, injure those paths one
   at a time, evaluate again, and compare. Three kinds of answer come out, and only the first
   is the one people expect:

     - the field that read the injured path loses its value          (fine — EXPECTED_ABSENCE)
     - the WHOLE payload is lost                                     (THROWS — $number("n/a") does this)
     - a DIFFERENT field quietly changes                             (COLLATERAL / SILENT_SUBSTITUTION)

   Nothing here judges by hand-written expectations. The oracle is differential: baseline
   first, then each injury measured against it, and a verdict from what moved rather than from
   what someone remembered to assert.

   Portable ES5 with a UMD wrapper, like nodes.js — the same file runs in the page and under
   node. jsonata is injected rather than required, because this folder has no dependencies.
   ══════════════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./nodes.js"));
  else root.MappingProbe = factory(root.MappingNodes);
})(typeof self !== "undefined" ? self : this, function (MappingNodes) {
  "use strict";

  var parsePath = MappingNodes.parsePath;
  var itemOf = MappingNodes.itemOf;

  /* ── Small helpers ─────────────────────────────────────────────────────────────────── */

  var isSet = function (value) {
    return typeof value === "string" ? value.trim() !== "" : value !== undefined && value !== null;
  };

  var csv = function (text) {
    return String(text || "").split(",").map(function (p) { return p.trim(); }).filter(Boolean);
  };

  /** A path step meaning "every element of this array". Never the last step of a read. */
  var WILDCARD = "[*]";

  /* Assigning through a path the user typed must never reach Object.prototype. The paths come
     from a config file that can be imported from disk, so this is a real reachable surface. */
  var FORBIDDEN = { __proto__: 1, constructor: 1, prototype: 1 };

  function shallowClone(value) {
    if (Array.isArray(value)) return value.slice();
    var out = {};
    for (var key in value) if (Object.prototype.hasOwnProperty.call(value, key)) out[key] = value[key];
    return out;
  }

  /** FNV-1a, 32-bit. A drift detector, not a security primitive — it only has to notice that
      two configs differ, identically in node and in the browser, without a dependency. */
  function fingerprint(value) {
    var text = typeof value === "string" ? value : canonical(value);
    var hash = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    var hex = hash.toString(16);
    return "00000000".slice(hex.length) + hex;
  }

  /** JSON with sorted keys and renderer-internal __ keys dropped, so a fingerprint tracks the
      mapping rather than the order the form happened to write it in. */
  function canonical(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    return "{" + Object.keys(value).sort().filter(function (key) {
      return key.indexOf("__") !== 0 && value[key] !== undefined;
    }).map(function (key) {
      return JSON.stringify(key) + ":" + canonical(value[key]);
    }).join(",") + "}";
  }

  /* ── Pointers ──────────────────────────────────────────────────────────────────────── */

  /** Segments -> the readable form used in reports: result.orders[*].header.orderNo */
  function pointerOf(segments) {
    var out = "";
    segments.forEach(function (step) {
      if (step === WILDCARD) { out += "[*]"; return; }
      if (typeof step === "number") { out += "[" + step + "]"; return; }
      out += out ? "." + step : step;
    });
    return out;
  }

  /** The first value a pointer addresses, for gating mutations on what is actually there. */
  function readAt(value, segments, index) {
    index = index || 0;
    if (index >= segments.length) return value;
    if (value === null || value === undefined) return undefined;
    var step = segments[index];
    if (step === WILDCARD) {
      if (!Array.isArray(value) || !value.length) return undefined;
      return readAt(value[0], segments, index + 1);
    }
    if (typeof value !== "object") return undefined;
    return readAt(value[step], segments, index + 1);
  }

  /* ── Frames: the scope chain, as data ──────────────────────────────────────────────────
     nodes.js resolves a path to TEXT through chain()/resolve(); this resolves the same path to
     an absolute position in the document. The two must agree exactly — if they drift, the
     probe injures a path nothing reads and reports a clean bill of health. nodes.test.js
     cross-checks every read against the emitted expression for that reason. */

  function frame(prefix, parent) { return { prefix: prefix, parent: parent || null }; }

  /**
   * Mirrors nodes.js resolve(). Returns a LIST because "auto" genuinely reads two places: the
   * current record, and the enclosing one when the current record has nothing. Which of the two
   * a field actually got is the whole SILENT_SUBSTITUTION question.
   */
  function resolveFrames(ctx, mode) {
    /* "root" is the outermost RECORD, not the response document, so it stops one link short of
       the model frame — exactly as nodes.js:182 does. */
    if (mode === "root") {
      var top = ctx;
      while (top.parent && top.parent.parent) top = top.parent;
      return [top];
    }
    if (mode === "parent") return [ctx.parent || ctx];
    if (mode === "auto" && ctx.parent) return [ctx, ctx.parent];
    return [ctx];
  }

  /** prefix + a relative path, or null when the prefix is unknowable. */
  function compose(prefix, path) {
    if (!prefix) return null;
    var parsed = parsePath(path);
    /* $index is a position, not a read; $self is the record the frame already points at. */
    if (parsed.kind === "index") return null;
    if (parsed.kind === "self") return prefix.slice();
    return prefix.concat(parsed.segments);
  }

  /**
   * What each element of an array sits at. A raw sourceExpression is opaque text, so everything
   * below it becomes unknowable rather than guessed — reported as COVERAGE_GAP, never silently
   * omitted, or the report would imply coverage it does not have.
   */
  function itemFrame(node, ctx) {
    if (isSet(node.sourceExpression)) return frame(null, ctx);
    var source = resolveFrames(ctx, node.scope)[0];
    if (!source.prefix) return frame(null, ctx);
    /* No source means one element built from the current context (nodes.js:263), so the item
       IS the record — no wildcard step. */
    if (!isSet(node.source)) return frame(source.prefix.slice(), ctx);
    var composed = compose(source.prefix, node.source);
    /* The item frame's parent is ctx, NOT the resolved source frame — matching the chain
       nodes.js:284 builds. Getting this wrong shifts every auto fallback one level. */
    return frame(composed ? composed.concat([WILDCARD]) : null, ctx);
  }

  /* ── Raw expressions ───────────────────────────────────────────────────────────────── */

  var RAW_KEYS = ["expression", "sourceExpression", "filterExpression"];
  var PROPERTY_REF = /\$\$\s*\.\s*properties\s*\.\s*(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*)/g;
  /* A reference to model/properties that is NOT reached through $$. Harmless in a $map lambda,
     which does not rebind the context — but a filter predicate DOES, so inside one it silently
     resolves to nothing. Static detection beats trying to provoke it. */
  var BARE_REF = /(^|[^.\w$`])(model|properties)\s*\./;
  var NON_DETERMINISTIC = /\$(now|millis|random)\s*\(/;

  function propertyNames(text) {
    var names = [];
    var match;
    PROPERTY_REF.lastIndex = 0;
    while ((match = PROPERTY_REF.exec(String(text)))) {
      names.push(match[1].replace(/`/g, ""));
    }
    return names;
  }

  /* ── Dependency extraction ─────────────────────────────────────────────────────────── */

  /**
   * config -> one record per node saying what it reads out of `model` and out of `properties`.
   * Deduplication happens later, on pointers rather than nodes: a few hundred nodes in a large
   * example collapse to about 40 distinct pointers, and a case is a pointer, not a field.
   */
  function dependencies(config) {
    var deps = [];

    function addRead(reads, role, prefix, path, frameName, via) {
      var segments = compose(prefix, path);
      if (!segments) return;
      reads.push({
        role: role,
        pointer: pointerOf(segments),
        segments: segments,
        frame: frameName,
        primary: frameName !== "parent",
        /* Set only on the second half of an auto-scope pair. SILENT_SUBSTITUTION keys off this
           rather than off "the node has two reads", because a fallbackSource also produces two
           and choosing the fallback when the primary is empty is the advertised behaviour, not
           a surprise. */
        via: via || null
      });
    }

    function leafReads(node, ctx) {
      var reads = [];
      var frames = resolveFrames(ctx, node.scope);
      /* More than one frame only ever means scope:"auto" — read this record, fall back to the
         enclosing one. resolveFrames returns them in that order. */
      var isAuto = frames.length > 1;

      frames.forEach(function (f, index) {
        var frameName = isAuto ? (index === 0 ? "instance" : "parent") : (node.scope || "instance");
        var via = isAuto && index === 1 ? "scope:auto" : null;

        if (isSet(node.sources)) {
          var list = Array.isArray(node.sources) ? node.sources : csv(node.sources);
          list.forEach(function (path) { addRead(reads, "value", f.prefix, path, frameName, via); });
        } else if (isSet(node.source)) {
          addRead(reads, "value", f.prefix, node.source, frameName, via);
        }
        if (isSet(node.fallbackSource)) {
          addRead(reads, "fallback", f.prefix, node.fallbackSource, frameName, via);
        }
      });
      return reads;
    }

    function record(node, nodePath, ctx, reads, extra) {
      var raw = null;
      var properties = [];
      RAW_KEYS.forEach(function (key) {
        if (!isSet(node[key])) return;
        raw = raw || key;
        properties = properties.concat(propertyNames(node[key]));
      });
      var dep = {
        nodePath: nodePath,
        nodeType: node.type || "leaf",
        key: node.key || "",
        reads: reads,
        properties: properties,
        raw: raw,
        transform: node.transform || "none",
        affixes: {
          prefix: typeof node.prefix === "string" && node.prefix !== "" ? node.prefix : null,
          suffix: typeof node.suffix === "string" && node.suffix !== "" ? node.suffix : null,
          appendIndex: !!node.appendIndex,
          indexSeparator: node.indexSeparator === undefined ? null : String(node.indexSeparator)
        },
        alwaysArray: node.alwaysArray !== false,
        /* An ancestor used a raw sourceExpression, so nothing below it can be located. */
        unresolved: !ctx.prefix
      };
      for (var key in extra) if (Object.prototype.hasOwnProperty.call(extra, key)) dep[key] = extra[key];
      deps.push(dep);
      return dep;
    }

    function walk(node, nodePath, ctx) {
      if (!node) return;
      var type = node.type || "leaf";

      if (type === "leaf") { record(node, nodePath, ctx, leafReads(node, ctx)); return; }

      if (type === "array") {
        var reads = [];
        var source = resolveFrames(ctx, node.scope)[0];
        if (isSet(node.source)) addRead(reads, "array-source", source.prefix, node.source, node.scope || "instance");
        var inner = itemFrame(node, ctx);
        /* A filter predicate is evaluated with each ELEMENT as the context, so filterPath is
           relative to the item, not to the array's own frame. */
        if (isSet(node.filterPath)) addRead(reads, "filter", inner.prefix, node.filterPath, "item");
        record(node, nodePath, ctx, reads);
        var element = itemOf(node);
        if (element) walk(element, nodePath + "/(each item)", inner);
        return;
      }

      record(node, nodePath, ctx, []);
      (node.children || []).forEach(function (child, index) {
        walk(child, nodePath + "/" + (child.key || "[" + index + "]"), ctx);
      });
    }

    walk((config || {}).root, "", frame([], null));
    return deps;
  }

  /* ── Static findings, before anything is evaluated ──────────────────────────────────── */

  function staticFindings(config) {
    var findings = [];

    (function walk(node, nodePath) {
      if (!node) return;
      RAW_KEYS.forEach(function (key) {
        if (!isSet(node[key])) return;
        var text = String(node[key]);
        if (key === "filterExpression" && BARE_REF.test(text)) {
          findings.push({
            level: "error", code: "FILTER_CONTEXT", nodePath: nodePath, severity: "blocker",
            confidence: "high", blastRadius: "node",
            message: "This filter reads “" + RegExp.$2 + "” directly. Inside a filter the current " +
              "record is each item, so that finds nothing — write “$$." + RegExp.$2 + "” instead."
          });
        }
        if (NON_DETERMINISTIC.test(text)) {
          findings.push({
            level: "warn", code: "NON_DETERMINISTIC", nodePath: nodePath, severity: "low",
            confidence: "high", blastRadius: "node",
            message: "This expression changes every time it runs, so its result cannot be pinned by a test."
          });
        }
      });
      if (node.item) walk(node.item, nodePath + "/(each item)");
      (node.children || []).forEach(function (child, index) {
        walk(child, nodePath + "/" + (child.key || "[" + index + "]"));
      });
    })((config || {}).root, "");

    return findings;
  }

  /** Every flow property the mapping reaches, with the fields that reach it. */
  function discoverProperties(config) {
    var byName = {};
    (function walk(node, nodePath) {
      if (!node) return;
      RAW_KEYS.forEach(function (key) {
        if (!isSet(node[key])) return;
        propertyNames(node[key]).forEach(function (name) {
          /* `Mapping` is the config handed back to itself by the mapper action, not a flow
             property anyone configures. Including it would serialise the whole mapping into
             every case. */
          if (name === "Mapping") return;
          (byName[name] = byName[name] || []).push(nodePath);
        });
      });
      if (node.item) walk(node.item, nodePath + "/(each item)");
      (node.children || []).forEach(function (child, index) {
        walk(child, nodePath + "/" + (child.key || "[" + index + "]"));
      });
    })((config || {}).root, "");
    return byName;
  }

  /* ── Mutations ─────────────────────────────────────────────────────────────────────── */

  var LONG = new Array(4097).join("x");

  /**
   * The injuries. `applies` gates on what is actually at the pointer at baseline, so "empty
   * list" never fires at a scalar and the case count stays proportional to the mapping rather
   * than to the catalogue.
   */
  var MUTATIONS = [
    { id: "DELETE_KEY", tier: "smoke", phrase: "is not in the response", op: { kind: "delete" },
      applies: function () { return true; } },
    { id: "NULL", tier: "smoke", phrase: "comes back null", op: { kind: "set", value: null },
      applies: function (v) { return v !== null; } },
    { id: "EMPTY_STRING", tier: "smoke", phrase: "is blank", op: { kind: "set", value: "" },
      applies: function (v) { return typeof v !== "object" && v !== ""; } },

    { id: "WHITESPACE", tier: "standard", phrase: "is nothing but spaces", op: { kind: "set", value: "   " },
      applies: function (v) { return typeof v === "string"; } },
    { id: "NON_NUMERIC_TEXT", tier: "standard", phrase: "is text where a number was expected",
      op: { kind: "set", value: "n/a" },
      applies: function (v, ctx) { return ctx.numeric && typeof v !== "object"; } },
    { id: "WRONG_TYPE_OBJECT", tier: "standard", phrase: "arrives as an object instead of a value",
      op: { kind: "set", value: { unexpected: true } },
      applies: function (v) { return v !== null && v !== undefined && typeof v !== "object"; } },
    { id: "WRONG_TYPE_NUMBER", tier: "standard", phrase: "arrives as a number instead of text",
      op: { kind: "set", value: 42 },
      applies: function (v) { return typeof v === "string"; } },
    { id: "EMPTY_ARRAY", tier: "standard", phrase: "is an empty list", op: { kind: "set", value: [] },
      applies: function (v) { return Array.isArray(v) && v.length > 0; } },
    /* JSONata collapses a one-element sequence to the bare value, so cardinality one is a
       genuinely different shape from cardinality many — this is the alwaysArray probe. */
    { id: "SINGLE_ELEMENT", tier: "standard", phrase: "comes back with only one entry",
      op: { kind: "map", fn: function (v) { return [v[0]]; } },
      applies: function (v) { return Array.isArray(v) && v.length > 1; } },
    { id: "ARRAY_NOT_ARRAY", tier: "standard", phrase: "arrives as a single object instead of a list",
      op: { kind: "map", fn: function (v) { return v[0]; } },
      applies: function (v) { return Array.isArray(v) && v.length > 0; } },

    { id: "LONG_STRING", tier: "paranoid", phrase: "is far longer than expected",
      op: { kind: "set", value: LONG }, applies: function (v) { return typeof v === "string"; } },
    { id: "NON_ASCII", tier: "paranoid", phrase: "contains accents and symbols",
      op: { kind: "set", value: "Grüße — 日本語 🔧" },
      applies: function (v) { return typeof v === "string"; } },
    { id: "CONTROL_CHARS", tier: "paranoid", phrase: "contains control characters",
      op: { kind: "set", value: "a\u0000b\r\nc" }, applies: function (v) { return typeof v === "string"; } },
    { id: "PADDED", tier: "paranoid", phrase: "has leading and trailing spaces",
      op: { kind: "map", fn: function (v) { return "  " + v + "  "; } },
      applies: function (v) { return typeof v === "string" && v !== ""; } },
    { id: "NUMERIC_STRING_ZERO", tier: "paranoid", phrase: "is the string “0”",
      op: { kind: "set", value: "0" }, applies: function (v) { return typeof v !== "object"; } },
    { id: "BOOLEAN_STRING", tier: "paranoid", phrase: "is the string “false”",
      op: { kind: "set", value: "false" }, applies: function (v) { return typeof v !== "object"; } }
  ];

  /**
   * Envelope cases. These are about the shape of the input the mapper action passes, not about
   * any one field, so they run whatever the mapping looks like. PROPERTIES_MAPPING_ONLY is the
   * one that matters most: it is exactly what an unconfigured flow's first execution looks like.
   */
  var ENVELOPE_CASES = [
    { id: "MODEL_EMPTY", phrase: "the response is an empty object" },
    { id: "MODEL_NULL", phrase: "the response is null" },
    { id: "MODEL_ABSENT", phrase: "there is no response at all" },
    { id: "PROPERTIES_ABSENT", phrase: "the flow passes no properties" },
    { id: "PROPERTIES_MAPPING_ONLY", phrase: "the flow has no properties configured yet" }
  ];

  var MUTATION_BY_ID = {};
  MUTATIONS.forEach(function (m) { MUTATION_BY_ID[m.id] = m; });

  var TIERS = { smoke: ["smoke"], standard: ["smoke", "standard"], paranoid: ["smoke", "standard", "paranoid"] };

  /** Plain English, owned here so the report, the page and the replay all say the same thing. */
  function describeCase(mutation) {
    if (mutation.kind === "envelope") {
      var envelopeCase = null;
      ENVELOPE_CASES.forEach(function (c) { if (c.id === mutation.id) envelopeCase = c; });
      if (mutation.id === "PROPERTIES_KEY_MISSING") {
        return "when the flow property “" + mutation.name + "” is not set";
      }
      return "when " + (envelopeCase ? envelopeCase.phrase : mutation.id);
    }
    var spec = MUTATION_BY_ID[mutation.id];
    var scope = mutation.apply === "all" ? "every “" : "“";
    return "when " + scope + mutation.pointer + "” " + (spec ? spec.phrase : mutation.id);
  }

  /* ── Applying a mutation ───────────────────────────────────────────────────────────── */

  function nextValue(op, current) {
    if (op.kind === "set") return typeof op.value === "object" && op.value !== null
      ? JSON.parse(JSON.stringify(op.value)) : op.value;
    if (op.kind === "map") return op.fn(current);
    return undefined;
  }

  /**
   * Copy-on-write: only the containers along the injured path are cloned, so injuring one field
   * of a large response costs the depth of the path rather than the size of the document.
   * Returns { changed, value } — `changed:false` means the path was not there to injure, which
   * is a reportable fact rather than a silent no-op.
   */
  function mutate(container, segments, index, op, applyAll) {
    if (container === null || typeof container !== "object") return { changed: false, value: container };
    var step = segments[index];
    var last = index === segments.length - 1;

    if (step === WILDCARD) {
      if (!Array.isArray(container) || !container.length) return { changed: false, value: container };
      var copy = container.slice();
      var limit = applyAll ? copy.length : 1;
      var touched = false;
      for (var i = 0; i < limit && i < copy.length; i++) {
        if (last) {
          if (op.kind === "delete") continue;   // deleting "the element itself" is not a shape a response takes
          copy[i] = nextValue(op, copy[i]);
          touched = true;
        } else {
          var deeper = mutate(copy[i], segments, index + 1, op, applyAll);
          copy[i] = deeper.value;
          touched = touched || deeper.changed;
        }
      }
      return { changed: touched, value: touched ? copy : container };
    }

    if (typeof step === "number") {
      if (!Array.isArray(container) || step >= container.length) return { changed: false, value: container };
    } else {
      if (FORBIDDEN[step]) return { changed: false, value: container };
      if (!Object.prototype.hasOwnProperty.call(container, step)) return { changed: false, value: container };
    }

    if (last) {
      var out = shallowClone(container);
      if (op.kind === "delete") {
        if (Array.isArray(out)) out.splice(step, 1);
        else delete out[step];
      } else {
        out[step] = nextValue(op, container[step]);
      }
      return { changed: true, value: out };
    }

    var sub = mutate(container[step], segments, index + 1, op, applyAll);
    if (!sub.changed) return { changed: false, value: container };
    var clone = shallowClone(container);
    clone[step] = sub.value;
    return { changed: true, value: clone };
  }

  /**
   * A case descriptor + a healthy envelope -> the injured envelope. Pure, and cheap enough to
   * call on demand: results deliberately carry descriptors rather than documents, because
   * hundreds of retained deep clones is how this feature would kill the tab.
   */
  function applyCase(mutation, envelope) {
    var model = envelope.model;
    var properties = envelope.properties;

    if (mutation.kind === "envelope") {
      if (mutation.id === "MODEL_EMPTY") return { model: {}, properties: properties };
      if (mutation.id === "MODEL_NULL") return { model: null, properties: properties };
      if (mutation.id === "MODEL_ABSENT") return { properties: properties };
      if (mutation.id === "PROPERTIES_ABSENT") return { model: model };
      if (mutation.id === "PROPERTIES_MAPPING_ONLY") {
        var floor = {};
        if (properties && properties.Mapping !== undefined) floor.Mapping = properties.Mapping;
        return { model: model, properties: floor };
      }
      if (mutation.id === "PROPERTIES_KEY_MISSING") {
        var trimmed = shallowClone(properties || {});
        delete trimmed[mutation.name];
        return { model: model, properties: trimmed };
      }
      return { model: model, properties: properties };
    }

    var spec = MUTATION_BY_ID[mutation.id];
    if (!spec) return { model: model, properties: properties };
    var result = mutate(model, mutation.segments, 0, spec.op, mutation.apply === "all");
    return { model: result.value, properties: properties };
  }

  /* ── Planning ──────────────────────────────────────────────────────────────────────── */

  /**
   * config + a healthy envelope -> the cases worth running. Cases are keyed by POINTER, not by
   * field: many fields read the same path, and injuring it once answers for all of them. That
   * is a roughly five-fold reduction on a large mapping, and it is also what makes the
   * collateral rule correct — every reader of an injured pointer is expected to change.
   */
  function plan(config, options) {
    options = options || {};
    var envelope = { model: options.model, properties: options.properties };
    var tiers = TIERS[options.tier || "standard"] || TIERS.standard;
    var maxCases = options.maxCases || 2000;

    var deps = dependencies(config);
    var byPointer = {};
    var numericPointers = {};

    deps.forEach(function (dep) {
      dep.reads.forEach(function (read) {
        var entry = byPointer[read.pointer] || (byPointer[read.pointer] = {
          pointer: read.pointer, segments: read.segments, roles: {}, nodePaths: []
        });
        entry.roles[read.role] = true;
        if (entry.nodePaths.indexOf(dep.nodePath) < 0) entry.nodePaths.push(dep.nodePath);
        /* $number and $boolean are the transforms that throw rather than yield nothing, so a
           pointer feeding one deserves the "text where a number was expected" case. */
        if (dep.transform === "number" || dep.transform === "boolean") numericPointers[read.pointer] = true;
      });
    });

    var cases = [];
    var skipped = [];

    Object.keys(byPointer).forEach(function (pointer) {
      var entry = byPointer[pointer];
      var baselineValue = readAt(envelope.model, entry.segments, 0);
      if (baselineValue === undefined) {
        /* Nothing there to injure. Reported so the coverage summary is honest rather than
           quietly implying this path was exercised. */
        skipped.push({ pointer: pointer, reason: "PATH_ABSENT_AT_BASELINE", nodePaths: entry.nodePaths });
        return;
      }
      var hasWildcard = entry.segments.indexOf(WILDCARD) >= 0;
      var context = { numeric: !!numericPointers[pointer], roles: entry.roles };

      MUTATIONS.forEach(function (spec) {
        if (tiers.indexOf(spec.tier) < 0) return;
        if (!spec.applies(baselineValue, context)) return;
        var applies = hasWildcard && tiers.indexOf("standard") >= 0 ? ["first", "all"] : ["first"];
        applies.forEach(function (apply) {
          /* "every element" only differs from "the first element" when there is more than one. */
          if (apply === "all" && !hasWildcard) return;
          cases.push(makeCase({
            kind: "pointer", id: spec.id, pointer: pointer,
            segments: entry.segments, apply: apply
          }, entry.nodePaths));
        });
      });
    });

    /* Envelope cases run whatever the mapping looks like — they are about the contract with the
       mapper action, not about any one field. They still need to say WHICH fields are entitled
       to change, though: without that every field a missing property touches is reported as
       collateral damage, which is precisely backwards. */
    var byProperty = discoverProperties(config);
    var everyPropertyReader = [];
    Object.keys(byProperty).forEach(function (name) {
      byProperty[name].forEach(function (nodePath) {
        if (everyPropertyReader.indexOf(nodePath) < 0) everyPropertyReader.push(nodePath);
      });
    });

    /* Emptying the response is expected to affect everything that reads it; removing the
       properties, only what reads a property. Neither is collateral damage. */
    var everyModelReader = [];
    deps.forEach(function (dep) {
      if (dep.reads.length && everyModelReader.indexOf(dep.nodePath) < 0) everyModelReader.push(dep.nodePath);
    });

    ENVELOPE_CASES.forEach(function (spec) {
      var owned = spec.id.indexOf("PROPERTIES_") === 0 ? everyPropertyReader : everyModelReader;
      cases.push(makeCase({ kind: "envelope", id: spec.id }, owned));
    });
    Object.keys(byProperty).forEach(function (name) {
      cases.push(makeCase({ kind: "envelope", id: "PROPERTIES_KEY_MISSING", name: name },
        byProperty[name]));
    });

    var truncated = null;
    if (cases.length > maxCases) {
      truncated = cases.length - maxCases;
      cases = cases.slice(0, maxCases);
    }

    return {
      cases: cases, deps: deps, skipped: skipped, truncated: truncated,
      pointers: Object.keys(byPointer).length,
      fingerprint: fingerprint(config)
    };
  }

  function makeCase(mutation, nodePaths) {
    var id = fingerprint([mutation.kind, mutation.id, mutation.pointer || "", mutation.apply || "",
      mutation.name || ""].join("|")).slice(0, 6);
    return {
      caseId: id,
      mutation: mutation,
      /* Which fields are legitimately allowed to change. Everything else is collateral. */
      nodePaths: nodePaths || [],
      label: describeCase(mutation)
    };
  }

  /* ── Observing the output ──────────────────────────────────────────────────────────── */

  /**
   * The same walk readings() does, recording structure rather than display text. readings() is
   * the human-facing attribution and the form depends on its exact shape, so it is left alone;
   * but it is lossy in two ways an oracle cannot tolerate — containers flatten to "N items",
   * and [] means both "not an array" and "absent".
   */
  function observe(config, output) {
    var found = {};

    function describe(value) {
      return {
        present: value !== undefined,
        isArray: Array.isArray(value),
        length: Array.isArray(value) ? value.length : null,
        type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        value: value === null || typeof value !== "object" ? value : undefined
      };
    }

    function walk(node, value, nodePath) {
      if (!node) return;
      var type = node.type || "leaf";
      found[nodePath] = describe(value);
      if (type === "leaf") return;

      var sample = Array.isArray(value) ? value[0] : value;

      if (type === "list") {
        var pool = Array.isArray(value) ? value.slice() : [];
        (node.children || []).forEach(function (child, index) {
          var wanted = ((itemOf(child) || child).children || []).map(function (g) { return g.key; })
            .filter(function (k) { return isSet(k); });
          var at = -1;
          for (var i = 0; i < pool.length && at < 0; i++) {
            var candidate = pool[i];
            if (!candidate || typeof candidate !== "object") continue;
            var hits = wanted.filter(function (k) { return candidate[k] !== undefined; }).length;
            if (wanted.length && hits === wanted.length) at = i;
          }
          var mine = at >= 0 ? pool.splice(at, 1)[0] : undefined;
          walk(child, mine, nodePath + "/" + (child.key || "[" + index + "]"));
        });
        return;
      }

      if (type === "array") {
        var element = itemOf(node);
        if (element) walk(element, sample, nodePath + "/(each item)");
        return;
      }

      (node.children || []).forEach(function (child, index) {
        var childValue = sample && typeof sample === "object" && isSet(child.key)
          ? sample[child.key] : undefined;
        walk(child, childValue, nodePath + "/" + (child.key || "[" + index + "]"));
      });
    }

    walk((config || {}).root, output, "");
    return found;
  }

  /** Which nodePaths moved, comparing two readings() maps. */
  function diffReadings(before, after) {
    var changed = [];
    var keys = {};
    Object.keys(before).forEach(function (k) { keys[k] = 1; });
    Object.keys(after).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
        changed.push({ nodePath: k, from: before[k], to: after[k] });
      }
    });
    return changed;
  }

  function isEmptyPayload(value) {
    if (value === undefined || value === null) return true;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "object") return Object.keys(value).length === 0;
    return false;
  }

  /* ── The oracle ────────────────────────────────────────────────────────────────────── */

  var SEVERITY = {
    THROWS: "blocker", PAYLOAD_COLLAPSE: "blocker", CARDINALITY: "high", COLLATERAL: "high",
    LIST_SHRINKS: "medium", SILENT_SUBSTITUTION: "medium", ARTEFACT: "medium",
    EXPECTED_ABSENCE: "pass", NO_EFFECT: "low"
  };

  var LEVEL = { blocker: "error", high: "error", medium: "warn", low: "warn", pass: "ok" };

  /** Curly quotes, because app.js rewrites those into <code> when it paints a note. */
  function quote(text) { return "“" + text + "”"; }

  function classify(baseline, attempt, testCase, config, depsByPath) {
    var mutation = testCase.mutation;
    var when = testCase.label;

    if (attempt.error) {
      return [{
        code: "THROWS", severity: "blocker", blastRadius: "payload", confidence: "high",
        nodePath: testCase.nodePaths[0] || "",
        errorCode: attempt.error.code || null,
        message: "The whole payload is lost " + when + " — " +
          (attempt.error.code ? attempt.error.code + ", " : "") + attempt.error.message +
          ". Every other field is discarded with it."
      }];
    }

    if (!isEmptyPayload(baseline.output) && isEmptyPayload(attempt.output)) {
      /* An empty payload is the RIGHT answer when the thing that was emptied is the response
         itself, or the list the whole mapping iterates. Calling that a blocker would make the
         loudest finding in every report the one case that is working as designed. */
      var emptiedTheSource = mutation.kind === "envelope"
        ? mutation.id.indexOf("MODEL_") === 0
        : (testCase.nodePaths || []).indexOf("") >= 0;
      if (!emptiedTheSource) {
        return [{
          code: "PAYLOAD_COLLAPSE", severity: "blocker", blastRadius: "payload", confidence: "high",
          nodePath: testCase.nodePaths[0] || "",
          message: "The payload comes out empty " + when + " — every field is lost, not just the ones reading it."
        }];
      }
      return [{
        code: "EXPECTED_ABSENCE", severity: "pass", blastRadius: "payload", confidence: "high",
        nodePath: testCase.nodePaths[0] || "",
        message: "The payload is empty " + when + ", which is the right answer."
      }];
    }

    var changed = diffReadings(baseline.readings, attempt.readings);

    /* Everything that reads the injured pointer is allowed to move, and so is everything
       nested inside it — killing an array's source legitimately blanks the whole branch. */
    var expected = {};
    (testCase.nodePaths || []).forEach(function (p) { expected[p] = true; });
    if (mutation.kind === "pointer") {
      Object.keys(depsByPath).forEach(function (nodePath) {
        depsByPath[nodePath].reads.forEach(function (read) {
          if (read.pointer === mutation.pointer || read.pointer.indexOf(mutation.pointer + ".") === 0 ||
            read.pointer.indexOf(mutation.pointer + "[") === 0) expected[nodePath] = true;
        });
      });
    }

    /* A container reflects its children. If a field inside an array is expected to change then
       the array's own count is expected to move too — reporting that as collateral accuses the
       list of reading a path its ITEM reads, which is both wrong and the noisiest finding in
       the report. Ancestors of anything expected are expected. */
    Object.keys(expected).forEach(function (nodePath) {
      var parts = nodePath.split("/");
      while (parts.length > 1) {
        parts.pop();
        expected[parts.join("/")] = true;
      }
    });

    function isExpected(nodePath) {
      if (expected[nodePath]) return true;
      for (var p in expected) {
        if (Object.prototype.hasOwnProperty.call(expected, p) && nodePath.indexOf(p + "/") === 0) return true;
      }
      return false;
    }

    var findings = [];
    var collateral = changed.filter(function (c) { return !isExpected(c.nodePath); });

    /* A list that quietly comes back shorter is the failure people notice last and care about
       most: nothing errors, the payload looks right, and rows are simply gone. It is not
       collateral — the list does read the injured path, through its item — so it gets its own
       name rather than being filtered away with the ancestors above. */
    var shrunk = {};
    Object.keys(attempt.observed).forEach(function (nodePath) {
      var was = baseline.observed[nodePath];
      var now = attempt.observed[nodePath];
      if (!was || !now || !was.isArray || !now.isArray) return;
      if (now.length >= was.length) return;
      shrunk[nodePath] = true;
      var dep = depsByPath[nodePath];
      findings.push({
        code: "LIST_SHRINKS", severity: "medium", blastRadius: "node", confidence: "high",
        nodePath: nodePath,
        message: quote((dep && dep.key) || nodePath.split("/").pop() || nodePath) + " drops from " +
          was.length + " to " + now.length + " " + when +
          " — the rows disappear without any error."
      });
    });

    /* An alwaysArray node that stops being a list is a contract break even when the values are
       right — the target is expecting a list and will get an object. */
    Object.keys(attempt.observed).forEach(function (nodePath) {
      var dep = depsByPath[nodePath];
      if (!dep || dep.nodeType !== "array" && dep.nodeType !== "list") return;
      if (!dep.alwaysArray) return;
      var was = baseline.observed[nodePath];
      var now = attempt.observed[nodePath];
      if (was && was.isArray && now && now.present && !now.isArray) {
        findings.push({
          code: "CARDINALITY", severity: "high", blastRadius: "node", confidence: "high",
          nodePath: nodePath,
          message: quote(dep.key || nodePath) + " stops being a list " + when +
            " — the target will get a single value where it expects an array."
        });
      }
    });

    if (collateral.length) {
      /* A list matches each child to the first output element carrying that child's keys, so a
         missing key can make it re-associate and report a change that never happened. Findings
         under a list are marked down rather than suppressed. */
      var underList = function (nodePath) {
        for (var p in depsByPath) {
          if (Object.prototype.hasOwnProperty.call(depsByPath, p) &&
            depsByPath[p].nodeType === "list" && nodePath.indexOf(p + "/") === 0) return true;
        }
        return false;
      };
      collateral.slice(0, 12).forEach(function (c) {
        findings.push({
          code: "COLLATERAL", severity: "high", blastRadius: "node",
          confidence: underList(c.nodePath) ? "low" : "high",
          nodePath: c.nodePath,
          message: quote(c.nodePath.split("/").pop() || c.nodePath) + " changes " + when +
            ", even though it does not read that path — " +
            JSON.stringify(c.from) + " became " + JSON.stringify(c.to) + "."
        });
      });
    }

    /* A field with scope "auto" reads its own record and falls back to the enclosing one. When
       the record's own value disappears and the field keeps a value, it silently switched to
       the parent's — no error, wrong data, and nothing else can show it. */
    if (mutation.kind === "pointer" && mutation.id === "DELETE_KEY") {
      /* Only DELETE_KEY supports the inference. $exists("") and $exists(null) are both TRUE in
         JSONata, so a blanked or nulled path does not trigger the auto fallback at all — the
         field keeps the blank. Claiming a substitution there would be asserting a cause that
         did not happen. With the key genuinely gone, a surviving value can only have come from
         the enclosing record. */
      (testCase.nodePaths || []).forEach(function (nodePath) {
        var dep = depsByPath[nodePath];
        if (!dep) return;
        /* Only an auto-scope pair can substitute silently. A fallbackSource also gives a node
           two reads, but falling back is what the user asked for and saying so would be noise. */
        var injuredInstance = dep.reads.some(function (r) {
          return r.frame === "instance" && r.role === "value" && r.pointer === mutation.pointer;
        });
        if (!injuredInstance) return;
        /* The two halves of an auto pair often resolve to the SAME absolute path — every array
           between them was a single-instance one with no source of its own, so the loop
           variables differ but the record does not. Nothing can be substituted from a place
           that is the same place, and reporting it accuses a field of a fault it cannot have. */
        var elsewhere = dep.reads.some(function (r) {
          return r.via === "scope:auto" && r.pointer !== mutation.pointer;
        });
        if (!elsewhere) return;
        /* readings() samples the FIRST element of every array, so once a list has lost a row
           the before and after values describe different rows. Everything downstream of a
           shrunk list is being compared to the wrong thing, and LIST_SHRINKS above has already
           said the true thing about it. */
        var underShrunkList = false;
        Object.keys(shrunk).forEach(function (listPath) {
          if (nodePath.indexOf(listPath + "/") === 0) underShrunkList = true;
        });
        if (underShrunkList) return;
        var was = baseline.observed[nodePath];
        var now = attempt.observed[nodePath];
        /* The tell is that the field STILL HAS A VALUE after the record it claims to read was
           emptied — not that the value is unchanged. Usually it changes, quietly, to the
           enclosing record's, which is the whole danger: the payload looks populated and the
           number in it belongs to something else. A surviving null is not a value; that is the
           field going dark, which EXPECTED_ABSENCE already covers. */
        var usable = function (o) { return o && o.present && o.value !== null && o.value !== ""; };
        if (usable(was) && usable(now)) {
          findings.push({
            code: "SILENT_SUBSTITUTION", severity: "medium", blastRadius: "node", confidence: "high",
            nodePath: nodePath,
            message: quote(dep.key || nodePath) + " still reads " + JSON.stringify(now.value) + " " + when +
              " — that value can only have come from the enclosing record, because this one no " +
              "longer has the field. Nothing errors; the number just belongs to something else."
          });
        }
      });
    }

    /* Affix artefacts: a prefix or an index separator concatenated onto nothing. $join already
       defends the multi-source path; prefix, suffix and appendIndex do not. */
    (testCase.nodePaths || []).forEach(function (nodePath) {
      var dep = depsByPath[nodePath];
      if (!dep) return;
      var now = attempt.observed[nodePath];
      if (!now || typeof now.value !== "string") return;
      var affix = dep.affixes;
      var artefact = null;
      if (affix.prefix && (now.value === affix.prefix || now.value === affix.prefix.replace(/\s+$/, ""))) {
        artefact = "the prefix on its own";
      } else if (affix.suffix && now.value === affix.suffix) {
        artefact = "the suffix on its own";
      } else if (affix.appendIndex && affix.indexSeparator && affix.indexSeparator !== "" &&
        now.value.indexOf(affix.indexSeparator) === 0) {
        artefact = "a dangling separator";
      } else if (/^(undefined|null|NaN)$/.test(now.value) || now.value.indexOf("undefined") >= 0) {
        artefact = "the word " + quote("undefined");
      }
      if (artefact) {
        findings.push({
          code: "ARTEFACT", severity: "medium", blastRadius: "node", confidence: "high",
          nodePath: nodePath,
          message: quote(dep.key || nodePath) + " emits " + artefact + " (" + JSON.stringify(now.value) +
            ") " + when + " — it looks like data but it is not."
        });
      }
    });

    if (findings.length) return findings;

    if (!changed.length) {
      /* Absorbing an injury without flinching is usually the goal, not a defect — a mapping
         that shrugs off a list arriving as a single object is a good mapping. It is only worth
         a second look when a value that something claims to READ is removed and nothing moves,
         because that means either a dead branch or a pointer extraction got wrong. */
      var removedAValue = mutation.kind === "pointer" &&
        (mutation.id === "DELETE_KEY" || mutation.id === "NULL") &&
        (testCase.nodePaths || []).length > 0;
      if (!removedAValue) {
        return [{
          code: "NO_EFFECT", severity: "pass", blastRadius: "none", confidence: "high",
          nodePath: testCase.nodePaths[0] || "",
          message: "The payload is unchanged " + when + " — the mapping absorbs it."
        }];
      }
      return [{
        code: "NO_EFFECT", severity: "low", blastRadius: "none", confidence: "medium",
        nodePath: testCase.nodePaths[0] || "",
        message: "Nothing changes " + when + ", even though a field claims to read it — " +
          "either that field is dead or the path is not what it looks like."
      }];
    }

    return [{
      code: "EXPECTED_ABSENCE", severity: "pass", blastRadius: "node", confidence: "high",
      nodePath: testCase.nodePaths[0] || "",
      message: "Only the fields reading that path are affected " + when + "."
    }];
  }

  /* ── Running ───────────────────────────────────────────────────────────────────────── */

  /** jsonata 2 returns a promise; older builds return the value. Tolerate both. */
  function evaluateOnce(compiled, envelope) {
    return new Promise(function (resolve) {
      var settled = false;
      var done = function (output) { if (!settled) { settled = true; resolve({ output: output, error: null }); } };
      var fail = function (error) {
        if (settled) return;
        settled = true;
        resolve({ output: undefined, error: { code: error && error.code, message: (error && error.message) || String(error) } });
      };
      try {
        var result = compiled.evaluate(envelope);
        if (result && typeof result.then === "function") result.then(done, fail);
        else done(result);
      } catch (error) { fail(error); }
    });
  }

  /**
   * Hand the thread back so a caller in a browser can paint and stay clickable.
   *
   * The timeout is one frame, not the leisurely 60ms it started as. requestIdleCallback waits
   * for genuine idle, and a backgrounded tab is never "idle" in the way it wants — so the
   * timeout became the actual cadence and eighty chunks spent five seconds doing nothing at
   * all. A frame is long enough to let real input through and short enough not to be felt.
   */
  function yieldSoon() {
    return new Promise(function (resolve) {
      if (typeof requestIdleCallback === "function") requestIdleCallback(function () { resolve(); }, { timeout: 16 });
      else setTimeout(resolve, 0);
    });
  }

  /**
   * The sweep. The expression is compiled by the caller and reused for every case, because
   * compiling is most of the cost and it never changes during a run.
   */
  function run(options) {
    var config = options.config;
    var compiled = options.compiled;
    var envelope = { model: options.model, properties: options.properties };
    var cases = options.cases || [];
    var chunk = options.chunk || 8;
    var onProgress = options.onProgress || function () {};
    var shouldStop = options.shouldStop || function () { return false; };

    var deps = options.deps || dependencies(config);
    var depsByPath = {};
    deps.forEach(function (dep) { depsByPath[dep.nodePath] = dep; });

    return evaluateOnce(compiled, envelope).then(function (first) {
      var baseline = {
        output: first.output,
        error: first.error,
        readings: first.error ? {} : MappingNodes.readings(config, first.output),
        observed: first.error ? {} : observe(config, first.output)
      };

      var findings = staticFindings(config);

      if (baseline.error) {
        findings.push({
          level: "error", code: "BASELINE_THROWS", nodePath: "", severity: "blocker",
          confidence: "high", blastRadius: "payload",
          message: "The mapping does not run against the sample response at all — " + baseline.error.message
        });
        return { baseline: baseline, results: [], findings: findings, stopped: false, ran: 0 };
      }

      /* Reported before anything is injured: a field with no value at baseline has nothing left
         to break, so it is called out once here rather than generating a case per mutation. */
      var dead = {};
      deps.forEach(function (dep) {
        if (dep.nodeType !== "leaf") return;
        var observed = baseline.observed[dep.nodePath];
        if (observed && observed.present) return;
        if (dep.unresolved) return;
        dead[dep.nodePath] = true;
        findings.push({
          level: "error", code: "DEAD_AT_BASELINE", nodePath: dep.nodePath, severity: "high",
          confidence: "high", blastRadius: "node",
          message: quote(dep.key || dep.nodePath) + " produces nothing even against the healthy sample response" +
            (dep.reads.length ? " — check " + quote(dep.reads[0].pointer) : "") + "."
        });
      });

      deps.forEach(function (dep) {
        if (!dep.unresolved) return;
        findings.push({
          level: "warn", code: "COVERAGE_GAP", nodePath: dep.nodePath, severity: "low",
          confidence: "high", blastRadius: "node",
          message: quote(dep.key || dep.nodePath) + " sits under a hand-written source expression, " +
            "so it cannot be tested — nothing here says whether it holds up."
        });
      });

      var results = [];
      var index = 0;
      var stopped = false;

      function step() {
        if (index >= cases.length) return Promise.resolve();
        if (shouldStop()) { stopped = true; return Promise.resolve(); }

        var batch = cases.slice(index, index + chunk);
        index += batch.length;

        return batch.reduce(function (chain, testCase) {
          return chain.then(function () {
            var injured = applyCase(testCase.mutation, envelope);
            return evaluateOnce(compiled, injured).then(function (attempt) {
              var observed = attempt.error ? {} : observe(config, attempt.output);
              var readings = attempt.error ? {} : MappingNodes.readings(config, attempt.output);
              var verdicts = classify(baseline,
                { output: attempt.output, error: attempt.error, readings: readings, observed: observed },
                testCase, config, depsByPath);

              verdicts.forEach(function (verdict) {
                results.push({
                  caseId: testCase.caseId,
                  label: testCase.label,
                  mutation: testCase.mutation,
                  code: verdict.code,
                  level: LEVEL[verdict.severity] || "warn",
                  severity: verdict.severity || SEVERITY[verdict.code] || "low",
                  confidence: verdict.confidence,
                  blastRadius: verdict.blastRadius,
                  nodePath: verdict.nodePath,
                  errorCode: verdict.errorCode || null,
                  message: verdict.message
                });
              });
            });
          });
        }, Promise.resolve()).then(function () {
          onProgress(index, cases.length, results);
          /* A promise chain is not a yield — microtasks drain before the browser gets a frame,
             so without a macrotask here a long sweep locks the page solid. */
          return yieldSoon().then(step);
        });
      }

      return step().then(function () {
        return { baseline: baseline, results: results, findings: findings, stopped: stopped, ran: index };
      });
    });
  }

  /* ── The suite: a run, committed ───────────────────────────────────────────────────
     What gets written to a file is the CLASSIFICATION, not the payload. A golden snapshot of
     several hundred payloads is unreviewable and churns on every edit; a bare classifier can
     never notice that a case which used to be EXPECTED_ABSENCE is now COLLATERAL. Snapshotting
     the verdict gets both — a diff proportional to the change, and drift that cannot hide. */

  function toSuite(config, planned, run, meta) {
    meta = meta || {};
    var byCase = {};
    (run.results || []).forEach(function (result) {
      var slot = byCase[result.caseId] || (byCase[result.caseId] = []);
      slot.push(result);
    });

    /* Worst verdict per case: a case that both throws and shrinks a list is a throwing case. */
    function verdictOf(caseId) {
      var results = byCase[caseId] || [];
      var best = null;
      results.forEach(function (r) {
        if (!best || ORDER_INDEX[r.severity] < ORDER_INDEX[best.severity]) best = r;
      });
      return best;
    }

    return {
      kind: "jsonata-mapping-suite",
      version: 1,
      generatedBy: "parts/probe.js",
      tier: meta.tier || "standard",
      config: { source: meta.configSource || null, fingerprint: fingerprint(config) },
      envelope: {
        model: { source: meta.modelSource || null, fingerprint: fingerprint(meta.model || null) },
        properties: { source: meta.propertiesSource || null, fingerprint: fingerprint(meta.properties || null) }
      },
      coverage: {
        pointers: planned.pointers,
        untestable: planned.skipped,
        droppedForBudget: planned.truncated || 0
      },
      baseline: {
        findings: (run.findings || []).map(function (f) {
          return { code: f.code, nodePath: f.nodePath, message: f.message, accepted: null };
        })
      },
      cases: (planned.cases || []).map(function (testCase) {
        var verdict = verdictOf(testCase.caseId);
        return {
          id: testCase.caseId,
          mutation: testCase.mutation,
          nodePaths: testCase.nodePaths,
          label: testCase.label,
          expect: {
            classification: verdict ? verdict.code : "NO_RESULT",
            severity: verdict ? verdict.severity : "low",
            errorCode: verdict ? (verdict.errorCode || null) : null
          },
          /* null means "this is a live finding and the gate should fail on it". Filling it in
             is how a known, accepted problem stops being noise without becoming invisible. */
          accepted: null
        };
      })
    };
  }

  var ORDER_INDEX = { blocker: 0, high: 1, medium: 2, low: 3, pass: 4 };

  /**
   * A committed suite against a fresh run. Four outcomes, and only two of them are failures:
   * a case can pass, be an accepted known problem, DRIFT (the verdict changed — always a
   * failure, acceptance does not excuse it), or be NEW. Cases whose target no longer exists are
   * reported as stale so they get pruned rather than quietly carried forever.
   */
  function compare(suite, planned, run) {
    var fresh = {};
    (run.results || []).forEach(function (result) {
      var slot = fresh[result.caseId] || (fresh[result.caseId] = []);
      slot.push(result);
    });
    function worst(caseId) {
      var best = null;
      (fresh[caseId] || []).forEach(function (r) {
        if (!best || ORDER_INDEX[r.severity] < ORDER_INDEX[best.severity]) best = r;
      });
      return best;
    }

    var planIds = {};
    (planned.cases || []).forEach(function (c) { planIds[c.id || c.caseId] = c; });

    var outcomes = [];
    (suite.cases || []).forEach(function (expected) {
      if (!planIds[expected.id]) {
        outcomes.push({ outcome: "stale", id: expected.id, label: expected.label,
          message: "no longer applies — the path it targets is not in the mapping any more" });
        return;
      }
      var actual = worst(expected.id);
      var code = actual ? actual.code : "NO_RESULT";
      if (code !== expected.expect.classification) {
        outcomes.push({
          outcome: "drift", id: expected.id, label: expected.label,
          nodePath: actual ? actual.nodePath : expected.nodePaths[0],
          message: "was " + expected.expect.classification + ", is now " + code,
          detail: actual ? actual.message : null
        });
        return;
      }
      if (expected.expect.severity === "pass") {
        outcomes.push({ outcome: "pass", id: expected.id });
        return;
      }
      outcomes.push({
        outcome: expected.accepted ? "accepted" : "finding",
        id: expected.id, label: expected.label,
        severity: expected.expect.severity,
        nodePath: actual ? actual.nodePath : null,
        message: actual ? actual.message : expected.label
      });
    });

    /* Baseline findings are not cases — nothing is injured to produce them — but a field that
       starts producing nothing against the healthy response is exactly the regression this
       pack exists to catch, and comparing only the cases would let it through. */
    var baselineBefore = {};
    ((suite.baseline || {}).findings || []).forEach(function (f) {
      baselineBefore[f.code + "" + f.nodePath] = f;
    });
    (run.findings || []).forEach(function (f) {
      if (f.severity === "pass") return;
      var key = f.code + "" + f.nodePath;
      var before = baselineBefore[key];
      delete baselineBefore[key];
      if (!before) {
        outcomes.push({
          outcome: "new", id: key, label: f.code,
          severity: f.severity || "medium", nodePath: f.nodePath, message: f.message
        });
        return;
      }
      outcomes.push({
        outcome: before.accepted ? "accepted" : "finding",
        id: key, label: f.code, severity: f.severity || "medium",
        nodePath: f.nodePath, message: f.message
      });
    });
    Object.keys(baselineBefore).forEach(function (key) {
      outcomes.push({ outcome: "stale", id: key, label: baselineBefore[key].code,
        nodePath: baselineBefore[key].nodePath,
        message: "no longer reported — this was fixed, or the field is gone" });
    });

    var known = {};
    (suite.cases || []).forEach(function (c) { known[c.id] = true; });
    (planned.cases || []).forEach(function (c) {
      var id = c.id || c.caseId;
      if (known[id]) return;
      var actual = worst(id);
      outcomes.push({
        outcome: "new", id: id, label: c.label,
        severity: actual ? actual.severity : "low",
        nodePath: actual ? actual.nodePath : null,
        message: actual ? actual.message : c.label
      });
    });

    return outcomes;
  }

  /** Everything a run has to say about one field, for the badge on its card. */
  function index(results, findings) {
    var byPath = {};
    function bump(nodePath, level, own) {
      var entry = byPath[nodePath] || (byPath[nodePath] = { fail: 0, warn: 0, broken: 0 });
      if (own === false) entry.broken++;
      else if (level === "error") entry.fail++;
      else if (level === "warn") entry.warn++;
    }
    (findings || []).forEach(function (f) { bump(f.nodePath, f.level, true); });
    (results || []).forEach(function (r) {
      if (r.severity === "pass" || r.code === "NO_EFFECT") return;
      bump(r.nodePath, r.level, r.code !== "COLLATERAL");
    });
    return byPath;
  }

  return {
    dependencies: dependencies,
    discoverProperties: discoverProperties,
    staticFindings: staticFindings,
    plan: plan,
    applyCase: applyCase,
    run: run,
    toSuite: toSuite,
    compare: compare,
    observe: observe,
    index: index,
    describeCase: describeCase,
    fingerprint: fingerprint,
    canonical: canonical,
    MUTATIONS: MUTATIONS,
    ENVELOPE_CASES: ENVELOPE_CASES,
    TIERS: Object.keys(TIERS),
    _internal: { mutate: mutate, readAt: readAt, pointerOf: pointerOf, diffReadings: diffReadings, WILDCARD: WILDCARD }
  };
});
