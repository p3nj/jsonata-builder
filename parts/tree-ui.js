/* ══════════════════════════════════════════════════════════════════════════════════════
   tree-ui.js — one renderer for every level of the mapping.

   The form this replaced had two renderers: a hardcoded header block with four fixed
   controls, and a bespoke composite that knew the three-level hierarchy. A header key had to
   come from a closed enum of eleven names, and there was no way to nest anything.

   Here every node draws the same way. A container (object / array / list) is a card; a leaf
   is a row. The root is a card like any other — which is why the header block is no longer a
   special region of the screen, just the outermost card.
   ══════════════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MappingTreeUI = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TYPES = [
    { value: "leaf", label: "value" },
    { value: "object", label: "object { }" },
    { value: "array", label: "array [ ] — repeats over a source" },
    { value: "list", label: "list [ ] — several sources joined" }
  ];

  var ADVANCED = [
    { key: "constant", label: "Constant", hint: "A fixed value, used instead of the source path." },
    { key: "sources", label: "Joined paths", hint: "Several paths joined together, comma separated. e.g. header.channel, header.status" },
    { key: "separator", label: "Join separator", hint: "Placed between the joined paths, e.g. /" },
    { key: "fallbackSource", label: "Fallback path", hint: "Used only when the first path finds nothing or an empty value." },
    { key: "scope", label: "Look for the path", enum: ["auto", "instance", "parent", "root"],
      hint: "Where to read from when this sits inside a repeating list: on this record, on the one containing it, or on the outermost record." },
    { key: "transform", label: "Transform", hint: "Change the value's shape or type before it is written.",
      enum: ["none", "string", "number", "boolean", "uppercase", "lowercase", "trim", "date"] },
    { key: "appendIndex", label: "Number each one", type: "boolean",
      hint: "Adds this record's position — 1, 2, 3 — on the end. With a prefix of \u201cLine \u201d and nothing else, that gives Line 1, Line 2." },
    { key: "indexSeparator", label: "Before the number, put", hint: "Placed between the value and the position, e.g. a dash. Leave blank for none." },
    { key: "prefix", label: "Prefix", hint: "Text put in front of the value." },
    { key: "suffix", label: "Suffix", hint: "Text put after the value." },
    { key: "expression", label: "Expression (raw JSONata)", wide: true,
      hint: "Overrides everything else. $ is the current record; model is the source response." }
  ];

  var FILTERS = [
    { key: "filterPath", label: "Only keep records where", hint: "The path to test on each record." },
    { key: "filterOperator", label: "…this test passes", enum: ["", "exists", "notExists", "equals", "notEquals", "contains", "notContains", "in", "notIn"] },
    { key: "filterValue", label: "…against this value", hint: "For 'is one of', give a comma separated list." }
  ];

  var ENUM_LABELS = {
    "": "(no filter)", exists: "has any value", notExists: "is missing or blank",
    equals: "is", notEquals: "is not", contains: "contains", notContains: "does not contain",
    "in": "is one of", notIn: "is not one of",
    none: "no change", string: "force to text", number: "force to a number",
    boolean: "force to true/false", uppercase: "UPPERCASE", lowercase: "lowercase",
    trim: "trim spaces", date: "date only (YYYY-MM-DD)",
    leaf: "a single value", object: "an object { }", array: "a list [ ]", list: "several lists joined",
    auto: "this record, then the one around it", instance: "this record only",
    parent: "the record around this one", root: "the outermost record"
  };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function label(value) {
    return Object.prototype.hasOwnProperty.call(ENUM_LABELS, value) ? ENUM_LABELS[value] : value;
  }

  function create(options) {
    var host = options.host;
    var getConfig = options.getConfig;
    var onChange = options.onChange || function () {};
    var onStructureChange = options.onStructureChange || function () {};
    var getReadings = options.getReadings || function () { return {}; };
    var getProblems = options.getProblems || function () { return []; };
    /* What the fault-injection run found for one field, and for a whole branch. Two functions
       rather than one because a collapsed card has to answer for its children — a fault inside
       a folded branch is otherwise invisible, and cards default to collapsed below depth 0. */
    var getRisk = options.getRisk || function () { return null; };
    var getRiskBranch = options.getRiskBranch || function () { return null; };
    var onRiskClick = options.onRiskClick || function () {};
    var collapsed = options.collapsed || {};
    var focusId = null;

    function tierOf(node) {
      var type = node.type || "leaf";
      return type === "leaf" ? "fld" : type === "object" ? "sec" : "grp";
    }

    function input(value, placeholder, onInput, cls) {
      var box = el("input", cls || "control");
      box.type = "text";
      box.value = value === undefined || value === null ? "" : value;
      box.placeholder = placeholder || "";
      box.addEventListener("input", function () { onInput(box.value); onChange(); });
      return box;
    }

    function select(value, values, onPick) {
      var box = el("select", "control");
      values.forEach(function (choice) {
        var option = el("option", null, label(choice));
        option.value = choice;
        box.appendChild(option);
      });
      box.value = value === undefined ? values[0] : value;
      box.addEventListener("change", function () { onPick(box.value); onChange(); });
      return box;
    }

    function field(labelText, control, hint) {
      var wrap = el("div", "field");
      wrap.appendChild(el("label", null, labelText));
      wrap.appendChild(control);
      if (hint) wrap.appendChild(el("div", "hint", hint));
      return wrap;
    }

    function problemsFor(path) {
      return getProblems().filter(function (problem) { return problem.nodePath === path; });
    }

    function attachProblems(target, path) {
      var mine = problemsFor(path);
      if (!mine.length) return;
      var worst = mine.some(function (p) { return p.level === "error"; }) ? "error" : "warn";
      target.classList.add("node--" + worst);
      var box = el("div", "node__problems");
      mine.forEach(function (problem) {
        box.appendChild(el("div", "note note--" + (problem.level === "error" ? "bad" : "warn"), problem.message));
      });
      target.appendChild(box);
    }

    /**
     * The badge a fault-injection run leaves on a field. Two numbers, because a field can fail
     * two different ways and only one of them is its own doing: cases that injure what THIS
     * field reads, and cases that injure something else and damage it anyway. The second is the
     * one nothing else on the page can show, so it outranks the first for colour.
     */
    function riskBadge(path, branch) {
      var risk = branch ? getRiskBranch(path) : getRisk(path);
      var span = el("span", (branch ? "card__risk" : "row__risk"));
      if (!risk || (!risk.fail && !risk.warn && !risk.broken)) return span;   // :empty hides it

      var words = [];
      if (risk.fail) words.push(risk.fail + " fail");
      if (risk.broken) words.push("broken by " + risk.broken);
      if (!risk.fail && !risk.broken && risk.warn) words.push(risk.warn + " to check");
      span.textContent = words.join(" · ");
      span.classList.add(risk.broken || risk.fail ? "is-bad" : "is-warn");
      if (risk.stale) span.classList.add("is-stale");
      span.title = branch
        ? "Something inside this is not holding up. Click to see the cases."
        : "This field breaks under the test cases. Click to see them.";
      span.addEventListener("click", function (event) {
        event.stopPropagation();          // the card head toggles; the badge navigates
        onRiskClick(path);
      });
      return span;
    }

    /** A card wears its worst descendant's colour, so a folded branch cannot hide a fault. */
    function markBranch(card, path) {
      var risk = getRiskBranch(path);
      if (!risk) return;
      if (risk.fail || risk.broken) card.classList.add("card--has-error");
      else if (risk.warn) card.classList.add("card--has-warn");
      if (risk.stale) card.classList.add("is-stale");
    }

    /* ── a leaf ─────────────────────────────────────────────────────────────────────── */
    function renderLeaf(node, path, parent, index, depth) {
      var row = el("div", "row row--fld");
      row.dataset.nodePath = path;
      row.dataset.nodeId = node.__id;
      row.dataset.depth = String((depth || 0) % 6);

      var keyBox = input(node.key, "name", function (value) { node.key = value; });
      keyBox.dataset.role = "key";
      row.appendChild(keyBox);
      row.appendChild(el("span", "row__link", "←"));

      var source = input(node.source, "dotted.path", function (value) { node.source = value; });
      source.dataset.role = "source";
      source.setAttribute("list", "paths-all");
      row.appendChild(source);

      var readout = el("span", "row__value");
      var values = getReadings()[path];
      if (values && values.length && values[0] !== undefined) {
        var text = typeof values[0] === "string" ? values[0] : JSON.stringify(values[0]);
        readout.textContent = text.length > 32 ? text.slice(0, 32) + "…" : text;
        readout.title = String(values[0]);
      } else if (node.constant) {
        readout.textContent = node.constant;
        readout.className = "row__value";
      } else {
        readout.textContent = "nothing";
        readout.className = "row__value row__value--empty";
      }
      row.appendChild(readout);
      /* Before the "more" button, so the row's right edge — more, ✕ — stays where the hands
         expect it whether or not a run has happened. */
      row.appendChild(riskBadge(path, false));

      var key = node.__id + "#adv";
      var open = !!collapsed[key];
      var more = el("button", "btn btn--ghost btn--tiny", open ? "▾ more" : "▸ more");
      more.type = "button";
      more.addEventListener("click", function () { collapsed[key] = !open; onStructureChange(); });
      row.appendChild(more);
      if (parent) row.appendChild(removeButton(parent, index));

      if (open) {
        var extra = el("div", "row__extra");
        ADVANCED.forEach(function (spec) {
          var control;
          if (spec.type === "boolean") {
            control = el("label", "check");
            var tick = el("input");
            tick.type = "checkbox";
            tick.checked = !!node[spec.key];
            tick.addEventListener("change", function () {
              node[spec.key] = tick.checked || undefined;
              onChange();
            });
            control.appendChild(tick);
            control.appendChild(document.createTextNode(" " + spec.label));
          } else if (spec.enum) {
            control = select(node[spec.key] || spec.enum[0], spec.enum, function (v) { node[spec.key] = v === spec.enum[0] ? undefined : v; });
          } else {
            control = input(node[spec.key], "", function (v) { node[spec.key] = v || undefined; });
          }
          /* Every control that can hold the caret needs a role, because that is the only handle
             restoreFocus has after the repaint. Without one the "more" fields were all
             anonymous, and focus was handed back to the first input in the row — the name box —
             a fifth of a second into typing a prefix or a fallback path. */
          (spec.type === "boolean" ? tick : control).dataset.role = "adv:" + spec.key;
          if (spec.key === "sources" && Array.isArray(node.sources)) control.value = node.sources.join(", ");
          if (spec.key === "sources") {
            control.addEventListener("input", function () {
              node.sources = control.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
            });
          }
          var wrap = spec.type === "boolean"
            ? (function () { var w = el("div", "field"); w.appendChild(el("label"));
                             w.appendChild(control);
                             if (spec.hint) w.appendChild(el("div", "hint", spec.hint)); return w; })()
            : field(spec.label, control, spec.hint);
          if (spec.wide) wrap.className = "field field--wide";
          extra.appendChild(wrap);
        });
        row.appendChild(extra);
      }

      attachProblems(row, path);
      if (focusId && focusId === node.__id) {
        focusId = null;
        setTimeout(function () {
          var first = row.querySelector("input");
          if (first) { first.focus(); first.select(); row.scrollIntoView({ block: "center" }); }
        }, 0);
      }
      return row;
    }

    function removeButton(parent, index) {
      var button = el("button", "btn btn--ghost btn--tiny", "✕");
      button.type = "button";
      button.title = "Remove";
      button.addEventListener("click", function () {
        parent.splice(index, 1);
        onStructureChange();
      });
      return button;
    }

    /* ── a container ────────────────────────────────────────────────────────────────── */
    function renderContainer(node, path, parent, index, depth) {
      var type = node.type || "object";
      var card = el("div", "card card--" + tierOf(node));
      card.dataset.nodePath = path;
      card.dataset.nodeId = node.__id;
      card.dataset.depth = String(depth % 6);   // six hues, then repeat

      var head = el("div", "card__head");
      var isCollapsed = node.__id in collapsed ? !!collapsed[node.__id] : depth > 0;
      var toggle = el("button", "disclosure", isCollapsed ? "▸" : "▾");
      toggle.type = "button";
      toggle.addEventListener("click", function () { collapsed[node.__id] = !isCollapsed; onStructureChange(); });
      head.appendChild(toggle);
      head.appendChild(el("span", "badge badge--" + tierOf(node), type === "object" ? "OBJ" : type === "list" ? "LIST" : "ARR"));

      var isItem = /\/\(each item\)$/.test(path);
      if (isItem) {
        /* An array element has no key, so a name box here accepted input and did nothing. */
        head.appendChild(el("span", "card__name card__name--fixed", "each item"));
      } else {
        var name = input(node.key, depth === 0 ? "(root)" : "name", function (value) { node.key = value; }, "control card__name");
        name.dataset.role = "key";
        head.appendChild(name);
      }

      var counts = [];
      if (type === "array") {
        counts.push(node.item ? "each: " + label(node.item.type || "leaf") : "no item set");
      } else {
        counts.push((node.children || []).length + " item" + ((node.children || []).length === 1 ? "" : "s"));
      }
      if (node.source) counts.push("↻ " + node.source);
      head.appendChild(el("span", "card__meta", counts.join(" · ")));
      head.appendChild(riskBadge(path, true));
      markBranch(card, path);
      if (parent) head.appendChild(removeButton(parent, index));
      card.appendChild(head);

      if (!isCollapsed) {
        var body = el("div", "card__body");

        if (type === "array" || type === "list") {
          var always = el("label", "check");
          var box = el("input");
          box.type = "checkbox";
          box.dataset.role = "alwaysArray";
          box.checked = node.alwaysArray !== false;
          box.addEventListener("change", function () { node.alwaysArray = box.checked; onChange(); });
          always.appendChild(box);
          always.appendChild(document.createTextNode(" Always send a list, even with one item"));
          body.appendChild(always);
        }

        if (type === "array") {
          var src = input(node.source, "dotted.path to the repeating array", function (v) { node.source = v || undefined; });
          src.dataset.role = "source";
          src.setAttribute("list", "paths-array");
          body.appendChild(field("Repeat over", src,
            "One element of the payload per element of this array. The path is relative to the record this sits in \u2014 lines, not result.orders.lines. Leave blank for a single element built from the current record."));

          var filters = el("div", "hstack");
          FILTERS.forEach(function (spec) {
            var control = spec.enum
              ? select(node[spec.key] || "", spec.enum, function (v) { node[spec.key] = v || undefined; })
              : input(node[spec.key], "", function (v) { node[spec.key] = v || undefined; });
            control.dataset.role = "filter:" + spec.key;
            filters.appendChild(field(spec.label, control, spec.hint));
          });
          body.appendChild(filters);
        }

        if (type === "array") {
          /* "each item is …" is the question arrays actually pose. It used to be answered by
             a convention nobody could see. */
          var itemBox = el("div", "vstack itemwrap");
          var head = el("div", "hstack");
          head.appendChild(el("span", "itemwrap__label", "Each item is"));
          var kinds = ["leaf", "object", "array", "list"];
          var current = (node.item && node.item.type) || "";
          var kindPicker = select(current, [""].concat(kinds), function (kind) {
            if (!kind) return;
            if (kind === (node.item && node.item.type)) return;
            /* Switching kind used to delete the subtree outright, with no confirm and no
               undo. Each kind's node is kept, so switching away and back restores it. */
            node.__items = node.__items || {};
            if (node.item) node.__items[node.item.type || "leaf"] = node.item;
            var fresh = node.__items[kind];
            if (!fresh) {
              fresh = { type: kind };
              if (kind !== "leaf") fresh.children = [];
              if (kind === "array") fresh.alwaysArray = true;
              if (kind !== "leaf" && node.item && node.item.children) fresh.children = node.item.children;
            }
            node.item = fresh;
            node.children = [];
            onStructureChange();
          });
          /* The shared enum labels render "" as "(no filter)", which is the wrong sentence
             here. */
          kindPicker.dataset.role = "itemKind";
          if (kindPicker.options.length) kindPicker.options[0].textContent = "(not chosen yet)";
          head.appendChild(kindPicker);
          itemBox.appendChild(head);
          /* Rendering used to CREATE the item, so merely expanding a card edited the mapping,
             changed the payload and wrote a history snapshot. The picker just reports "not
             chosen yet" instead. */
          if (node.item) {
            ensureIds(node.item);
            itemBox.appendChild(renderNode(node.item, path + "/(each item)", null, 0, depth + 1));
          } else if ((node.children || []).length) {
            /* A pre-item mapping: show its body where the item now lives. */
            itemBox.appendChild(el("div", "hint", "This array was written before items existed; choose a kind to convert it."));
          } else {
            itemBox.appendChild(el("div", "hint", "Nothing will be produced until you choose what each item is."));
          }
          body.appendChild(itemBox);
        }

        var kids = el("div", "vstack");
        (type === "array" ? [] : (node.children || [])).forEach(function (child, childIndex) {
          kids.appendChild(renderNode(child, path + "/" + (child.key || "[" + childIndex + "]"),
            node.children, childIndex, depth + 1));
        });
        body.appendChild(kids);

        var adders = el("div", "hstack hstack--adders" + (type === "array" ? " hidden" : ""));
        TYPES.forEach(function (spec) {
          var add = el("button", "btn btn--tiny", "+ " + spec.label.split(" ")[0]);
          add.type = "button";
          add.title = spec.label;
          add.addEventListener("click", function () {
            node.children = node.children || [];
            var fresh = { key: "", type: spec.value };
            if (spec.value !== "leaf") { fresh.children = []; }
            if (spec.value === "array") { fresh.alwaysArray = true; collapsed[""] = false; }
            node.children.push(fresh);
            collapsed[node.__id] = false;
            focusOn = fresh;
            onStructureChange();
          });
          adders.appendChild(add);
        });
        body.appendChild(adders);
        card.appendChild(body);
      }

      attachProblems(card, path);
      return card;
    }

    function renderNode(node, path, parent, index, depth) {
      return (node.type || "leaf") === "leaf"
        ? renderLeaf(node, path, parent, index, depth)
        : renderContainer(node, path, parent, index, depth);
    }

    /**
     * Every evaluation repaints the tree, so without this the caret is destroyed ~220ms after
     * you stop typing and the rest of the word goes nowhere. Focus is restored by node id and
     * role rather than by DOM position, so it survives the node moving.
     */
    function captureFocus() {
      var active = document.activeElement;
      if (!active || !host.contains(active)) return null;
      var holder = active.closest("[data-node-id]");
      if (!holder) return null;
      /* selectionStart is only defined for text-like inputs; on a checkbox or a select reading
         it throws in some browsers, and a tick in the "more" panel is a perfectly ordinary
         thing to have focused when the repaint lands. */
      var caret = { start: null, end: null };
      try { caret = { start: active.selectionStart, end: active.selectionEnd }; }
      catch (ignored) { /* not a text field — the role alone is enough to find it again */ }
      return {
        id: holder.dataset.nodeId,
        role: active.dataset.role || "",
        start: caret.start,
        end: caret.end
      };
    }

    function restoreFocus(mark) {
      if (!mark) return;
      var holder = host.querySelector('[data-node-id="' + mark.id + '"]');
      if (!holder) return;
      /* Only ever restore to the control the caret was actually in. This used to fall back to
         the first input in the node when the role was unknown, which meant an unlabelled
         control — every field in the "more" panel — handed the caret to the name box a fifth of
         a second into typing, and the rest of the word renamed the field. Losing focus is a
         disappointment; moving it somewhere that silently eats keystrokes is a bug. */
      var target = mark.role ? holder.querySelector('[data-role="' + mark.role + '"]') : null;
      if (!target) return;
      target.focus();
      if (target.setSelectionRange && mark.start !== null && mark.start !== undefined) {
        try { target.setSelectionRange(mark.start, mark.end); } catch (ignored) {}
      }
    }

    /* Collapse and focus are keyed by a stable id, not by the node's path. Paths contain the
       node's key, so renaming a card used to change its path and slam it shut mid-word. */
    var outlineFolded = {};   // outline-only fold state, keyed by node id
    var nextId = 1;
    var focusOn = null;   // a node object awaiting an id, set when it is created
    function ensureIds(node) {
      if (!node) return;
      if (!node.__id) node.__id = "n" + (nextId++);
      /* Converted configs carry a display-only "label"; promote it so the card has a name
         instead of four identical blank ARR cards. */
      if (!node.key && node.label) node.key = node.label;
      if (focusOn === node) { focusOn = null; focusId = node.__id; }
      if (node.item) ensureIds(node.item);
      (node.children || []).forEach(ensureIds);
    }

    function paint() {
      var config = getConfig() || {};
      if (!config.root) config.root = { type: "object", children: [] };
      ensureIds(config.root);
      var mark = captureFocus();
      host.textContent = "";
      host.appendChild(renderNode(config.root, "", null, 0, 0));
      restoreFocus(mark);
    }

    /* A map of the whole mapping. Once a tree is more than two levels deep the cards alone
       stop answering "where am I" — this does. */
    function paintOutline(outlineHost) {
      if (!outlineHost) return;
      outlineHost.textContent = "";
      var config = getConfig() || {};
      if (!config.root) return;
      ensureIds(config.root);
      var problems = getProblems();

      (function walk(node, depth, nodePath) {
        var type = node.type || "leaf";
        var line = el("div", "outline__row");
        line.style.paddingLeft = (depth * 14 + 8) + "px";
        line.dataset.depth = String(depth % 6);

        /* Fold a whole branch out of the way, the way an editor folds code. Independent of
           the form's own collapse state, so surveying the structure never disturbs editing. */
        var hasKids = !!(node.item || (node.children || []).length);
        var folded = !!outlineFolded[node.__id];
        var chevron = el("span", "outline__fold", hasKids ? (folded ? "\u25b8" : "\u25be") : "");
        if (hasKids) {
          chevron.title = folded ? "Unfold" : "Fold";
          chevron.addEventListener("click", function (event) {
            event.stopPropagation();      // folding is not navigation
            outlineFolded[node.__id] = !folded;
            paintOutline(outlineHost);
          });
        }
        line.appendChild(chevron);

        line.appendChild(el("span", "outline__badge",
          type === "leaf" ? "val" : type === "object" ? "obj" : type === "list" ? "list" : "arr"));
        line.appendChild(el("span", "outline__name",
          node.key || (depth === 0 ? "(root)" : (/\(each item\)$/.test(nodePath) ? "each item" : "(unnamed)"))));

        if (node.source) line.appendChild(el("span", "outline__meta", "↻ " + node.source));
        /* Matched on the last path segment before, which never equalled "(each item)" and
           cross-flagged every node sharing a name. Exact path, as the cards do. */
        var mine = problems.filter(function (p) { return p.nodePath === nodePath; });
        if (mine.length) {
          line.appendChild(el("span", "outline__flag",
            mine.some(function (p) { return p.level === "error"; }) ? "!" : "?"));
        }
        /* The outline is the map, and "which branch of this mapping is fragile" is a map
           question — the one the cards can only answer once you have already found them. */
        var branchRisk = getRiskBranch(nodePath);
        if (branchRisk && (branchRisk.fail || branchRisk.warn || branchRisk.broken)) {
          var glyph = el("span", "outline__risk", branchRisk.fail || branchRisk.broken ? "▮" : "▯");
          glyph.title = (branchRisk.fail || 0) + " failing, " + (branchRisk.broken || 0) +
            " damaged from elsewhere, " + (branchRisk.warn || 0) + " to check";
          if (branchRisk.fail || branchRisk.broken) glyph.classList.add("is-bad");
          if (branchRisk.stale) glyph.classList.add("is-stale");
          line.appendChild(glyph);
        }

        line.addEventListener("click", function () { revealNode(node); });

        outlineHost.appendChild(line);
        if (folded) return;
        if (node.item) walk(node.item, depth + 1, nodePath + "/(each item)");
        (node.children || []).forEach(function (child, index) {
          walk(child, depth + 1, nodePath + "/" + (child.key || "[" + index + "]"));
        });
      })(config.root, 0, "");
    }

    /**
     * Land on a card. Extracted from the outline's click handler so the test report can arrive
     * the same way — reveal is three separate things that all have to happen (ancestors opened,
     * outline unfolded, the Form tab actually shown) and getting two of the three right looks
     * exactly like the click doing nothing.
     */
    function revealNode(node) {
      var config = getConfig() || {};
      if (!node || !config.root) return false;
      /* Open every ancestor, otherwise jumping to a node inside a folded card lands
         on nothing. */
      (function open(n) {
        if (!n) return false;
        if (n === node) return true;
        var hit = (n.children || []).some(open);
        if (!hit && n.item && open(n.item)) hit = true;
        if (hit && n.__id) collapsed[n.__id] = false;
        return hit;
      })(config.root);
      if (node.__id) collapsed[node.__id] = false;
      (function unfold(n) {
        if (!n) return false;
        if (n === node) return true;
        var hit = (n.children || []).some(unfold);
        if (!hit && n.item && unfold(n.item)) hit = true;
        if (hit && n.__id) outlineFolded[n.__id] = false;
        return hit;
      })(config.root);
      onStructureChange();
      /* Outline and Form are exclusive tabs, so scrolling without switching tabs landed
         on a hidden pane and looked like nothing happened. */
      var formTab = document.querySelector('#config-tabs [data-panel="panel-form"]');
      if (formTab) formTab.click();
      var target = host.querySelector('[data-node-id="' + node.__id + '"]');
      if (target) {
        target.scrollIntoView({ block: "center" });
        target.classList.add("is-flash");
        setTimeout(function () { target.classList.remove("is-flash"); }, 900);
      }
      return true;
    }

    /**
     * The same, addressed by nodePath — which is what every diagnostic carries, the outline
     * having node identity only because it walks the tree itself. The path is rebuilt with the
     * same rule readings() and paintOutline use; a third copy of that rule now exists, and if
     * the three ever disagree the report lands on the wrong card and reads like a probe bug.
     */
    function revealPath(nodePath) {
      var config = getConfig() || {};
      var found = null;
      (function walk(node, path) {
        if (!node || found) return;
        if (path === nodePath) { found = node; return; }
        if (node.item) walk(node.item, path + "/(each item)");
        (node.children || []).forEach(function (child, index) {
          walk(child, path + "/" + (child.key || "[" + index + "]"));
        });
      })(config.root, "");
      return found ? revealNode(found) : false;
    }

    function setOutlineFolded(all, outlineHost) {
      var config = getConfig() || {};
      (function walk(node) {
        if (!node) return;
        if (node.__id && (node.item || (node.children || []).length)) outlineFolded[node.__id] = all;
        if (node.item) walk(node.item);
        (node.children || []).forEach(walk);
      })(config.root);
      if (config.root && config.root.__id) outlineFolded[config.root.__id] = false;
      paintOutline(outlineHost);
    }

    return {
      paint: paint, paintOutline: paintOutline, setOutlineFolded: setOutlineFolded,
      revealPath: revealPath, collapsed: collapsed
    };
  }

  return { create: create };
});
