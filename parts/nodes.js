/* ══════════════════════════════════════════════════════════════════════════════════════
   nodes.js — the generic mapping model.

   The model this replaced hardcoded one payload shape: a fixed header with a closed enum of
   target keys, then a fixed three-level group/section/field hierarchy, each level a bespoke
   template in the generator and a bespoke renderer in the form. Nothing else could be
   expressed, and adding one key meant editing four files.

   Here there is one recursive node type. A node is an object, an array, or a leaf:

     { key, type: "object" | "array" | "leaf", ...  , children: [] }

   That hierarchy is not special — it is just a tree that happens to be shaped that way. A
   group is an array node, a section is an object node, a field is a leaf. Any other shape is
   equally expressible.

   Written as portable ES5 with a UMD wrapper, so build.mjs can inline it verbatim and node
   can require() it in a test.
   ══════════════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MappingNodes = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ── Small helpers ─────────────────────────────────────────────────────────────────── */

  var isSet = function (value) {
    return typeof value === "string" ? value.trim() !== "" : value !== undefined && value !== null;
  };

  /** JSON.stringify is the escaping authority for string literals — quotes, backslashes,
      newlines and everything else are already handled correctly by it. */
  var lit = function (text) { return JSON.stringify(String(text)); };

  var csv = function (text) {
    return String(text || "").split(",").map(function (part) { return part.trim(); }).filter(Boolean);
  };

  var pad = function (depth) { return new Array(depth + 1).join("  "); };

  /**
   * A dotted path, safely. The old generator spliced the user's text straight in, so a
   * perfectly ordinary key like "order-no" was emitted as `$record.order-no` — which COMPILES,
   * as a subtraction, and silently drops the field. A key with a space did not compile at
   * all. Every segment that is not a plain identifier is backtick-quoted, which is JSONata's
   * own escape for exactly this.
   */
  var PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/;
  var RESERVED = { "true": 1, "false": 1, "null": 1, "and": 1, "or": 1, "in": 1, "function": 1 };

  /**
   * The same decisions pathRef makes, but as data rather than as text. Anything that wants to
   * FOLLOW a path — reach the value it addresses in an actual document, rather than render a
   * reference to it — needs the segments, and needs to know that the "0" in "items.0.name" is
   * an array index and not a key. Splitting on "." at the call site would get both wrong, so
   * there is one parser and pathRef is a renderer over it.
   */
  function parsePath(path) {
    var trimmed = String(path).trim();
    if (trimmed === "$index") return { kind: "index", segments: [] };
    /* "the current value itself" — what an array of plain values needs for its item. Without
       it a scalar array could only be built from a property OF the item, never the item. */
    if (trimmed === "$self" || trimmed === "." || trimmed === "$") return { kind: "self", segments: [] };
    var segments = [];
    String(path).split(".").forEach(function (segment) {
      var step = segment.trim();
      if (!step) return;
      /* "items.0.name" almost always means the first element, not a key literally named "0".
         Emitting it as a quoted key produced nothing at all, silently. */
      segments.push(/^[0-9]+$/.test(step) ? Number(step) : step);
    });
    return { kind: "segments", segments: segments };
  }

  function pathRef(path) {
    var parsed = parsePath(path);
    if (parsed.kind === "index") return "$index";
    if (parsed.kind === "self") return "$";
    var out = "";
    parsed.segments.forEach(function (step) {
      if (typeof step === "number") { out += "[" + step + "]"; return; }
      var ref = PLAIN.test(step) && !RESERVED[step] ? step : "`" + step.replace(/`/g, "") + "`";
      out += out ? "." + ref : ref;
    });
    return out;
  }

  /* ── Value expressions ─────────────────────────────────────────────────────────────── */

  var TRANSFORMS = {
    none: function (inner) { return inner; },
    string: function (inner) { return "$string(" + inner + ")"; },
    number: function (inner) { return "$number(" + inner + ")"; },
    boolean: function (inner) { return "$boolean(" + inner + ")"; },
    /* These three throw T0410 on a non-string, which aborts the WHOLE mapping and discards
       every other correctly-mapped key. One numeric field should not cost the payload. */
    uppercase: function (inner) { return "$uppercase($string(" + inner + "))"; },
    lowercase: function (inner) { return "$lowercase($string(" + inner + "))"; },
    trim: function (inner) { return "$trim($string(" + inner + "))"; },
    date: function (inner) { return "$substring($string(" + inner + "), 0, 10)"; }
  };

  /**
   * What a leaf reads, in precedence order: raw expression, constant, joined paths, single
   * path — then fallback, transform, and affixes wrapped around the result.
   */
  function valueExpr(node, scope, indexScope) {
    var base = null;

    if (isSet(node.expression)) base = "(" + String(node.expression).trim() + ")";
    else if (isSet(node.constant)) base = lit(node.constant);
    else if (isSet(node.sources)) {
      var parts = (Array.isArray(node.sources) ? node.sources : csv(node.sources))
        .map(function (path) { return scope(pathRef(path)); });
      if (parts.length > 1) {
        var joiner = node.separator === undefined ? "" : String(node.separator);
        /* Concatenating with & put the separator in even when a part was missing, so partial
           data produced "-N" or "N-". $join over the present values only never does that. */
        base = "$join([" + parts.join(", ") + "].$string($), " + lit(joiner) + ")";
      } else if (parts.length === 1) base = parts[0];
    }
    if (base === null && isSet(node.source)) base = scope(pathRef(node.source));

    /* "Number each one" — the tick that builds Line 1, Line 2. The position
       comes from the ENCLOSING array regardless of where the value was read from, so it is
       resolved against the immediate scope rather than the (possibly outer) value scope. */
    if (node.appendIndex && indexScope) {
      var position = indexScope("$index");
      var glue = node.indexSeparator === undefined ? "" : String(node.indexSeparator);
      base = base === null
        ? position
        : "($string(" + base + ") & " + lit(glue) + " & " + position + ")";
    }
    if (base === null) return null;

    if (isSet(node.fallbackSource)) {
      var fallback = scope(pathRef(node.fallbackSource));
      base = "($v := " + base + "; $exists($v) and $string($v) != \"\" ? $v : " + fallback + ")";
    }

    var transform = TRANSFORMS[node.transform || "none"] || TRANSFORMS.none;
    base = transform(base);

    /* isSet() trims, which ate a deliberate single-space prefix or suffix. "Provided and not
       empty" is the right test for text the user typed verbatim. */
    var given = function (value) { return typeof value === "string" && value !== ""; };
    if (given(node.prefix)) base = "(" + lit(node.prefix) + " & $string(" + base + "))";
    if (given(node.suffix)) base = "($string(" + base + ") & " + lit(node.suffix) + ")";
    return base;
  }

  /* ── Filters ───────────────────────────────────────────────────────────────────────── */

  var OPERATORS = {
    exists: function (left) { return "$exists(" + left + ")"; },
    notExists: function (left) { return "$not($exists(" + left + "))"; },
    equals: function (left, value) { return "$string(" + left + ") = " + lit(value); },
    notEquals: function (left, value) { return "$string(" + left + ") != " + lit(value); },
    contains: function (left, value) { return "$contains($string(" + left + "), " + lit(value) + ")"; },
    notContains: function (left, value) { return "$not($contains($string(" + left + "), " + lit(value) + "))"; },
    "in": function (left, value) {
      return "$string(" + left + ") in [" + csv(value).map(lit).join(", ") + "]";
    },
    notIn: function (left, value) {
      return "$not($string(" + left + ") in [" + csv(value).map(lit).join(", ") + "])";
    }
  };

  var NEEDS_VALUE = { equals: 1, notEquals: 1, contains: 1, notContains: 1, "in": 1, notIn: 1 };

  function filterExpr(node) {
    if (isSet(node.filterExpression)) return String(node.filterExpression).trim();
    var operator = OPERATORS[node.filterOperator];
    if (!operator || !isSet(node.filterPath)) return null;
    /* Without this, an unset filterValue became the literal string "undefined" and the
       predicate quietly matched nothing at all. */
    if (NEEDS_VALUE[node.filterOperator] && node.filterValue === undefined) return null;
    return operator(pathRef(node.filterPath), node.filterValue);
  }

  /* ── Emission ──────────────────────────────────────────────────────────────────────── */

  /**
   * Every node emits against a `scope` function that decides how a bare path is addressed at
   * this depth. At the root that is `model.<path>`; inside an array it is the loop variable.
   * That single indirection is what the old four-level template hardcoded.
   */
  /**
   * A scope is a chain, not a single function. Inside an array the current record is the loop
   * variable, but a leaf often needs a value from the record ONE LEVEL OUT — an operation row
   * carrying the order's number, say. The first cut replaced the parent scope outright,
   * which silently killed every such field, so the chain is kept and `node.scope` picks a link.
   */
  function chain(ref, parent) { return { ref: ref, parent: parent || null }; }

  function resolve(ctx, mode) {
    /* "root" means the outermost RECORD — the order, the ticket, whatever repeats — not the
       response document, which
       is where the old model pointed. So stop one link short of the model scope. */
    if (mode === "root") { var top = ctx; while (top.parent && top.parent.parent) top = top.parent; return top; }
    if (mode === "parent") return ctx.parent || ctx;
    /* "auto" is the old model's default: look on this record, and fall back to the enclosing
       one. Most fields on a repeating row want it — a plant code lives on the header, not on
       the line — and without it they resolve to nothing. */
    if (mode === "auto" && ctx.parent) {
      var self = ctx, up = ctx.parent;
      return chain(function (path) {
        if (path === "$") return self.ref(path);
        return "($exists(" + self.ref(path) + ") ? " + self.ref(path) + " : " + up.ref(path) + ")";
      }, up);
    }
    return ctx;
  }

  function emitNode(node, ctx, depth, insideArray) {
    if (!node) return null;
    var type = node.type || "leaf";
    if (type === "leaf") return valueExpr(node, resolve(ctx, node.scope).ref, ctx.ref);
    if (type === "object") return emitObject(node, ctx, depth);
    if (type === "array") return emitArray(node, ctx, depth, insideArray);
    if (type === "list") return emitList(node, ctx, depth);
    return null;
  }

  /**
   * One list assembled from several differently-sourced children — the shape the old model
   * could only reach by hardcoding "Groups". Each child emits its own array and they are
   * appended, so the result is a flat list rather than a list of lists.
   */
  function emitList(node, ctx, depth) {
    var parts = [];
    (node.children || []).forEach(function (child) {
      var emitted = emitNode(child, ctx, depth + 1);
      if (emitted !== null) parts.push(emitted);
    });
    if (!parts.length) return null;
    /* Folding from [] keeps one child and many children on the same path, and $append(...)
       is a call rather than a bracket constructor, so wrapping it can never nest. */
    var joined = parts.reduce(function (left, right) {
      return "$append(" + left + ", " + right + ")";
    }, "[]");
    return node.alwaysArray === false ? joined : "[" + joined + "]";
  }

  function emitObject(node, ctx, depth) {
    var entries = [];
    var used = {};
    (node.children || []).forEach(function (child) {
      if (!isSet(child.key)) return;
      /* A duplicate key is a runtime failure in JSONata, so the second one is dropped here
         and reported by validate() rather than being emitted into a doomed expression. */
      if (used[child.key]) return;
      var value = emitNode(child, ctx, depth + 1);
      if (value === null) return;
      used[child.key] = true;
      entries.push(pad(depth + 1) + lit(child.key) + ": " + value);
    });
    if (!entries.length) return null;
    return "{\n" + entries.join(",\n") + "\n" + pad(depth) + "}";
  }

  /**
   * The element node. `children` is still accepted and read as an object body, so mappings
   * written before this change keep working.
   */
  function itemOf(node) {
    if (node.item) return node.item;
    if ((node.children || []).length) return { type: "object", children: node.children };
    return null;
  }

  function emitArray(node, ctx, depth, insideArray) {
    var item = "$item" + depth;
    var scope = resolve(ctx, node.scope).ref;

    /* No source means one element built from the current context — the "single instance"
       case, which the old model could only express by special-casing the record. It must NOT be
       bracketed here: `wrapped` below adds the one and only [], and [[x]] nests. */
    var list = isSet(node.sourceExpression)
      ? "(" + String(node.sourceExpression).trim() + ")"
      : isSet(node.source) ? scope(pathRef(node.source)) : scope("$");

    var predicate = filterExpr(node);
    if (predicate) list = "(" + list + ")[" + predicate + "]";

    /* alwaysArray is the whole reason this flag exists: JSONata collapses a one-element
       sequence to the bare value, so a target expecting a list gets an object instead. The
       [] constructor keeps it a list at every cardinality, including zero and one — and it
       has to wrap BOTH ends: the input, so a lone object still iterates once, and the
       result, so a lone output stays a list. */
    var always = node.alwaysArray !== false;
    /* A JSON null source is a value, so [null] iterated once and produced a phantom empty
       record. APIs return "lines": null all the time; that has to mean no records. */
    /* $exists(null) is TRUE in JSONata — null is a value that exists — so filtering on it
       kept the null and $map produced a phantom empty record. Compare against null instead. */
    var wrapped = always ? "$filter([" + list + "], function($v) { $v != null })" : list;

    /* $map hands the lambda (value, index), so a node can address its own position. That is
       what builds "Line 1" / "Line 2" style row identifiers, which the old model hardcoded. */
    var idx = "$idx" + depth;
    var inner = chain(function (path) {
      if (path === "$index") return "($string(" + idx + " + 1))";
      return path === "$" ? item : item + "." + path;
    }, ctx);
    /* What each element IS, as a node in its own right. Previously `children` meant "the
       properties of each element", which hardcoded that every array is an array of objects;
       a scalar array needed an unnamed-child convention and a $self token to reach the
       element. An item node needs neither. */
    var element = itemOf(node);
    var body = emitNode(element, inner, depth + 1, true);
    /* An array with nothing in it used to emit its raw source, dumping every upstream object
       verbatim into the payload — and validate() simultaneously claimed it would not appear. */
    if (body === null) return null;

    var mapped = "$map(" + wrapped + ", function(" + item + ", " + idx + ") {\n" +
      pad(depth + 1) + body + "\n" + pad(depth) + "})";
    var out = always ? "[" + mapped + "]" : mapped;
    /* JSONata merges a sequence returned into a sequence context, so without this three or
       more array levels collapse to two. Searching the wrap space showed the rule is one
       extra [] on every level that is neither the outermost nor the innermost — i.e. an
       array that sits inside another array AND whose own element is a list. */
    if (insideArray && element && (element.type === "array" || element.type === "list")) {
      out = "[" + out + "]";
    }
    return out;
  }

  /**
   * config -> JSONata. The root is a node like any other; `model` is where the source
   * response lives (the mapper action nests it there) and `$$.properties` reaches flow
   * properties, exactly as before.
   */
  function generate(config) {
    config = config || {};
    var rootNode = config.root || { type: "object", children: [] };
    var body = emitNode(rootNode, chain(function (path) {
      return path === "$" ? "model" : "model." + path;
    }, null), 1);
    return "(\n" + pad(1) + (body === null ? "{}" : body) + "\n)\n";
  }

  /* ── Validation ────────────────────────────────────────────────────────────────────────
     The old model had no validation layer at all: schema.required was never read, duplicate
     identifiers generated happily, and a blank key silently dropped the node. Everything
     here names the node it is complaining about so the form can point at it. */

  function validate(config) {
    var problems = [];
    /* per-object duplicate detection lives in the child loop */

    function report(level, code, nodePath, message) {
      problems.push({ level: level, code: code, nodePath: nodePath, message: message });
    }

    function walk(node, nodePath, parentType, isScalarItem) {
      if (!node) return;
      var label = nodePath || "(root)";
      var type = node.type || "leaf";

      /* An array's children are emitted through emitObject too, so they need the same key
         rules — skipping them let duplicates through to a runtime failure that named nothing.
         The exception is a lone unnamed child, which is how an array of plain values is
         written (a list of plain values) — that one is unnamed on purpose. */
      if ((parentType === "object" || parentType === "array") && !isSet(node.key) && !isScalarItem) {
        report("error", "KEY_BLANK", nodePath, "This entry has no name, so it cannot be written to the target.");
      }
      /* Duplicates are only a problem within one object, so they are detected by the parent
         in its child loop below — a global path check would double-report every one. */

      ["source", "fallbackSource", "filterPath"].forEach(function (key) {
        if (!isSet(node[key])) return;
        var text = String(node[key]);
        var token = text.trim();
        if (token === "$index" || token === "$self" || token === "$" || token === ".") return;
        /* A backtick cannot be escaped inside a backtick-quoted step, and an empty segment
           silently retargets the path at a DIFFERENT key — both are refusals, not warnings. */
        if (text.indexOf("`") >= 0) {
          report("error", "PATH_BACKTICK", nodePath,
            "“" + text + "” contains a backtick, which cannot be used in a path here.");
        }
        if (/(^\.)|(\.\.)|(\.$)/.test(text)) {
          report("error", "PATH_MALFORMED", nodePath,
            "“" + text + "” has an empty step — check the dots.");
        }
        text.split(".").forEach(function (segment) {
          var step = segment.trim();
          if (step && !PLAIN.test(step) && step.indexOf("`") < 0) {
            report("warn", "PATH_QUOTED", nodePath,
              "“" + text + "” contains characters that need quoting; it is escaped automatically.");
          }
        });
      });

      if (type === "leaf") {
        if (node.appendIndex) return;   // the position alone is a value
        var hasValue = ["source", "sources", "constant", "expression"].some(function (key) {
          var value = node[key];
          if (Array.isArray(value)) return value.length > 0;
          return isSet(value);
        });
        if (!hasValue) {
          report("error", "LEAF_NO_VALUE", nodePath,
            "“" + (node.key || label) + "” has no source path, constant or expression, so it emits nothing.");
        }
      } else {
        if (type === "array" && !itemOf(node)) {
          report("warn", "ARRAY_NO_ITEM", nodePath,
            "\u201c" + (node.key || label) + "\u201d does not say what each item is, so it will not appear in the payload.");
        }
        if (type !== "array" && !(node.children || []).length) {
          report("warn", "CONTAINER_EMPTY", nodePath,
            "“" + (node.key || label) + "” has nothing inside it, so it will not appear in the payload.");
        }
        if (node.filterOperator && !isSet(node.filterPath) && !isSet(node.filterExpression)) {
          report("warn", "FILTER_NO_PATH", nodePath, "A filter is chosen but no path to filter on is set, so it is ignored.");
        }
        if ((node.filterOperator === "in" || node.filterOperator === "notIn") && !csv(node.filterValue).length) {
          report("error", "FILTER_EMPTY_LIST", nodePath,
            "The list to match against is empty, so this filter removes everything.");
        }
        var element = type === "array" ? itemOf(node) : null;
        if (element) {
          walk(element, nodePath + "/(each item)", "item", false);
        }

        var childSeen = {};
        /* An array's body is its item. Walking children as well reported every problem twice,
           the second copy at a path no rendered card matches. */
        (type === "array" ? [] : (node.children || [])).forEach(function (child, index) {
          var childPath = nodePath + "/" + (isSet(child.key) ? child.key : "[" + index + "]");
          if (isSet(child.key) && (type === "object" || type === "array")) {
            if (childSeen[child.key]) {
              report("error", "KEY_DUPLICATE", childPath,
                "“" + child.key + "” is used twice in the same object — JSONata rejects duplicate keys at run time.");
            }
            childSeen[child.key] = true;
          }
          var loneUnnamed = (node.children || []).length === 1 && !isSet(child.key)
            && (type === "array" || type === "list");
          walk(child, childPath, type, loneUnnamed);
        });
      }
    }

    walk((config || {}).root, "", null);
    return problems;
  }

  /**
   * config + evaluated output -> { nodePath: [values] }, by walking both trees together.
   * Generic: it follows the node types rather than knowing any particular payload shape, so
   * every level of the form can show what it actually produced.
   */
  function readings(config, output) {
    var found = {};

    function walk(node, value, nodePath) {
      if (!node) return;
      var type = node.type || "leaf";
      if (type === "leaf") {
        found[nodePath] = Array.isArray(value) ? value : [value];
        return;
      }
      /* An array or list produces many elements; the form shows the first as representative
         and counts the rest. */
      var sample = Array.isArray(value) ? value[0] : value;
      found[nodePath] = Array.isArray(value) ? [value.length + " item" + (value.length === 1 ? "" : "s")] : [];

      if (type === "list") {
        /* A list flattens N children into one array, so child i does NOT live at output[0] —
           handing every child the first element made all but one card show the wrong values.
           Match each child to the first element carrying that child's own keys instead. */
        var pool = Array.isArray(value) ? value.slice() : [];
        (node.children || []).forEach(function (child, index) {
          var wanted = ((itemOf(child) || child).children || []).map(function (g) { return g.key; }).filter(isSet);
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

  return {
    generate: generate,
    validate: validate,
    readings: readings,
    /* exported so the form and the tests can share one definition of the vocabulary */
    TRANSFORMS: Object.keys(TRANSFORMS),
    OPERATORS: Object.keys(OPERATORS),
    pathRef: pathRef,
    /* the structural half of pathRef — what the probe follows to reach a value */
    parsePath: parsePath,
    itemOf: itemOf,
    _internal: { valueExpr: valueExpr, emitNode: emitNode, filterExpr: filterExpr }
  };
});
