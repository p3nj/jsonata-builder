/* ══════════════════════════════════════════════════════════════════════════════════════
   tree-ui.js — one renderer for every level of the mapping.

   There used to be two views of the same tree: a card form you edited and an outline you
   navigated, on separate tabs. Clicking the outline bounced you back to the form, and the
   two kept separate fold states. They are now one surface: every node is an indented row
   that edits its name and source in place, expands to the advanced fields, and can be
   dragged to a new position or a new parent. The row IS the form and the indentation IS
   the outline.
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
      hint: "Adds this record's position — 1, 2, 3 — on the end. With a prefix of “Line ” and nothing else, that gives Line 1, Line 2." },
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

  var REPEAT_HINT = "One element of the payload per element of this array. The path is " +
    "relative to the record this sits in — lines, not result.orders.lines. Leave blank " +
    "for a single element built from the current record.";

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
       rather than one because a folded branch has to answer for its children — a fault inside
       it is otherwise invisible. */
    var getRisk = options.getRisk || function () { return null; };
    var getRiskBranch = options.getRiskBranch || function () { return null; };
    var onRiskClick = options.onRiskClick || function () {};
    var collapsed = options.collapsed || {};
    var focusId = null;

    /* Absent from the map means OPEN. The old form defaulted everything below the root to
       collapsed; as the only view of the structure this tree is also the map, and a map that
       starts folded shows nothing. app.js's isNodeOpen reads the same rule. */
    function isOpen(node) {
      return node.__id in collapsed ? !collapsed[node.__id] : true;
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
      var span = el("span", "row__risk");
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
        event.stopPropagation();
        onRiskClick(path);
      });
      return span;
    }

    /** A container row wears its worst descendant's colour, so a folded branch cannot hide a fault. */
    function markBranch(row, path) {
      var risk = getRiskBranch(path);
      if (!risk) return;
      if (risk.fail || risk.broken) row.classList.add("trow--has-error");
      else if (risk.warn) row.classList.add("trow--has-warn");
      if (risk.stale) row.classList.add("is-stale");
    }

    /* ── drag and drop ──────────────────────────────────────────────────────────────────
       Any node that lives in a children array can be picked up and dropped between any two
       siblings anywhere, into an object or list, or onto an array that has no item yet. The
       config is not repainted while a drag is in flight, so the list captured at dragstart
       stays valid until the drop lands. */
    var drag = null;   // { node, parentList } of the node being dragged

    function inSubtree(node, target) {
      if (node === target) return true;
      if (node.item && inSubtree(node.item, target)) return true;
      return (node.children || []).some(function (child) { return inSubtree(child, target); });
    }

    function clearDropMarks() {
      Array.prototype.forEach.call(
        host.querySelectorAll(".is-drop-before, .is-drop-after, .is-drop-into"),
        function (row) { row.classList.remove("is-drop-before", "is-drop-after", "is-drop-into"); });
    }

    /**
     * What dropping HERE would mean, or null when it would mean nothing. A container row is
     * three targets in one — before, into, after — split by thirds of its height; a leaf is
     * only before/after, split in half. A node cannot land inside its own subtree, and an
     * array only accepts a drop while its item slot is empty (the item is a slot, not a
     * sibling list — see the kind picker below for how an occupied one is changed).
     */
    function dropSpecFor(event, row, node, parentList) {
      if (!drag || drag.node === node) return null;
      if (inSubtree(drag.node, node)) return null;
      var type = node.type || "leaf";
      var canInto = type === "object" || type === "list" || (type === "array" && !node.item);
      var canAround = !!parentList;
      if (!canInto && !canAround) return null;
      var rect = row.getBoundingClientRect();
      var y = (event.clientY - rect.top) / (rect.height || 1);
      if (canInto && (!canAround || (y > 1 / 3 && y < 2 / 3))) return { kind: "into" };
      return { kind: y < 0.5 ? "before" : "after" };
    }

    function performDrop(spec, node, parentList) {
      var moved = drag.node;
      var from = drag.parentList;
      var at = from.indexOf(moved);
      if (at < 0) return;
      from.splice(at, 1);
      if (spec.kind === "into") {
        if ((node.type || "leaf") === "array") node.item = moved;
        else (node.children = node.children || []).push(moved);
        collapsed[node.__id] = false;    // a drop into a folded card must not vanish
      } else {
        /* indexOf AFTER the removal, so moving down inside the same list needs no
           off-by-one correction. */
        var to = parentList.indexOf(node);
        if (to < 0) { from.splice(at, 0, moved); return; }
        parentList.splice(spec.kind === "after" ? to + 1 : to, 0, moved);
      }
      onStructureChange();
    }

    function wireDragSource(grip, row, node, parentList) {
      grip.draggable = true;
      grip.addEventListener("dragstart", function (event) {
        drag = { node: node, parentList: parentList };
        event.dataTransfer.effectAllowed = "move";
        /* Firefox refuses to start a drag with no data attached. */
        try { event.dataTransfer.setData("text/plain", node.key || ""); } catch (ignored) {}
        if (event.dataTransfer.setDragImage) event.dataTransfer.setDragImage(row, 12, 12);
        row.classList.add("is-dragging");
      });
      grip.addEventListener("dragend", function () {
        drag = null;
        clearDropMarks();
        row.classList.remove("is-dragging");
      });
    }

    function wireDropTarget(row, node, parentList) {
      row.addEventListener("dragover", function (event) {
        var spec = dropSpecFor(event, row, node, parentList);
        clearDropMarks();
        if (!spec) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        row.classList.add("is-drop-" + spec.kind);
      });
      row.addEventListener("dragleave", function () {
        row.classList.remove("is-drop-before", "is-drop-after", "is-drop-into");
      });
      row.addEventListener("drop", function (event) {
        var spec = dropSpecFor(event, row, node, parentList);
        clearDropMarks();
        if (!spec) return;
        event.preventDefault();
        performDrop(spec, node, parentList);
      });
    }

    /* ── rows ───────────────────────────────────────────────────────────────────────── */
    function removeButton(list, node) {
      var button = el("button", "btn btn--ghost btn--tiny", "✕");
      button.type = "button";
      button.title = "Remove";
      button.addEventListener("click", function () {
        var at = list.indexOf(node);
        if (at >= 0) list.splice(at, 1);
        onStructureChange();
      });
      return button;
    }

    function readoutFor(node, path) {
      var readout = el("span", "row__value");
      var values = getReadings()[path];
      if (values && values.length && values[0] !== undefined) {
        var text = typeof values[0] === "string" ? values[0] : JSON.stringify(values[0]);
        readout.textContent = text.length > 32 ? text.slice(0, 32) + "…" : text;
        readout.title = String(values[0]);
      } else if (node.constant) {
        readout.textContent = node.constant;
      } else {
        readout.textContent = "nothing";
        readout.className = "row__value row__value--empty";
      }
      return readout;
    }

    /** The advanced fields, folded under the row. Leaves get the value pipeline; arrays get
        the filter and the always-a-list tick; lists just the tick. Objects have nothing an
        expansion could hold, so they have no "more" at all. */
    function moreSection(node, type) {
      var extra = el("div", "trow__more");

      if (type === "array" || type === "list") {
        var always = el("label", "check");
        var box = el("input");
        box.type = "checkbox";
        box.dataset.role = "alwaysArray";
        box.checked = node.alwaysArray !== false;
        box.addEventListener("change", function () { node.alwaysArray = box.checked; onChange(); });
        always.appendChild(box);
        always.appendChild(document.createTextNode(" Always send a list, even with one item"));
        var wrap = el("div", "field");
        wrap.appendChild(el("label"));
        wrap.appendChild(always);
        extra.appendChild(wrap);
      }

      if (type === "array") {
        FILTERS.forEach(function (spec) {
          var control = spec.enum
            ? select(node[spec.key] || "", spec.enum, function (v) { node[spec.key] = v || undefined; })
            : input(node[spec.key], "", function (v) { node[spec.key] = v || undefined; });
          control.dataset.role = "filter:" + spec.key;
          extra.appendChild(field(spec.label, control, spec.hint));
        });
      }

      if (type === "leaf") {
        ADVANCED.forEach(function (spec) {
          var control, tick;
          if (spec.type === "boolean") {
            control = el("label", "check");
            tick = el("input");
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
             restoreFocus has after the repaint. Without one, focus was handed back to the first
             input in the row — the name box — a fifth of a second into typing a prefix. */
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
      }

      return extra;
    }

    function adderRow(node) {
      var adders = el("div", "trow trow--adders");
      TYPES.forEach(function (spec) {
        var add = el("button", "btn btn--tiny", "+ " + spec.label.split(" ")[0]);
        add.type = "button";
        add.title = spec.label;
        add.addEventListener("click", function () {
          node.children = node.children || [];
          var fresh = { key: "", type: spec.value };
          if (spec.value !== "leaf") fresh.children = [];
          if (spec.value === "array") fresh.alwaysArray = true;
          node.children.push(fresh);
          collapsed[node.__id] = false;
          focusOn = fresh;
          onStructureChange();
        });
        adders.appendChild(add);
      });
      return adders;
    }

    /** The children of a container, indented one level under its row. */
    function kidsFor(node, path, depth) {
      var kids = el("div", "tnode__kids");
      var type = node.type || "object";

      if (type === "array") {
        /* "each item is …" is the question arrays actually pose. It used to be answered by
           a convention nobody could see. */
        var pick = el("div", "trow trow--item");
        pick.appendChild(el("span", "trow__itemlabel", "Each item is"));
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
        pick.appendChild(kindPicker);
        kids.appendChild(pick);
        /* Rendering used to CREATE the item, so merely expanding a card edited the mapping,
           changed the payload and wrote a history snapshot. The picker just reports "not
           chosen yet" instead. */
        if (node.item) {
          ensureIds(node.item);
          kids.appendChild(renderNode(node.item, {
            path: path + "/(each item)", parentList: null, depth: depth + 1, fixedLabel: "each item"
          }));
        } else if ((node.children || []).length) {
          /* A pre-item mapping: show its body where the item now lives. */
          kids.appendChild(el("div", "hint", "This array was written before items existed; choose a kind to convert it."));
        } else {
          kids.appendChild(el("div", "hint", "Nothing will be produced until you choose what each item is — or drop a node onto this row."));
        }
      } else {
        (node.children || []).forEach(function (child, index) {
          kids.appendChild(renderNode(child, {
            path: path + "/" + (child.key || "[" + index + "]"),
            parentList: node.children, depth: depth + 1
          }));
        });
        kids.appendChild(adderRow(node));
      }
      return kids;
    }

    /**
     * Every node draws as one row: grip, fold, badge, name, then what its type needs — a
     * leaf's source and readout, an array's repeat-over path, a container's count. The
     * context says where it sits: parentList is the children array holding it (absent for
     * the root and an array's item, which is why neither can be dragged or removed), and
     * fixedLabel replaces the name box where a name would be meaningless.
     */
    function renderNode(node, ctx) {
      var type = node.type || "leaf";
      var isContainer = type !== "leaf";
      var depth = ctx.depth || 0;

      var tnode = el("div", "tnode");
      tnode.dataset.nodeId = node.__id;
      tnode.dataset.nodePath = ctx.path;
      tnode.dataset.depth = String(depth % 6);   // six hues, then repeat

      var row = el("div", "trow");

      if (ctx.parentList) {
        var grip = el("span", "trow__grip", "⠿");
        grip.title = "Drag to move — between rows to reorder, onto a container to nest";
        wireDragSource(grip, row, node, ctx.parentList);
        row.appendChild(grip);
      } else {
        row.appendChild(el("span", "trow__grip trow__grip--off"));
      }

      if (isContainer) {
        var open = isOpen(node);
        var fold = el("button", "trow__fold", open ? "▾" : "▸");
        fold.type = "button";
        fold.title = open ? "Fold" : "Unfold";
        fold.addEventListener("click", function () { collapsed[node.__id] = open; onStructureChange(); });
        row.appendChild(fold);
      } else {
        row.appendChild(el("span", "trow__fold trow__fold--off"));
      }

      row.appendChild(el("span", "trow__badge",
        type === "leaf" ? "val" : type === "object" ? "obj" : type === "list" ? "list" : "arr"));

      if (ctx.fixedLabel) {
        /* An array element has no key, so a name box here accepted input and did nothing. */
        row.appendChild(el("span", "trow__fixed", ctx.fixedLabel));
      } else {
        var name = input(node.key, depth === 0 ? "(root)" : "name", function (value) { node.key = value; }, "control trow__key");
        name.dataset.role = "key";
        row.appendChild(name);
      }

      if (type === "leaf") {
        row.appendChild(el("span", "trow__link", "←"));
        var source = input(node.source, "dotted.path", function (value) { node.source = value; }, "control trow__source");
        source.dataset.role = "source";
        source.setAttribute("list", "paths-all");
        row.appendChild(source);
        row.appendChild(readoutFor(node, ctx.path));
      } else if (type === "array") {
        row.appendChild(el("span", "trow__link", "↻"));
        var src = input(node.source, "repeat over dotted.path", function (value) { node.source = value || undefined; }, "control trow__source");
        src.dataset.role = "source";
        src.setAttribute("list", "paths-array");
        src.title = REPEAT_HINT;
        row.appendChild(src);
        row.appendChild(el("span", "trow__meta", node.item ? "each: " + label(node.item.type || "leaf") : "no item set"));
      } else {
        var count = (node.children || []).length;
        row.appendChild(el("span", "trow__meta", count + " item" + (count === 1 ? "" : "s")));
      }

      row.appendChild(riskBadge(ctx.path, isContainer));
      if (isContainer) markBranch(row, ctx.path);

      var moreKey = node.__id + "#adv";
      if (type !== "object") {
        var moreOpen = !!collapsed[moreKey];
        var more = el("button", "btn btn--ghost btn--tiny", moreOpen ? "▾ more" : "▸ more");
        more.type = "button";
        more.addEventListener("click", function () { collapsed[moreKey] = !moreOpen; onStructureChange(); });
        row.appendChild(more);
      }
      if (ctx.parentList) row.appendChild(removeButton(ctx.parentList, node));

      wireDropTarget(row, node, ctx.parentList);
      tnode.appendChild(row);

      if (type !== "object" && collapsed[moreKey]) tnode.appendChild(moreSection(node, type));
      attachProblems(tnode, ctx.path);
      if (isContainer && isOpen(node)) tnode.appendChild(kidsFor(node, ctx.path, depth));

      if (focusId && focusId === node.__id) {
        focusId = null;
        setTimeout(function () {
          var first = row.querySelector("input");
          if (first) { first.focus(); first.select(); row.scrollIntoView({ block: "center" }); }
        }, 0);
      }
      return tnode;
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
         control handed the caret to the name box a fifth of a second into typing, and the rest
         of the word renamed the field. Losing focus is a disappointment; moving it somewhere
         that silently eats keystrokes is a bug. */
      var target = mark.role ? holder.querySelector('[data-role="' + mark.role + '"]') : null;
      if (!target) return;
      target.focus();
      if (target.setSelectionRange && mark.start !== null && mark.start !== undefined) {
        try { target.setSelectionRange(mark.start, mark.end); } catch (ignored) {}
      }
    }

    /* Fold and focus are keyed by a stable id, not by the node's path. Paths contain the
       node's key, so renaming a row used to change its path and slam it shut mid-word. */
    var nextId = 1;
    var focusOn = null;   // a node object awaiting an id, set when it is created
    function ensureIds(node) {
      if (!node) return;
      if (!node.__id) node.__id = "n" + (nextId++);
      /* Converted configs carry a display-only "label"; promote it so the row has a name
         instead of four identical blank ARR rows. */
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
      host.appendChild(renderNode(config.root, { path: "", parentList: null, depth: 0 }));
      restoreFocus(mark);
    }

    /**
     * Land on a row. Extracted from the old outline's click handler and kept for the test
     * report and the properties panel, which still arrive by nodePath — reveal is two
     * separate things that both have to happen (ancestors unfolded, the mapping tab actually
     * shown) and getting one of the two right looks exactly like the click doing nothing.
     */
    function revealNode(node) {
      var config = getConfig() || {};
      if (!node || !config.root) return false;
      /* Open every ancestor, otherwise jumping to a node inside a folded branch lands
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
      onStructureChange();
      /* Reveal can be asked for from the Tests or Flow properties tab, where the tree pane
         is hidden and scrolling would land on nothing visible. */
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
     * The same, addressed by nodePath — which is what every diagnostic carries. The path is
     * rebuilt with the same rule readings() and renderNode use; if the copies of that rule
     * ever disagree the report lands on the wrong row and reads like a probe bug.
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

    return { paint: paint, revealPath: revealPath, collapsed: collapsed };
  }

  return { create: create };
});
