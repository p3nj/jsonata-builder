/* ══════════════════════════════════════════════════════════════════════════════════════
   JSONata playground — a try.jsonata.org in a child tab, seeded from the builder.

     MappingPlayground.open({ expression: state.expr, input: state.inputText })

   The page it opens is self-contained: no network request of any kind, because the built
   demo page is allowed none. Everything the child needs is handed to it from the parent
   document —

     jsonata      the parent's own inlined <script> text, located by signature and replayed
                  into the child document as a fresh <script> node
     styles       the parent's inline <style> text (exact token + class parity), with a
                  built-in fallback stylesheet when no inline <style> can be found
     the UI       this file's PLAYGROUND function, serialised with Function#toString and
                  re-executed inside the child

   Nothing in the child calls back into the opener once it is running, so closing the
   builder — or the builder navigating away — leaves a working playground behind.

   When window.open is blocked (popup blocker, or a sandboxed iframe without
   allow-popups), the exact same UI is mounted as an overlay inside the current page and
   the reason is stated in its header rather than failing silently.

   Written as portable ES5, UMD-wrapped like generator.js. PLAYGROUND below is deliberately
   closure-free: it may reference only its own arguments and browser globals, because it is
   stringified and evaluated in another document.
   ══════════════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MappingPlayground = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ══ The playground itself ═══════════════════════════════════════════════════════════
     Builds the whole UI into `host` (a child-document body, or an overlay div in this
     page) and wires live evaluation. Runs in whichever document `doc` belongs to.

     doc        the document that owns `host`
     host       element to fill
     jsonataFn  that document's jsonata factory
     opts       { expression, input, title, notice, bindings, embedded, onClose }

     Self-contained on purpose — see the header note. ═════════════════════════════════ */
  function PLAYGROUND(doc, host, jsonataFn, opts) {
    "use strict";
    opts = opts || {};

    var DEBOUNCE = 180;
    var MAX_RENDER = 400000; // characters of result JSON painted before truncating

    /* ── tiny DOM helpers ────────────────────────────────────────────────────────── */
    function el(tag, cls, text) {
      var node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }
    function add(parent, child) { parent.appendChild(child); return child; }
    function escapeHtml(text) {
      return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }
    function now() {
      return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    }
    function ms(value) {
      return value < 10 ? value.toFixed(1) + " ms" : Math.round(value) + " ms";
    }

    /** Same palette classes as the builder's own JSON view. */
    function highlightJson(text) {
      return escapeHtml(text).replace(
        /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
        function (match) {
          var cls = "n";
          if (/^"/.test(match)) cls = /:$/.test(match) ? "k" : "s";
          else if (/true|false|null/.test(match)) cls = "l";
          return '<span class="' + cls + '">' + match + "</span>";
        }
      );
    }

    /** Character offset -> 1-based line / char, for jsonata's error.position. */
    function locate(text, position) {
      var line = 1, char = 1;
      var limit = Math.max(0, Math.min(position, text.length));
      for (var i = 0; i < limit; i++) {
        if (text.charAt(i) === "\n") { line++; char = 1; } else { char++; }
      }
      return { line: line, char: char };
    }

    /** The offending line with a caret under it — the one comfort that saves a squint. */
    function caretExcerpt(text, position) {
      var at = locate(text, position);
      var line = text.split("\n")[at.line - 1] || "";
      var lead = String(at.line) + " | ";
      var pointer = new Array(lead.length + Math.max(0, at.char - 1) + 1).join(" ") + "^";
      return { at: at, text: lead + line + "\n" + pointer };
    }

    function describe(error) {
      var message = (error && (error.message || error.msg)) || String(error);
      var code = error && error.code ? error.code + ": " : "";
      return code + message;
    }

    /* ── shell ───────────────────────────────────────────────────────────────────── */
    var rootEl = el("div", "pg-root" + (opts.embedded ? " pg-root--embedded" : ""));
    host.appendChild(rootEl);

    var head = add(rootEl, el("header", "masthead pg-head"));
    var headText = add(head, el("div"));
    add(headText, el("h1", null, opts.title || "JSONata playground"));
    var sub = add(headText, el("p", null,
      "Seeded from the builder. Edit either side — nothing here changes the builder."));
    if (opts.notice) {
      sub.textContent = opts.notice;
      sub.className = "pg-notice";
    }
    add(head, el("div", "spacer"));

    var actions = add(head, el("div", "pg-actions"));
    var themeBtn = add(actions, el("button", "btn btn--tiny", "Theme: auto"));
    themeBtn.type = "button";
    var resetBtn = add(actions, el("button", "btn btn--tiny", "Restore seed"));
    resetBtn.type = "button";
    var runBtn = add(actions, el("button", "btn btn--tiny", "Run"));
    runBtn.type = "button";
    runBtn.title = "Ctrl/⌘ + Enter";
    var closeBtn = null;
    if (opts.embedded) {
      closeBtn = add(actions, el("button", "btn btn--tiny", "Close"));
      closeBtn.type = "button";
    }

    var grid = add(rootEl, el("main", "pg-grid"));

    /* Source JSON ------------------------------------------------------------------ */
    var inputPane = add(grid, el("section", "pane pg-pane--input"));
    var inputHead = add(inputPane, el("div", "pane__head"));
    add(inputHead, el("span", "pane__title", "Source JSON"));
    add(inputHead, el("div", "spacer"));
    var inputMeta = add(inputHead, el("span", "card__meta", ""));
    var formatBtn = add(inputHead, el("button", "btn btn--tiny", "Format"));
    formatBtn.type = "button";
    var inputBody = add(inputPane, el("div", "pane__body"));
    var inputBox = add(inputBody, el("textarea", "editor pg-editor"));
    inputBox.spellcheck = false;
    inputBox.setAttribute("aria-label", "Source JSON");
    var inputStatus = add(inputPane, el("div", "status", " "));

    /* Expression ------------------------------------------------------------------- */
    var exprPane = add(grid, el("section", "pane pg-pane--expr"));
    var exprHead = add(exprPane, el("div", "pane__head"));
    add(exprHead, el("span", "pane__title", "JSONata"));
    add(exprHead, el("div", "spacer"));
    var exprMeta = add(exprHead, el("span", "card__meta", ""));
    var exprBody = add(exprPane, el("div", "pane__body"));
    var exprBox = add(exprBody, el("textarea", "editor pg-editor pg-editor--expr"));
    exprBox.spellcheck = false;
    exprBox.setAttribute("aria-label", "JSONata expression");
    var exprStatus = add(exprPane, el("div", "status", " "));
    var exprCaret = add(exprPane, el("pre", "pg-caret hidden"));

    /* Result ----------------------------------------------------------------------- */
    var outPane = add(grid, el("section", "pane pg-pane--result"));
    var outHead = add(outPane, el("div", "pane__head"));
    add(outHead, el("span", "pane__title", "Result"));
    var staleBadge = add(outHead, el("span", "badge pg-stale hidden", "stale"));
    add(outHead, el("div", "spacer"));
    var copyBtn = add(outHead, el("button", "btn btn--tiny", "Copy result"));
    copyBtn.type = "button";
    var outBody = add(outPane, el("div", "pane__body"));
    var outView = add(outBody, el("pre", "code pg-out"));
    var outStatus = add(outPane, el("div", "status", " "));

    /* ── seeds ───────────────────────────────────────────────────────────────────── */
    var seedExpr = typeof opts.expression === "string" ? opts.expression : "";
    var seedInput = typeof opts.input === "string"
      ? opts.input
      : JSON.stringify(opts.input === undefined ? {} : opts.input, null, 2);
    inputBox.value = seedInput;
    exprBox.value = seedExpr;

    /* ── status painting ─────────────────────────────────────────────────────────── */
    function setStatus(node, text, bad, html) {
      node.className = "status" + (bad ? " is-bad" : "");
      if (html) node.innerHTML = html; else node.textContent = text || " ";
    }
    function setStale(isStale) {
      staleBadge.className = "badge pg-stale" + (isStale ? "" : " hidden");
      outView.className = "code pg-out" + (isStale ? " is-stale" : "");
    }

    /* ── evaluation ──────────────────────────────────────────────────────────────── */
    var timer = null;
    var ticket = 0;
    var lastGood = null;

    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(evaluate, DEBOUNCE);
    }

    function paintResult(value, elapsed, compileMs) {
      var text = value === undefined ? "undefined" : JSON.stringify(value, null, 2);
      if (text === undefined) text = String(value); // functions / cyclic guards
      var shown = text.length > MAX_RENDER ? text.slice(0, MAX_RENDER) : text;
      outView.innerHTML = highlightJson(shown) +
        (shown.length < text.length
          ? '<span class="c">\n\n… ' + (text.length - shown.length) + " more characters not shown</span>"
          : "");
      setStale(false);
      lastGood = text;
      var type = value === undefined ? "undefined"
        : Array.isArray(value) ? "array (" + value.length + ")"
        : value === null ? "null" : typeof value;
      setStatus(outStatus, null, false,
        "<span><b>" + ms(elapsed) + "</b> evaluate</span><span class='p'>·</span>" +
        "<span><b>" + ms(compileMs) + "</b> compile</span><span class='p'>·</span>" +
        "<span><b>" + text.length.toLocaleString() + "</b> chars</span><span class='p'>·</span>" +
        "<span>" + escapeHtml(type) + "</span>");
    }

    function failed(node, error, expressionText) {
      var message = describe(error);
      var position = error && typeof error.position === "number" ? error.position : null;
      exprCaret.className = "pg-caret hidden";
      if (position !== null && expressionText) {
        var spot = caretExcerpt(expressionText, position);
        message += " — line " + spot.at.line + ", char " + spot.at.char + " (position " + position + ")";
        if (error.token) message += ", token “" + error.token + "”";
        exprCaret.textContent = spot.text;
        exprCaret.className = "pg-caret";
      } else if (error && error.token) {
        message += " — token “" + error.token + "”";
      }
      setStatus(node, message, true);
      setStale(true);
    }

    function evaluate() {
      var expressionText = exprBox.value;
      var sourceText = inputBox.value;

      inputMeta.textContent = sourceText.length.toLocaleString() + " chars";
      exprMeta.textContent = expressionText.split("\n").length + " lines";

      var model;
      try {
        model = JSON.parse(sourceText);
      } catch (parseError) {
        setStatus(inputStatus, "Not valid JSON — " + parseError.message, true);
        setStale(true);
        return;
      }
      setStatus(inputStatus, Array.isArray(model)
        ? "Array of " + model.length + " — parsed"
        : model && typeof model === "object"
          ? Object.keys(model).length + " top-level keys — parsed"
          : "Parsed (" + (model === null ? "null" : typeof model) + ")");

      var compileStart = now();
      var compiled;
      try {
        compiled = jsonataFn(expressionText);
      } catch (compileError) {
        failed(exprStatus, compileError, expressionText);
        return;
      }
      var compileMs = now() - compileStart;
      setStatus(exprStatus, "Compiled.");
      exprCaret.className = "pg-caret hidden";

      var mine = ++ticket;
      var started = now();
      var result;
      try {
        // jsonata 1.x evaluates synchronously and throws; 2.x returns a promise.
        result = opts.bindings ? compiled.evaluate(model, opts.bindings) : compiled.evaluate(model);
      } catch (syncError) {
        failed(outStatus, syncError, expressionText);
        return;
      }

      if (result && typeof result.then === "function") {
        result.then(
          function (value) { if (mine === ticket) paintResult(value, now() - started, compileMs); },
          function (error) { if (mine === ticket) failed(outStatus, error, expressionText); }
        );
      } else {
        paintResult(result, now() - started, compileMs);
      }
    }

    /* ── comforts ────────────────────────────────────────────────────────────────── */
    function onTab(event) {
      if (event.key !== "Tab" || event.shiftKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      var box = event.target;
      var at = box.selectionStart;
      box.value = box.value.slice(0, at) + "  " + box.value.slice(box.selectionEnd);
      box.selectionStart = box.selectionEnd = at + 2;
      schedule();
    }

    [inputBox, exprBox].forEach(function (box) {
      box.addEventListener("input", schedule);
      box.addEventListener("keydown", function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          evaluate();
          return;
        }
        onTab(event);
      });
    });

    runBtn.addEventListener("click", evaluate);

    resetBtn.addEventListener("click", function () {
      inputBox.value = seedInput;
      exprBox.value = seedExpr;
      evaluate();
    });

    formatBtn.addEventListener("click", function () {
      try {
        inputBox.value = JSON.stringify(JSON.parse(inputBox.value), null, 2);
        evaluate();
      } catch (error) {
        setStatus(inputStatus, "Cannot format — " + error.message, true);
      }
    });

    /* Clipboard has to survive a sandboxed host: async API, then execCommand, then
       select-the-text so ⌘C / Ctrl+C finishes it. */
    copyBtn.addEventListener("click", function () {
      var text = lastGood === null ? outView.textContent : lastGood;
      var restore = "Copy result";
      var settle = function (label, ok) {
        copyBtn.textContent = label;
        copyBtn.className = "btn btn--tiny" + (ok ? " is-copied" : "");
        setTimeout(function () {
          copyBtn.textContent = restore;
          copyBtn.className = "btn btn--tiny";
        }, 1600);
      };
      var viaTextarea = function () {
        var scratch = doc.createElement("textarea");
        scratch.value = text;
        scratch.setAttribute("readonly", "");
        scratch.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
        doc.body.appendChild(scratch);
        scratch.focus();
        scratch.select();
        var ok = false;
        try { ok = doc.execCommand("copy"); } catch (error) { ok = false; }
        doc.body.removeChild(scratch);
        if (ok) { settle("Copied", true); return; }
        var range = doc.createRange();
        range.selectNodeContents(outView);
        var selection = (doc.defaultView || window).getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        settle("Press ⌘C / Ctrl+C", false);
      };
      var clip = (doc.defaultView || window).navigator.clipboard;
      if (clip && clip.writeText) clip.writeText(text).then(function () { settle("Copied", true); }, viaTextarea);
      else viaTextarea();
    });

    /* auto -> light -> dark, stamped the way the builder's stylesheet expects. */
    var themes = ["auto", "light", "dark"];
    var themeAt = themes.indexOf(opts.theme || "auto");
    if (themeAt < 0) themeAt = 0;
    function paintTheme() {
      var theme = themes[themeAt];
      var target = opts.embedded ? null : doc.documentElement;
      if (target) {
        if (theme === "auto") target.removeAttribute("data-theme");
        else target.setAttribute("data-theme", theme);
      }
      themeBtn.textContent = "Theme: " + theme;
    }
    themeBtn.addEventListener("click", function () {
      themeAt = (themeAt + 1) % themes.length;
      paintTheme();
    });
    if (opts.embedded) themeBtn.className = "btn btn--tiny hidden"; // the host page owns the theme
    paintTheme();

    if (closeBtn) {
      closeBtn.addEventListener("click", function () {
        if (opts.onClose) opts.onClose();
      });
    }

    evaluate();
    setTimeout(function () { exprBox.focus(); }, 0);

    return { evaluate: evaluate, inputBox: inputBox, exprBox: exprBox, root: rootEl };
  }

  /* ══ Styles ═════════════════════════════════════════════════════════════════════════
     Everything is scoped under .pg-root / .pg-overlay so mounting the overlay inside the
     builder cannot disturb it. Component classes (.pane, .btn, .editor, .code, .status)
     come from the parent page's own stylesheet when we can read it; BASE_CSS stands in
     when we cannot. TOKEN_CSS mirrors styles.css exactly, including both dark paths. ══ */
  var TOKEN_CSS = [
    ":root{",
    "--ground:#f4f5f8;--surface:#ffffff;--surface-sunken:#eef0f5;--surface-raised:#f9fafc;",
    "--line:#dcdfe8;--line-strong:#c3c8d6;--ink:#171a22;--ink-soft:#4d5464;--ink-faint:#767e91;",
    "--accent:#5b4bc4;--accent-soft:#ece9fb;--accent-ink:#ffffff;",
    "--ok:#1a7a4c;--ok-soft:#e2f2e9;--warn:#9a5c00;--warn-soft:#faeedb;--bad:#b3261e;--bad-soft:#fbe6e4;",
    "--code-key:#5b4bc4;--code-str:#1a6a4e;--code-num:#9a4a10;--code-lit:#7a2f8f;--code-punc:#767e91;",
    "--shadow:0 1px 2px rgba(23,26,34,.06),0 6px 18px rgba(23,26,34,.05);",
    "--focus:0 0 0 3px color-mix(in srgb, var(--accent) 32%, transparent);",
    "--mono:ui-monospace,'SF Mono','JetBrains Mono','Cascadia Mono',Menlo,Consolas,monospace;",
    "--sans:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,'Helvetica Neue',sans-serif;",
    "--r:7px;}",
    "@media (prefers-color-scheme: dark){:root:not([data-theme='light']){",
    "--ground:#0e1016;--surface:#161923;--surface-sunken:#11141c;--surface-raised:#1c2130;",
    "--line:#272d3c;--line-strong:#394155;--ink:#e7eaf2;--ink-soft:#a5adc0;--ink-faint:#7a8399;",
    "--accent:#a396ff;--accent-soft:#262450;--accent-ink:#14121f;",
    "--ok:#57c98b;--ok-soft:#123021;--warn:#e0a94a;--warn-soft:#3a2d13;--bad:#ff8a80;--bad-soft:#3a1a19;",
    "--code-key:#a396ff;--code-str:#6fd39d;--code-num:#f0a86a;--code-lit:#dd9de8;--code-punc:#7a8399;",
    "--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.3);}}",
    ":root[data-theme='dark']{",
    "--ground:#0e1016;--surface:#161923;--surface-sunken:#11141c;--surface-raised:#1c2130;",
    "--line:#272d3c;--line-strong:#394155;--ink:#e7eaf2;--ink-soft:#a5adc0;--ink-faint:#7a8399;",
    "--accent:#a396ff;--accent-soft:#262450;--accent-ink:#14121f;",
    "--ok:#57c98b;--ok-soft:#123021;--warn:#e0a94a;--warn-soft:#3a2d13;--bad:#ff8a80;--bad-soft:#3a1a19;",
    "--code-key:#a396ff;--code-str:#6fd39d;--code-num:#f0a86a;--code-lit:#dd9de8;--code-punc:#7a8399;",
    "--shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.3);}",
    "*{box-sizing:border-box}",
    "body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}",
    "button,input,select,textarea{font:inherit;color:inherit}",
    ":focus-visible{outline:none;box-shadow:var(--focus);border-radius:4px}"
  ].join("\n");

  var BASE_CSS = [
    ".pane{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--shadow);overflow:hidden}",
    ".pane__head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--line);background:var(--surface-raised);min-height:42px}",
    ".pane__title{font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-soft);white-space:nowrap}",
    ".pane__body{flex:1 1 auto;min-height:0;overflow:auto}",
    ".masthead{display:flex;flex-wrap:wrap;align-items:center;gap:10px 20px;padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--line)}",
    ".masthead h1{margin:0;font-family:var(--mono);font-size:15px;font-weight:600}",
    ".masthead p{margin:2px 0 0;color:var(--ink-soft);font-size:12.5px;max-width:62ch}",
    ".spacer{flex:1 1 auto}",
    ".btn{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border:1px solid var(--line-strong);border-radius:999px;background:var(--surface);color:var(--ink-soft);font-size:12px;cursor:pointer}",
    ".btn:hover{color:var(--ink);border-color:var(--accent)}",
    ".btn--tiny{padding:2px 7px;font-size:11px}",
    ".btn.is-copied{border-color:var(--ok);color:var(--ok)}",
    ".editor{width:100%;height:100%;min-height:200px;padding:12px;border:0;resize:none;background:var(--surface);color:var(--ink);font-family:var(--mono);font-size:12px;line-height:1.55;tab-size:2}",
    ".editor:focus{outline:none;box-shadow:none}",
    ".code{margin:0;padding:12px;font-family:var(--mono);font-size:12px;line-height:1.55;white-space:pre;overflow-x:auto}",
    ".code .k{color:var(--code-key)}.code .s{color:var(--code-str)}.code .n{color:var(--code-num)}",
    ".code .l{color:var(--code-lit)}.code .p{color:var(--code-punc)}.code .c{color:var(--ink-faint);font-style:italic}",
    ".status{display:flex;align-items:center;gap:8px;padding:6px 10px;border-top:1px solid var(--line);background:var(--surface-raised);font-family:var(--mono);font-size:11px;color:var(--ink-soft);flex-wrap:wrap}",
    ".status.is-bad{background:var(--bad-soft);color:var(--bad)}",
    ".status b{color:var(--ink);font-weight:600;font-variant-numeric:tabular-nums}",
    ".status.is-bad b{color:var(--bad)}",
    ".card__meta{font-family:var(--mono);font-size:11px;color:var(--ink-faint);white-space:nowrap}",
    ".badge{font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.06em;padding:2px 6px;border-radius:4px;background:var(--surface-sunken);color:var(--ink-soft);white-space:nowrap}",
    ".hidden{display:none !important}"
  ].join("\n");

  /* Every rule is prefixed with .pg-root so it outranks the page's own .pane / .editor /
     .masthead rules wherever this stylesheet lands in the cascade — in the child it is
     appended last, but in the overlay it goes in <head> while the demo page's <style>
     sits in <body> and would otherwise win on document order. */
  var PLAYGROUND_CSS = [
    ".pg-root{display:flex;flex-direction:column;height:100vh;min-height:0;background:var(--ground);color:var(--ink);font-family:var(--sans);font-size:14px}",
    ".pg-root.pg-root--embedded{height:100%}",
    ".pg-root .pg-head{padding:10px 16px}",
    ".pg-root .pg-head h1{font-size:14px}",
    ".pg-root .pg-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
    ".pg-root .pg-notice{margin:2px 0 0;font-size:12px;color:var(--warn);max-width:70ch}",
    ".pg-root .pg-grid{display:grid;grid-template-columns:minmax(280px,44fr) minmax(300px,56fr);grid-template-rows:minmax(180px,1fr) minmax(160px,.85fr);gap:12px;padding:12px;flex:1 1 auto;min-height:0}",
    ".pg-root .pg-grid>.pane{min-width:0;min-height:0}",
    ".pg-root .pg-pane--result{grid-column:2;grid-row:1 / span 2}",
    ".pg-root .pg-editor{min-height:120px}",
    ".pg-root .pg-editor--expr{border-left:3px solid var(--accent)}",
    ".pg-root .pg-caret{margin:0;padding:6px 10px;border-top:1px solid var(--line);background:var(--bad-soft);color:var(--bad);font-family:var(--mono);font-size:11px;line-height:1.4;white-space:pre;overflow-x:auto}",
    ".pg-root .pg-stale{background:var(--warn-soft);color:var(--warn)}",
    ".pg-root .pg-out{min-height:100%}",
    ".pg-root .pg-out.is-stale{opacity:.55}",
    ".pg-root .hidden{display:none !important}",
    ".pg-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(10,12,18,.55)}",
    ".pg-overlay__frame{width:min(1400px,100%);height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--ground);border:1px solid var(--line-strong);border-radius:var(--r);box-shadow:var(--shadow)}",
    "@media (max-width:960px){",
    ".pg-root{height:auto}",
    ".pg-root .pg-grid{grid-template-columns:minmax(0,1fr);grid-template-rows:repeat(3,minmax(240px,1fr));height:auto}",
    ".pg-root .pg-pane--result{grid-column:auto;grid-row:auto}}"
  ].join("\n");

  /* ══ Getting jsonata across ═════════════════════════════════════════════════════════
     The built page inlines jsonata.min.js in a <script> with no src. Find that script by
     signature (UMD preamble + jsonata's own error codes) and replay its text into the
     child. Nothing is fetched, so this works identically on file://, https:// and inside
     a sandboxed iframe. ═══════════════════════════════════════════════════════════════ */
  function findJsonataSource(doc) {
    doc = doc || document;
    var scripts = doc.getElementsByTagName("script");
    var best = null;
    for (var i = 0; i < scripts.length; i++) {
      var node = scripts[i];
      if (node.src) continue;
      var text = node.text || node.textContent || "";
      if (text.length < 20000) continue;
      // jsonata's error catalogue is the cheapest reliable fingerprint.
      if (!/jsonata/i.test(text)) continue;
      if (!/T1006|S0201|D1001|T0410|S0101/.test(text)) continue;
      if (!best || text.length > best.length) best = text;
    }
    return best;
  }

  /** The page's own inline CSS, so the child is a pixel match rather than a lookalike. */
  function collectStyles(doc) {
    doc = doc || document;
    var styles = doc.getElementsByTagName("style");
    var parts = [];
    for (var i = 0; i < styles.length; i++) {
      var text = styles[i].textContent || "";
      if (text) parts.push(text);
    }
    return parts.join("\n");
  }

  function currentTheme(doc) {
    doc = doc || document;
    return doc.documentElement.getAttribute("data-theme") || "auto";
  }

  function bootSource(opts) {
    return "(" + PLAYGROUND.toString() + ")(document, document.body, window.jsonata, " +
      JSON.stringify(opts) + "); window.__MAPPING_PLAYGROUND_READY__ = true;";
  }

  /**
   * Append a script *node* rather than writing markup: nothing in this file — or in the
   * jsonata source it replays — ever has to be escaped against a closing script tag.
   * (Which is also why no string in this file may contain that tag: the whole file is
   * inlined into the demo page by build.mjs and would truncate itself.)
   */
  function runScript(targetDoc, source) {
    var node = targetDoc.createElement("script");
    node.type = "text/javascript";
    node.text = source;
    (targetDoc.head || targetDoc.documentElement).appendChild(node);
  }

  function addStyle(targetDoc, css) {
    var node = targetDoc.createElement("style");
    node.appendChild(targetDoc.createTextNode(css));
    (targetDoc.head || targetDoc.documentElement).appendChild(node);
  }

  /* ══ Overlay fallback ══════════════════════════════════════════════════════════════ */
  var overlay = null;

  function closeOverlay() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
  }

  function openOverlay(opts, notice) {
    closeOverlay();
    if (!document.getElementById("pg-overlay-css")) {
      var style = document.createElement("style");
      style.id = "pg-overlay-css";
      style.appendChild(document.createTextNode(PLAYGROUND_CSS));
      document.head.appendChild(style);
    }
    overlay = document.createElement("div");
    overlay.className = "pg-overlay";
    var frame = document.createElement("div");
    frame.className = "pg-overlay__frame";
    overlay.appendChild(frame);
    document.body.appendChild(overlay);

    var handle = PLAYGROUND(document, frame, window.jsonata, {
      expression: opts.expression,
      input: opts.input,
      title: opts.title,
      bindings: opts.bindings,
      notice: notice,
      embedded: true,
      onClose: closeOverlay
    });

    document.addEventListener("keydown", function escape(event) {
      if (event.key === "Escape" && overlay) {
        closeOverlay();
        document.removeEventListener("keydown", escape);
      }
    });

    return { ok: true, mode: "overlay", notice: notice, close: closeOverlay, handle: handle };
  }

  /* ══ Public API ════════════════════════════════════════════════════════════════════ */
  var child = null;

  /**
   * open({ expression, input, title, bindings })
   *
   *   expression  JSONata source to seed the editor with
   *   input       source JSON — a string (used verbatim) or a value (stringified)
   *   title       child tab title, default "JSONata playground"
   *   bindings    optional object of $variables passed to evaluate()
   *
   * Returns { ok, mode: "tab" | "overlay", reason?, message?, close() }. Never throws and
   * never leaves a blank tab behind: every failure either degrades to the in-page overlay
   * or comes back with a message worth showing the user.
   */
  function open(options) {
    options = options || {};
    var seeded = {
      expression: typeof options.expression === "string" ? options.expression : "",
      input: typeof options.input === "string"
        ? options.input
        : JSON.stringify(options.input === undefined ? {} : options.input, null, 2),
      title: options.title || "JSONata playground",
      bindings: options.bindings || null
    };

    var haveLocal = typeof window !== "undefined" && typeof window.jsonata === "function";
    var source = findJsonataSource(document);

    if (!source && !haveLocal) {
      return {
        ok: false,
        mode: "none",
        reason: "no-jsonata",
        message: "The jsonata library could not be found in this page, so a playground " +
          "cannot be opened without a network request."
      };
    }

    // No library source to hand over: the child could not evaluate anything on its own.
    if (!source) {
      return openOverlay(seeded,
        "Opened inside the builder: this page has no inlined jsonata source to hand a " +
        "separate tab, so the playground runs here instead.");
    }

    var win = null;
    try {
      win = window.open("", "_blank");
    } catch (error) {
      win = null;
    }

    if (!win) {
      return openOverlay(seeded,
        "Your browser blocked the new tab. Allow popups for this page to get the " +
        "playground in its own tab — for now it is running here.");
    }

    /* A popup opened from a sandboxed iframe without allow-same-origin gets its own
       opaque origin, so even reading win.document throws. Probe before touching it —
       this check must sit outside the build below, or the throw escapes as an uncaught
       SecurityError and the husk tab is left open. */
    var reachable = false;
    try { reachable = !!win.document; } catch (error) { reachable = false; }
    if (!reachable) {
      try { win.close(); } catch (ignored) { /* nothing to do */ }
      if (!haveLocal) {
        return {
          ok: false,
          mode: "none",
          reason: "cross-origin-popup",
          message: "The new tab is cross-origin to this page (a sandboxed frame without " +
            "allow-same-origin), so it cannot be handed the jsonata library."
        };
      }
      return openOverlay(seeded,
        "The new tab this page can open is cross-origin to it (a sandboxed frame), so it " +
        "cannot be handed the jsonata library — the playground is running here instead.");
    }

    try {
      var doc = win.document;
      doc.open();
      doc.write('<!doctype html><html><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        "</head><body></body></html>");
      doc.close();
      doc.title = seeded.title;

      var theme = currentTheme(document);
      if (theme !== "auto") doc.documentElement.setAttribute("data-theme", theme);

      var pageCss = collectStyles(document);
      addStyle(doc, TOKEN_CSS);
      addStyle(doc, pageCss || BASE_CSS);
      addStyle(doc, PLAYGROUND_CSS);

      runScript(doc, source);
      if (typeof win.jsonata !== "function") throw new Error("jsonata did not initialise in the new tab");
      runScript(doc, bootSource({
        expression: seeded.expression,
        input: seeded.input,
        title: seeded.title,
        bindings: seeded.bindings,
        theme: theme
      }));
      if (!win.__MAPPING_PLAYGROUND_READY__) throw new Error("the playground script did not run in the new tab");

      child = win;
      return {
        ok: true,
        mode: "tab",
        window: win,
        close: function () { try { win.close(); } catch (error) { /* already gone */ } }
      };
    } catch (error) {
      // Cross-document access denied (sandbox without allow-same-origin, mostly) or the
      // tab died mid-build. Close the husk so no blank tab is left over, then degrade.
      try { win.close(); } catch (ignored) { /* nothing to do */ }
      if (!haveLocal) {
        return {
          ok: false,
          mode: "none",
          reason: "cross-document-blocked",
          message: "This page is not allowed to write into a new tab (" +
            (error.message || error) + "), and jsonata is not available here either."
        };
      }
      return openOverlay(seeded,
        "This page is not allowed to build a new tab (" + (error.message || error) +
        "), so the playground is running here instead.");
    }
  }

  function close() {
    closeOverlay();
    if (child) {
      try { child.close(); } catch (error) { /* already gone */ }
      child = null;
    }
  }

  return {
    open: open,
    close: close,
    /* exposed for tests and for callers that want to explain a degraded context */
    findJsonataSource: findJsonataSource,
    mount: PLAYGROUND,
    css: { tokens: TOKEN_CSS, base: BASE_CSS, playground: PLAYGROUND_CSS }
  };
});
