# jsonata-builder

**A form that writes JSONata for you — and then tries to break it.**

Mapping one system's JSON onto another's usually means a large hand-written JSONata expression,
edited per customer, with no validation until an execution fails. The shape being built is
nearly always the same; only the *keys and source paths* differ. So put the shape in a
generator and let a form hold the parts that change.

**[Open it →](https://p3nj.github.io/jsonata-builder/)**

One self-contained HTML file with the JSONata engine inlined. No build step, no network
access, nothing to install.

```
Mapping form  ──generate()──►  JSONata expression  ──►  your integration  ──►  target payload
```

## What it does

- **left** — the source response, editable. Every path in it feeds the autocomplete on each
  source field.
- **middle** — the mapping builder: one tree where every row edits its name and source in
  place, expands to the advanced options, and drags to a new position or parent. Tabs for
  the flow properties, the tests, and the version history.
- **right** — the payload the expression produces, plus the generated JSONata itself.

Every panel has a copy button.

## The model

One recursive node type. A node is an object, an array, a list, or a leaf:

```jsonc
{ "key": "Lines", "type": "array", "source": "lines",
  "item": { "type": "object", "children": [
    { "key": "Code", "type": "leaf", "source": "sku" }
  ]}}
```

- **leaf** — a value: a source path, several paths joined, a constant, or raw JSONata.
- **object** — named children.
- **array** — repeats `item` once per element of `source`. No source means one element built
  from the current record.
- **list** — several differently-sourced arrays appended into one flat list.

Nothing is special-cased. Any shape the target needs is expressible as some tree of these four.

### The vocabulary

Nothing in the form is an expression — that is what keeps a config change from becoming a code
change.

| Key | Applies to | Meaning |
| --- | --- | --- |
| `source` | leaf, array | dotted path, relative to the record it sits in |
| `sources` + `separator` | leaf | several paths joined, skipping the ones that are missing |
| `constant` | leaf | a literal |
| `fallbackSource` | leaf | used when the primary resolves to nothing |
| `transform` | leaf | `string`, `number`, `boolean`, `uppercase`, `lowercase`, `trim`, `date` |
| `prefix` / `suffix` | leaf | wrap the resolved value |
| `appendIndex` + `indexSeparator` | leaf | number each row — `Line 1`, `Line 2` |
| `scope` | leaf, array | `auto` (this record, then the enclosing one), `instance`, `parent`, `root` |
| `alwaysArray` | array, list | keep it a list at every cardinality, including zero and one |
| `filterPath` + `filterOperator` + `filterValue` | array | one predicate per array |

### Escape hatches

Anything the vocabulary cannot express takes raw JSONata, spliced in at that point:
`expression` on a leaf, `sourceExpression` on an array's source, `filterExpression` on its
filter. Inside one, `model` is the source response and `$$.properties.<name>` reaches the flow
properties.

One trap worth knowing: inside a **filter predicate** the current record rebinds to the item
being tested, so a bare `model.x` there finds nothing — write `$$.model.x`. The page reports
this before it runs anything. Inside a `$map` body there is no such problem.

## Testing the mapping

Evaluating against one healthy response answers "does this work", never "does this hold up".
The responses that break a mapping in production are the ordinary ones: a key absent, a value
null, a list empty, a number that arrived as `"n/a"`.

So the page keeps injuring the sample input on its own. A second or so after you stop typing it
derives every path in `model` the mapping actually reads, removes or corrupts them one at a
time, re-evaluates, and compares against the healthy run. Three things come back, and only the
first is what anyone expects:

| | |
| --- | --- |
| the field that read the injured path loses its value | fine — that is the mapping working |
| the **whole payload** is lost | one bad value discards every other correctly-mapped field |
| a **different** field quietly changes | no error, wrong data, and nothing else can show it |

Anything broken is marked **on the tree itself** — the row tinted and explained in place, and
the count carried up onto container rows so a fault cannot hide in a folded branch. The
**Tests** tab holds the full report, worst first, with a
click through to the offending field and a hand-off to the playground seeded with the exact
input that broke it.

The **Flow properties** tab lists the properties the mapping reads. Nothing in the vocabulary
names one — the only route is a hand-written `$$.properties.X` — so the list is discovered by
scanning, and the run covers each going missing, plus the case that matters most: a flow with
no properties configured at all.

**Exporting a suite** writes the run to a file a build can replay:

```bash
node parts/probe.replay.mjs --suite parts/suite-nested.json
```

What it records is each case's *verdict*, not the payload — so the diff stays proportional to
the change, and a case that used to conclude "only the fields reading it are affected" and now
concludes "damages something else" cannot slip past. Known problems can be marked `accepted`,
so the gate fails on what is new rather than on what was reviewed months ago.

## Other things it does

**Version history** keeps snapshots in localStorage — save with a label, restore, rename,
delete, and diff any version against the form. Autosave records one once the form goes quiet,
and never evicts a labelled one.

**Open in playground** opens a child tab in the spirit of try.jsonata.org, seeded with the
current expression and input, so experiments never disturb the builder.

**Import / export** reads and writes the mapping as JSON.

## Repository layout

| Path | Role |
| --- | --- |
| `index.html`, `site/index.html` | the generated page — build outputs, never edited by hand |
| `build.mjs` | assembles `parts/` into the page, inlining jsonata |
| `parts/nodes.js` | **the generator** — config in, JSONata out, plus validation; portable ES5 |
| `parts/probe.js` | the fault-injection engine — what to injure, and what the result means |
| `parts/tree-ui.js` | the builder: one recursive row renderer, editing and drag-and-drop in place |
| `parts/probe-ui.js` | the Tests panel, and the risk index the form's badges read |
| `parts/history.js` | version snapshots in localStorage |
| `parts/playground.js` | the child-tab playground |
| `parts/app.js`, `parts/page.html`, `parts/styles.css` | the page itself |
| `parts/sample-*.json` | the response, mapping and flow properties the page boots with |
| `parts/example-*.json` | the worked examples in the picker |
| `parts/*.test.js` | tests for the generator and the engine; plain node, no framework |
| `parts/probe.replay.mjs` | replays a committed suite in CI |
| `parts/suite-nested.json` | the committed regression pack |

## Rebuilding

```bash
npm install jsonata          # or set JSONATA_BUNDLE to a jsonata.min.js
node build.mjs
```

There is no `package.json`: the `parts/` files are plain ES5 that node can `require()` as they
are, and jsonata is the only thing the tests need.

```bash
node parts/nodes.test.js                                     # the generator
node parts/probe.test.js                                     # the fault-injection engine
node parts/probe.replay.mjs --suite parts/suite-nested.json  # the regression gate
```

Point `JSONATA_MODULE` at an install if they cannot find one.
