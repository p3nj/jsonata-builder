/* ══════════════════════════════════════════════════════════════════════════════════════
   Version history for the mapping form.

   The form is the only thing worth losing: it is hand-tuned identifiers and source paths,
   and one careless edit throws away an afternoon. This keeps a rolling history of the
   config var value (plus the JSONata it generated at that moment) in localStorage, so a
   reload — or a wrong turn — is recoverable.

     var history = MappingHistory.init({
       getConfig:     function () { return state.data; },
       setConfig:     function (config) { state.data = config; },
       getExpression: function () { return state.expr; },
       onRestore:     function () { render(); run(); }
     });
     history.renderInto(document.getElementById("history-host"));
     history.notifyChange();   // from wherever the config is edited

   Snapshots are of two kinds:
     manual  the user pressed Save (optionally with a label) — never evicted automatically
     auto    the config changed and then went quiet — the oldest are shed past the cap

   Storage is best-effort. Private browsing hands out a localStorage that throws on write,
   and a big mapping plus a long history can hit the quota; both degrade to an in-memory
   history and say so in the UI rather than taking the page down.

   Written as portable ES5 with no imports, so build.mjs can inline it verbatim and node
   can require() it in a test.
   ══════════════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MappingHistory = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var STORE_VERSION = 1;
  var DEFAULT_KEY = "jsonata-mapping.history.v2";
  var DEFAULT_AUTOSAVE_LIMIT = 25;
  var DEFAULT_AUTOSAVE_DELAY = 4000;
  var DIFF_LINE_CAP = 80;
  var DIFF_CELL_CAP = 600000; /* beyond this the LCS table is not worth the wait */
  var STYLE_ID = "mapping-history-style";

  /* ── Small helpers ─────────────────────────────────────────────────────────────── */
  var isArray = Array.isArray || function (v) {
    return Object.prototype.toString.call(v) === "[object Array]";
  };

  function clone(value) {
    if (value === undefined || value === null) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch (error) { return null; }
  }

  /** Key order must not decide whether two configs count as equal. */
  function canon(value) {
    if (value === undefined) return "null";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (isArray(value)) {
      var items = [];
      for (var i = 0; i < value.length; i++) items.push(canon(value[i]));
      return "[" + items.join(",") + "]";
    }
    var keys = [];
    for (var key in value) if (Object.prototype.hasOwnProperty.call(value, key)) keys.push(key);
    keys.sort();
    var parts = [];
    for (var k = 0; k < keys.length; k++) {
      if (value[keys[k]] === undefined) continue;
      parts.push(JSON.stringify(keys[k]) + ":" + canon(value[keys[k]]));
    }
    return "{" + parts.join(",") + "}";
  }

  function escapeHtml(text) {
    return String(text === undefined || text === null ? "" : text)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function plural(count, word) {
    return count + " " + word + (count === 1 ? "" : "s");
  }

  function numberOr(value, fallback) {
    return typeof value === "number" && isFinite(value) && value >= 0 ? value : fallback;
  }

  var seq = 0;
  function makeId(at) {
    seq += 1;
    return "v" + Number(at).toString(36) + "-" + seq.toString(36) +
      Math.floor(Math.random() * 1296).toString(36);
  }

  /* ── Reading the config ────────────────────────────────────────────────────────── */
  /* Walks the node tree. The old version read cfg.groups / cfg.fields, keys the generic
     model does not have, so every snapshot read "0 groups · 0 sections · 0 fields". */
  function countsOf(config) {
    var cfg = config && typeof config === "object" ? config : {};
    var totals = { containers: 0, values: 0, lists: 0, depth: 0 };
    (function walk(node, depth) {
      if (!node || typeof node !== "object") return;
      var type = node.type || "leaf";
      if (type === "leaf") totals.values += 1;
      else if (type === "list" || type === "array") { totals.lists += 1; totals.containers += 1; }
      else totals.containers += 1;
      if (depth > totals.depth) totals.depth = depth;
      if (node.item) walk(node.item, depth + 1);
      var kids = isArray(node.children) ? node.children : [];
      for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
    })(cfg.root, 0);
    return totals;
  }

  /** "12 containers · 91 values · 6 deep" — the line under an entry's title. */
  function summarise(config) {
    var counts = countsOf(config);
    return [
      plural(counts.containers, "container"),
      plural(counts.values, "value"),
      counts.depth + " deep"
    ].join(" · ");
  }

  /**
   * Everything a diff needs, keyed by the identifiers a human recognises.
   * Sections have no records of their own — they exist wherever a field claims one.
   */
  function indexConfig(config) {
    var cfg = config && typeof config === "object" ? config : {};
    var index = { groups: {}, sections: {}, fields: {}, targets: {} };
    (function walk(node, path) {
      if (!node || typeof node !== "object") return;
      var type = node.type || "leaf";
      var here = path + "/" + String(node.key || "(unnamed)");
      var bucket = type === "leaf" ? index.fields
        : (type === "object" ? index.sections : index.groups);
      /* Compare the node without its children, so a change deep in a branch is reported on
         the node that actually changed rather than on every ancestor. */
      var shallow = {};
      for (var key in node) {
        if (Object.prototype.hasOwnProperty.call(node, key) && key !== "children" && key !== "item" && key !== "__id") {
          shallow[key] = node[key];
        }
      }
      bucket[here] = canon(shallow);
      if (node.item) walk(node.item, here);
      var kids = isArray(node.children) ? node.children : [];
      for (var i = 0; i < kids.length; i++) walk(kids[i], here);
    })(cfg.root, "");
    return index;
  }

  /** added = in `after` only; removed = in `before` only; changed = same key, different body. */
  function compareBuckets(before, after) {
    var added = [];
    var removed = [];
    var changed = [];
    var key;
    for (key in after) {
      if (!Object.prototype.hasOwnProperty.call(after, key)) continue;
      if (!Object.prototype.hasOwnProperty.call(before, key)) added.push(key);
      else if (before[key] !== after[key]) changed.push(key);
    }
    for (key in before) {
      if (!Object.prototype.hasOwnProperty.call(before, key)) continue;
      if (!Object.prototype.hasOwnProperty.call(after, key)) removed.push(key);
    }
    added.sort(); removed.sort(); changed.sort();
    return { added: added, removed: removed, changed: changed };
  }

  /* ── Line diff of the two generated expressions ────────────────────────────────── */
  function splitLines(text) {
    var value = String(text === undefined || text === null ? "" : text);
    if (value === "") return [];
    return value.replace(/\r\n?/g, "\n").split("\n");
  }

  /**
   * A real LCS diff, so "3 lines added" means three lines and not "three lines differ at
   * the same index". Falls back to a multiset count on pathologically large expressions,
   * and says so, rather than quietly lying.
   */
  function diffLines(beforeText, afterText, cap) {
    var a = splitLines(beforeText);
    var b = splitLines(afterText);
    var limit = numberOr(cap, DIFF_LINE_CAP);
    var result = { added: 0, removed: 0, lines: [], truncated: false, approximate: false };

    if (a.length === b.length) {
      var same = true;
      for (var s = 0; s < a.length; s++) if (a[s] !== b[s]) { same = false; break; }
      if (same) return result;
    }

    if (a.length * b.length > DIFF_CELL_CAP) {
      var bag = {};
      var i2;
      for (i2 = 0; i2 < a.length; i2++) bag[a[i2]] = (bag[a[i2]] || 0) - 1;
      for (i2 = 0; i2 < b.length; i2++) bag[b[i2]] = (bag[b[i2]] || 0) + 1;
      for (var line in bag) {
        if (!Object.prototype.hasOwnProperty.call(bag, line)) continue;
        if (bag[line] > 0) result.added += bag[line];
        else if (bag[line] < 0) result.removed -= bag[line];
      }
      result.approximate = true;
      return result;
    }

    var m = a.length;
    var n = b.length;
    var dp = new Array(m + 1);
    var i, j;
    for (i = m; i >= 0; i--) {
      dp[i] = new Array(n + 1);
      for (j = n; j >= 0; j--) {
        if (i === m || j === n) dp[i][j] = 0;
        else if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
      }
    }

    var ops = [];
    i = 0; j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) { ops.push({ type: " ", text: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: "-", text: a[i] }); i++; result.removed++; }
      else { ops.push({ type: "+", text: b[j] }); j++; result.added++; }
    }
    while (i < m) { ops.push({ type: "-", text: a[i] }); i++; result.removed++; }
    while (j < n) { ops.push({ type: "+", text: b[j] }); j++; result.added++; }

    /* Keep the changed lines and one line of context either side — enough to place a
       change without pasting the whole expression into the panel. */
    var keep = [];
    for (var o = 0; o < ops.length; o++) {
      if (ops[o].type === " ") continue;
      if (o > 0) keep[o - 1] = true;
      keep[o] = true;
      if (o + 1 < ops.length) keep[o + 1] = true;
    }
    var out = [];
    var skipped = false;
    for (var p = 0; p < ops.length; p++) {
      if (!keep[p]) { skipped = true; continue; }
      if (skipped && out.length) out.push({ type: "@", text: "…" });
      skipped = false;
      if (out.length >= limit) { result.truncated = true; break; }
      out.push(ops[p]);
    }
    result.lines = out;
    return result;
  }

  /* ── Time ──────────────────────────────────────────────────────────────────────── */
  function pad(value) { return value < 10 ? "0" + value : String(value); }

  function absoluteTime(at) {
    var date = new Date(at);
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
      " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
  }

  function relativeTime(at, nowMs) {
    var delta = Math.max(0, Math.floor((nowMs - at) / 1000));
    if (delta < 10) return "just now";
    if (delta < 60) return delta + "s ago";
    if (delta < 3600) return Math.floor(delta / 60) + "m ago";
    if (delta < 86400) return Math.floor(delta / 3600) + "h ago";
    if (delta < 604800) return Math.floor(delta / 86400) + "d ago";
    return absoluteTime(at).slice(0, 10);
  }

  /* ── Styles ────────────────────────────────────────────────────────────────────── */
  /* Injected once, from here, so the panel travels with this file and still speaks the
     page's token vocabulary (--line, --ok, --bad, …). */
  var CSS = [
    ".mh { display: flex; flex-direction: column; min-height: 0; height: 100%; }",
    ".mh__bar { display: flex; align-items: center; gap: 6px; padding: 8px 10px;",
    "  border-bottom: 1px solid var(--line); background: var(--surface-raised); flex-wrap: wrap; }",
    ".mh__bar .control { flex: 1 1 150px; min-width: 120px; width: auto; }",
    ".mh__list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 10px;",
    "  display: flex; flex-direction: column; gap: 8px; }",
    ".mh__entry { --tier: var(--line-strong); }",
    ".mh__entry + .mh__entry { margin-top: 0; }",
    ".mh__entry.is-current { --tier: var(--ok); }",
    ".mh__entry.is-manual { --tier: var(--accent); }",
    ".mh__entry.is-current.is-manual { --tier: var(--ok); }",
    ".mh__when { font-family: var(--mono); font-size: 11px; color: var(--ink-faint); white-space: nowrap; }",
    ".mh__acts { display: flex; gap: 4px; flex-wrap: wrap; }",
    ".mh__diff { border-top: 1px solid var(--line); padding: 8px 10px;",
    "  display: flex; flex-direction: column; gap: 6px; }",
    ".mh__drow { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; font-size: 12px; color: var(--ink-soft); }",
    ".mh__dlabel { font-family: var(--mono); font-size: 10px; font-weight: 600; letter-spacing: .06em;",
    "  text-transform: uppercase; color: var(--ink-faint); min-width: 74px; }",
    ".mh__ids { font-family: var(--mono); font-size: 11px; word-break: break-word; }",
    ".mh__add { color: var(--ok); }",
    ".mh__del { color: var(--bad); }",
    ".mh__chg { color: var(--warn); }",
    ".mh__lines { max-height: 230px; overflow: auto; background: var(--surface-sunken);",
    "  border: 1px solid var(--line); border-radius: 5px; padding: 6px 8px; }",
    ".mh__line { font-family: var(--mono); font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; }",
    ".mh__line--add { color: var(--ok); background: var(--ok-soft); }",
    ".mh__line--del { color: var(--bad); background: var(--bad-soft); }",
    ".mh__line--ctx { color: var(--ink-faint); }",
    ".mh__line--gap { color: var(--ink-faint); text-align: center; }",
    ".mh__empty { padding: 18px 12px; text-align: center; color: var(--ink-faint); font-size: 12px; }"
  ].join("\n");

  function ensureStyles(doc) {
    if (!doc || !doc.head || doc.getElementById(STYLE_ID)) return;
    var style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    doc.head.appendChild(style);
  }

  /* ── Storage ───────────────────────────────────────────────────────────────────── */
  /**
   * localStorage is a privilege, not a guarantee: accessing it throws outright under some
   * privacy settings, and writing throws once the origin's quota is gone. Both land here,
   * and both leave the history working in memory for the session.
   */
  function makeStore(key, provided) {
    var store = {
      key: key,
      mode: "memory",
      notice: "",
      backing: null
    };

    var backing = provided;
    if (backing === undefined) {
      try { backing = typeof window !== "undefined" ? window.localStorage : null; }
      catch (error) { backing = null; }
    }
    if (!backing) {
      store.notice = "No localStorage in this browser context — history lives in memory for this session.";
      return store;
    }

    try {
      backing.setItem(key + "~probe", "1");
      backing.removeItem(key + "~probe");
      store.backing = backing;
      store.mode = "local";
    } catch (error) {
      store.notice = "localStorage is blocked here (" + (error && error.name ? error.name : "error") +
        ") — history lives in memory for this session.";
    }
    return store;
  }

  function readEntries(store) {
    if (store.mode !== "local") return [];
    var raw;
    try { raw = store.backing.getItem(store.key); }
    catch (error) { return []; }
    if (!raw) return [];
    var parsed;
    try { parsed = JSON.parse(raw); } catch (error) {
      store.notice = "Stored history was unreadable and has been ignored.";
      return [];
    }
    var list = parsed && isArray(parsed.entries) ? parsed.entries : (isArray(parsed) ? parsed : []);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (!entry || typeof entry !== "object" || !entry.id) continue;
      out.push({
        id: String(entry.id),
        at: typeof entry.at === "number" ? entry.at : Date.parse(entry.at) || 0,
        label: typeof entry.label === "string" ? entry.label : "",
        kind: entry.kind === "manual" ? "manual" : "auto",
        summary: typeof entry.summary === "string" ? entry.summary : summarise(entry.config),
        counts: entry.counts && typeof entry.counts === "object" ? entry.counts : countsOf(entry.config),
        config: entry.config,
        expr: typeof entry.expr === "string" ? entry.expr : ""
      });
    }
    out.sort(function (x, y) { return y.at - x.at; });
    return out;
  }

  var isProtected = function (entry) {
    return entry.kind === "manual" || (entry.label || "") !== "";
  };

  /**
   * Writes, and if the quota says no, sheds the oldest autosaves until it fits. Labelled
   * and manual snapshots are never shed — if only those are left and it still will not
   * fit, the whole history drops to memory rather than losing one of them.
   */
  function writeEntries(store, entries) {
    if (store.mode !== "local") return { ok: false, entries: entries, dropped: 0 };
    var working = entries.slice();
    var dropped = 0;
    for (;;) {
      try {
        store.backing.setItem(store.key, JSON.stringify({ version: STORE_VERSION, entries: working }));
        if (dropped) {
          store.notice = "Storage was full — dropped " + plural(dropped, "older autosave") + " to fit.";
        }
        return { ok: true, entries: working, dropped: dropped };
      } catch (error) {
        var victim = -1;
        for (var i = working.length - 1; i >= 0; i--) {
          if (!isProtected(working[i])) { victim = i; break; }
        }
        if (victim < 0) {
          store.mode = "memory";
          store.notice = "Storage is full and every snapshot left is labelled — history " +
            "continues in memory for this session.";
          return { ok: false, entries: entries, dropped: dropped };
        }
        working.splice(victim, 1);
        dropped += 1;
      }
    }
  }

  /* ── Controller ────────────────────────────────────────────────────────────────── */
  function init(options) {
    var opts = options || {};
    if (typeof opts.getConfig !== "function") {
      throw new Error("MappingHistory.init: getConfig is required");
    }

    var getConfig = opts.getConfig;
    var setConfig = typeof opts.setConfig === "function" ? opts.setConfig : function () {};
    var getExpression = typeof opts.getExpression === "function" ? opts.getExpression : function () { return ""; };
    var onRestore = typeof opts.onRestore === "function" ? opts.onRestore : function () {};
    var onChange = typeof opts.onChange === "function" ? opts.onChange : function () {};
    var autosaveLimit = numberOr(opts.autosaveLimit, numberOr(opts.limit, DEFAULT_AUTOSAVE_LIMIT));
    var autosaveDelay = numberOr(opts.autosaveDelay, DEFAULT_AUTOSAVE_DELAY);
    var doc = opts.document || (typeof document !== "undefined" ? document : null);
    var confirmFn = typeof opts.confirm === "function" ? opts.confirm : function (message) {
      return typeof window !== "undefined" && window.confirm ? window.confirm(message) : true;
    };
    var promptFn = typeof opts.prompt === "function" ? opts.prompt : function (message, value) {
      return typeof window !== "undefined" && window.prompt ? window.prompt(message, value) : null;
    };
    var now = typeof opts.now === "function" ? opts.now : function () { return Date.now(); };

    var store = makeStore(opts.storageKey || DEFAULT_KEY, opts.storage);
    var entries = readEntries(store); /* newest first, always */
    var currentId = entries.length ? entries[0].id : null;
    var mount = null;
    var openDiffs = {};
    var timer = null;
    var draftLabel = "";

    /* ── internals ── */
    function currentConfig() {
      var config = getConfig();
      return config && typeof config === "object" ? config : null;
    }

    function findIndex(id) {
      for (var i = 0; i < entries.length; i++) if (entries[i].id === id) return i;
      return -1;
    }

    function find(id) {
      var index = findIndex(id);
      return index < 0 ? null : entries[index];
    }

    function persist() {
      var result = writeEntries(store, entries);
      if (result.ok && result.dropped) entries = result.entries;
      return result.ok;
    }

    function trim() {
      var kept = 0;
      for (var i = 0; i < entries.length; i++) {
        if (isProtected(entries[i])) continue;
        kept += 1;
        if (kept > autosaveLimit) { entries.splice(i, 1); i -= 1; }
      }
    }

    function makeEntry(config, label, kind) {
      var at = now();
      return {
        id: makeId(at),
        at: at,
        label: String(label || ""),
        kind: kind,
        summary: summarise(config),
        counts: countsOf(config),
        config: clone(config),
        expr: String(getExpression() || "")
      };
    }

    function commit(entry) {
      entries.unshift(entry);
      entries.sort(function (x, y) { return y.at - x.at; });
      trim();
      currentId = entry.id;
      persist();
      onChange(publicEntry(entry));
      paint();
      return entry;
    }

    function publicEntry(entry) {
      if (!entry) return null;
      return {
        id: entry.id,
        at: entry.at,
        label: entry.label,
        kind: entry.kind,
        summary: entry.summary,
        counts: clone(entry.counts),
        config: clone(entry.config),
        expr: entry.expr,
        current: entry.id === currentId
      };
    }

    /** Dirty means "differs from the newest snapshot" — the thing a restore would discard. */
    function isDirty() {
      var config = currentConfig();
      if (!config || !entries.length) return !!config && entries.length === 0;
      return canon(config) !== canon(entries[0].config);
    }

    function matchesLoaded(config) {
      var loaded = find(currentId);
      return !!loaded && canon(config) === canon(loaded.config);
    }

    /* ── public: snapshots ── */
    function save(label) {
      var config = currentConfig();
      if (!config) return null;
      return publicEntry(commit(makeEntry(config, label, "manual")));
    }

    function autosave() {
      timer = null;
      var config = currentConfig();
      if (!config) return null;
      /* Only if it actually moved — against the newest snapshot and against whichever
         version is loaded, so restoring an old one does not re-record it. */
      if (entries.length && canon(config) === canon(entries[0].config)) return null;
      if (matchesLoaded(config)) return null;
      return publicEntry(commit(makeEntry(config, "", "auto")));
    }

    function notifyChange() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(autosave, autosaveDelay);
    }

    function flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      return autosave();
    }

    function list() {
      var out = [];
      for (var i = 0; i < entries.length; i++) out.push(publicEntry(entries[i]));
      return out;
    }

    function get(id) { return publicEntry(find(id)); }

    function restore(id, restoreOptions) {
      var settings = restoreOptions || {};
      var entry = find(id);
      if (!entry) return false;
      if (!settings.force && isDirty()) {
        var message = "The form has changes that are not in any snapshot.\n\n" +
          "Restore “" + (entry.label || relativeTime(entry.at, now())) + "” anyway?\n" +
          "Your current version is snapshotted first, so nothing is lost.";
        if (!confirmFn(message)) return false;
        if (timer) { clearTimeout(timer); timer = null; }
        var config = currentConfig();
        if (config && (!entries.length || canon(config) !== canon(entries[0].config))) {
          commit(makeEntry(config, "", "auto"));
        }
      }
      if (timer) { clearTimeout(timer); timer = null; }
      setConfig(clone(entry.config), publicEntry(entry));
      currentId = entry.id;
      onRestore(publicEntry(entry));
      paint();
      return true;
    }

    function rename(id, label) {
      var entry = find(id);
      if (!entry) return false;
      entry.label = String(label === undefined || label === null ? "" : label);
      persist();
      paint();
      return true;
    }

    function remove(id) {
      var index = findIndex(id);
      if (index < 0) return false;
      entries.splice(index, 1);
      if (currentId === id) currentId = null;
      delete openDiffs[id];
      persist();
      paint();
      return true;
    }

    function clear() {
      entries = [];
      currentId = null;
      openDiffs = {};
      if (store.mode === "local") {
        try { store.backing.removeItem(store.key); } catch (error) { /* nothing to undo */ }
      }
      paint();
    }

    /* ── public: diff ── */
    /** What changed between `id` and whatever is in the form right now. */
    function diff(id) {
      var entry = find(id);
      if (!entry) return null;
      var config = currentConfig() || {};
      var before = indexConfig(entry.config);
      var after = indexConfig(config);
      var expr = diffLines(entry.expr, String(getExpression() || ""), DIFF_LINE_CAP);
      var result = {
        id: entry.id,
        groups: compareBuckets(before.groups, after.groups),
        sections: compareBuckets(before.sections, after.sections),
        fields: compareBuckets(before.fields, after.fields),
        targets: compareBuckets(before.targets, after.targets),
        expr: expr,
        identical: canon(entry.config) === canon(config)
      };
      return result;
    }

    function status() {
      return {
        mode: store.mode,
        storageKey: store.key,
        notice: store.notice,
        count: entries.length,
        autosaves: (function () {
          var n = 0;
          for (var i = 0; i < entries.length; i++) if (!isProtected(entries[i])) n += 1;
          return n;
        })(),
        autosaveLimit: autosaveLimit,
        currentId: currentId,
        dirty: isDirty(),
        pending: !!timer
      };
    }

    /* ── UI ────────────────────────────────────────────────────────────────────── */
    function renderInto(element) {
      var host = typeof element === "string" && doc ? doc.getElementById(element) : element;
      if (!host) return controller;
      mount = host;
      ensureStyles(doc);
      if (!mount.__mhWired) {
        mount.__mhWired = true;
        mount.addEventListener("click", onClick);
        mount.addEventListener("input", onInput);
        mount.addEventListener("keydown", onKeydown);
      }
      paint();
      return controller;
    }

    function onInput(event) {
      var target = event.target;
      if (target && target.getAttribute && target.getAttribute("data-mh") === "label") {
        draftLabel = target.value;
      }
    }

    function onKeydown(event) {
      var target = event.target;
      if (event.key === "Enter" && target && target.getAttribute &&
          target.getAttribute("data-mh") === "label") {
        event.preventDefault();
        save(draftLabel);
        draftLabel = "";
      }
    }

    function onClick(event) {
      var node = event.target;
      while (node && node !== mount && !(node.getAttribute && node.getAttribute("data-mh-act"))) {
        node = node.parentNode;
      }
      if (!node || node === mount) return;
      var act = node.getAttribute("data-mh-act");
      var id = node.getAttribute("data-mh-id");
      if (act === "save") { save(draftLabel); draftLabel = ""; return; }
      if (act === "clear") {
        if (!entries.length) return;
        if (confirmFn("Delete all " + plural(entries.length, "snapshot") + "? This cannot be undone.")) clear();
        return;
      }
      if (act === "restore") { restore(id); return; }
      if (act === "delete") { remove(id); return; }
      if (act === "rename") {
        var entry = find(id);
        if (!entry) return;
        var next = promptFn("Label for this version", entry.label || "");
        if (next === null || next === undefined) return;
        rename(id, next);
        return;
      }
      if (act === "diff") {
        if (openDiffs[id]) delete openDiffs[id]; else openDiffs[id] = true;
        paint();
      }
    }

    function bucketHtml(label, bucket, unit) {
      if (!bucket.added.length && !bucket.removed.length && !bucket.changed.length) return "";
      var bits = [];
      if (bucket.added.length) bits.push("<span class='mh__add'>+" + bucket.added.length + "</span>");
      if (bucket.removed.length) bits.push("<span class='mh__del'>−" + bucket.removed.length + "</span>");
      if (bucket.changed.length) bits.push("<span class='mh__chg'>Δ" + bucket.changed.length + "</span>");
      var ids = [];
      var i;
      for (i = 0; i < bucket.added.length; i++) ids.push("<span class='mh__add'>+" + escapeHtml(bucket.added[i]) + "</span>");
      for (i = 0; i < bucket.removed.length; i++) ids.push("<span class='mh__del'>−" + escapeHtml(bucket.removed[i]) + "</span>");
      for (i = 0; i < bucket.changed.length; i++) ids.push("<span class='mh__chg'>Δ" + escapeHtml(bucket.changed[i]) + "</span>");
      return "<div class='mh__drow'>" +
        "<span class='mh__dlabel'>" + escapeHtml(label) + "</span>" +
        "<span>" + bits.join(" ") + "</span>" +
        "<span class='mh__ids'>" + ids.join(" · ") + "</span>" +
        "</div>";
    }

    function diffHtml(id) {
      var report = diff(id);
      if (!report) return "";
      var parts = [];
      parts.push("<div class='mh__drow'><span class='mh__dlabel'>vs form</span><span>" +
        (report.identical
          ? "The form is identical to this version."
          : "+ added / − removed / Δ changed, from this version to the form as it stands.") +
        "</span></div>");
      parts.push(bucketHtml("groups", report.groups, "group"));
      parts.push(bucketHtml("sections", report.sections, "section"));
      parts.push(bucketHtml("fields", report.fields, "field"));
      parts.push(bucketHtml("obz fields", report.targets, "target"));

      var expr = report.expr;
      if (expr.added || expr.removed) {
        parts.push("<div class='mh__drow'><span class='mh__dlabel'>jsonata</span><span>" +
          "<span class='mh__add'>+" + expr.added + "</span> " +
          "<span class='mh__del'>−" + expr.removed + "</span> lines" +
          (expr.approximate ? " (counted by line, expression too large to align)" : "") +
          (expr.truncated ? " · first " + expr.lines.length + " shown" : "") +
          "</span></div>");
        if (expr.lines.length) {
          var rows = [];
          for (var i = 0; i < expr.lines.length; i++) {
            var line = expr.lines[i];
            var cls = line.type === "+" ? "mh__line--add" :
              line.type === "-" ? "mh__line--del" :
              line.type === "@" ? "mh__line--gap" : "mh__line--ctx";
            var prefix = line.type === "@" ? "" : line.type + " ";
            rows.push("<div class='mh__line " + cls + "'>" + escapeHtml(prefix + line.text) + "</div>");
          }
          parts.push("<div class='mh__lines'>" + rows.join("") + "</div>");
        }
      } else if (!report.identical) {
        parts.push("<div class='mh__drow'><span class='mh__dlabel'>jsonata</span>" +
          "<span>The generated expression is unchanged.</span></div>");
      }
      return "<div class='mh__diff'>" + parts.join("") + "</div>";
    }

    function entryHtml(entry, nowMs) {
      var isCurrent = entry.id === currentId;
      var labelled = (entry.label || "") !== "";
      var classes = ["card", "mh__entry"];
      if (isCurrent) classes.push("is-current");
      if (entry.kind === "manual" || labelled) classes.push("is-manual");
      var badgeClass = entry.kind === "manual" || labelled ? "badge badge--grp" : "badge";
      var title = labelled ? entry.label : absoluteTime(entry.at);
      return "<div class='" + classes.join(" ") + "' data-mh-entry='" + escapeHtml(entry.id) + "'>" +
        "<div class='card__head'>" +
          "<span class='" + badgeClass + "'>" + (entry.kind === "manual" ? "saved" : "auto") + "</span>" +
          "<span class='card__title' title='" + escapeHtml(absoluteTime(entry.at)) + "'>" + escapeHtml(title) + "</span>" +
          (isCurrent ? "<span class='badge badge--sec'>loaded</span>" : "") +
          "<span class='card__meta'>" + escapeHtml(entry.summary) + "</span>" +
          "<span class='mh__when' title='" + escapeHtml(absoluteTime(entry.at)) + "'>" +
            escapeHtml(relativeTime(entry.at, nowMs)) + "</span>" +
          "<div class='mh__acts'>" +
            "<button type='button' class='btn btn--tiny' data-mh-act='restore' data-mh-id='" + escapeHtml(entry.id) + "'>Restore</button>" +
            "<button type='button' class='btn btn--tiny' data-mh-act='diff' data-mh-id='" + escapeHtml(entry.id) + "'>" +
              (openDiffs[entry.id] ? "Hide diff" : "Diff") + "</button>" +
            "<button type='button' class='btn btn--tiny' data-mh-act='rename' data-mh-id='" + escapeHtml(entry.id) + "'>Rename</button>" +
            "<button type='button' class='btn btn--tiny' data-mh-act='delete' data-mh-id='" + escapeHtml(entry.id) + "'>Delete</button>" +
          "</div>" +
        "</div>" +
        (openDiffs[entry.id] ? diffHtml(entry.id) : "") +
        "</div>";
    }

    function paint() {
      if (!mount) return;
      var nowMs = now();
      var state = status();
      var head =
        "<div class='mh__bar'>" +
          "<input class='control' data-mh='label' placeholder='Label this version…' " +
            "aria-label='Snapshot label' value='" + escapeHtml(draftLabel) + "'>" +
          "<button type='button' class='btn btn--tiny' data-mh-act='save'>Save snapshot</button>" +
          "<div style='flex:1'></div>" +
          "<button type='button' class='btn btn--tiny' data-mh-act='clear'>Clear all</button>" +
        "</div>";

      var bits = [
        "<span><b>" + state.count + "</b> " + (state.count === 1 ? "version" : "versions") + "</span>",
        "<span class='p'>·</span>",
        "<span><b>" + state.autosaves + "</b>/" + state.autosaveLimit + " autosaves</span>",
        "<span class='p'>·</span>",
        "<span>" + (state.mode === "local" ? "saved in this browser" : "in memory only") + "</span>"
      ];
      /* With nothing saved yet the empty state already says it — no need to nag twice. */
      if (state.dirty && state.count) {
        bits.push("<span class='p'>·</span><span>unsaved changes since the newest snapshot</span>");
      }
      if (state.notice) {
        bits.push("<span class='p'>·</span><span>" + escapeHtml(state.notice) + "</span>");
      }
      var statusHtml = "<div class='status" + (state.mode === "local" ? "" : " is-bad") + "' data-mh='status'>" +
        bits.join("") + "</div>";

      var body;
      if (!entries.length) {
        body = "<div class='mh__empty'>No versions yet. Edit the form and one is kept automatically, " +
          "or press <b>Save snapshot</b> to keep this one for good.</div>";
      } else {
        var rows = [];
        for (var i = 0; i < entries.length; i++) rows.push(entryHtml(entries[i], nowMs));
        body = rows.join("");
      }

      if (mount.classList) mount.classList.add("mh");
      else if ((" " + mount.className + " ").indexOf(" mh ") < 0) {
        mount.className = (mount.className + " mh").replace(/^\s+/, "");
      }
      mount.innerHTML = head + statusHtml + "<div class='mh__list'>" + body + "</div>";
    }

    function destroy() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (mount && mount.__mhWired) {
        mount.removeEventListener("click", onClick);
        mount.removeEventListener("input", onInput);
        mount.removeEventListener("keydown", onKeydown);
        mount.__mhWired = false;
      }
      mount = null;
    }

    var controller = {
      save: save,
      list: list,
      get: get,
      restore: restore,
      rename: rename,
      remove: remove,
      clear: clear,
      diff: diff,
      notifyChange: notifyChange,
      flush: flush,
      status: status,
      renderInto: renderInto,
      refresh: paint,
      destroy: destroy,
      storageKey: store.key
    };
    return controller;
  }

  return {
    init: init,
    STORAGE_KEY: DEFAULT_KEY,
    /* exported for tests, not for the page */
    _internal: {
      canon: canon,
      summarise: summarise,
      countsOf: countsOf,
      indexConfig: indexConfig,
      compareBuckets: compareBuckets,
      diffLines: diffLines,
      relativeTime: relativeTime
    }
  };
});
