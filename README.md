<div align="center">

# StageFlow Editor

**Draw a pipeline, run it on the real core, watch it go node by node.**

[![release](https://img.shields.io/github/v/tag/leo-need-more-coffee/stageflow-ui?label=release)](https://github.com/leo-need-more-coffee/stageflow-ui/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](package.json)
[![no dependencies](https://img.shields.io/badge/dependencies-none-blue)](package.json)

[Try it](https://leo-need-more-coffee.github.io/stageflow-ui/) ·
[Try it on a live backend](https://leo-need-more-coffee.github.io/stageflow-ui/?backend=https://stageflow.lazy.su) ·
[Core](https://github.com/leo-need-more-coffee/stageflow) ·
[Example backend](https://github.com/leo-need-more-coffee/stageflow-example) ·
[Documentation](https://leo-need-more-coffee.github.io/stageflow/)

</div>

![The editor with a pipeline open](docs/img/editor.png)

A visual editor for [StageFlow](https://github.com/leo-need-more-coffee/stageflow)
pipelines. Plain HTML and ES modules: no build step, no framework, no
dependencies.

The editor holds no stages and executes nothing. It asks a StageFlow backend
for the stage specifications, draws the graph from them, and sends runs back
to that backend. So what the debugger shows is the core's own semantics, not a
second implementation of them in JavaScript.

## Run it

```bash
npm start                      # http://127.0.0.1:8080
```

or:

```bash
docker compose up --build      # http://127.0.0.1:8080
```

Then type the address of a backend on the connection screen — for example
`http://127.0.0.1:8765` if you are running the
[example](https://github.com/leo-need-more-coffee/stageflow-example). The
address is remembered, and `?backend=http://host:port` in the URL skips the
question. A backend that wants a credential gets one from the folded-away
**Authorization** field on the same screen — header name as well as value,
because the editor has no business deciding what a credential is called.

## Nothing to run? There is a public one

A small demo backend is up, so the editor has something to talk to without
installing anything:

**[Open the editor on it →](https://leo-need-more-coffee.github.io/stageflow-ui/?backend=https://stageflow.lazy.su)**

```
https://stageflow.lazy.su
```

Seven small stages — count the words in a text, roll dice, write a text out a
few words at a time as a stream, fail on purpose so `retry` has something to
retry — plus the seventeen the core ships with. No model and no network, so the
same graph gives the same answer every time.

Five ready-made graphs are served alongside it. Save one and open it with
`File → Import JSON…`:

| | Shows |
|---|---|
| [`01-text.json`](https://stageflow.lazy.su/pipelines/01-text.json) | a straight line and one `condition` |
| [`02-typing.json`](https://stageflow.lazy.su/pipelines/02-typing.json) | a stream in the debug panel, and reserve against charge |
| [`03-dice.json`](https://stageflow.lazy.su/pipelines/03-dice.json) | `parallel` branches, then a `switch` |
| [`04-retry.json`](https://stageflow.lazy.su/pipelines/04-retry.json) | `retry` getting through, and `try`/`except` catching what does not |
| [`05-map.json`](https://stageflow.lazy.su/pipelines/05-map.json) | `map` over a list, collecting into lists |

Visitors are anonymous and get a deliberately narrow plan: 30 seconds and 300
steps a run, four runs going at once across everybody, two per visitor. Paste
this in the **Authorization** field for a roomier one — every stage, 120
seconds, 3000 steps:

```
sf-demo-VrQtWaSG4rffbjZR
```

It is written here on purpose; there is nothing behind it to protect. Both
plans are capped, both forget everything when the run ends, and the backend
holds no secrets and reaches no network — so the worst a graph can do is spend
its own ceiling. [`&plan=plus`](https://leo-need-more-coffee.github.io/stageflow-ui/?backend=https://stageflow.lazy.su&plan=plus)
on the editor's own address shows what the wider plan allows **without being on
it** — the palette opens up, the ceilings change, and a run still goes on the
plan the credential says. That is the policy mechanism the
[core documents](https://leo-need-more-coffee.github.io/stageflow/policy/):
drawing is not running, and a name is not a permission.

If the connection screen says the backend is not reachable, the request is being
blocked before it leaves the browser — a blocklist, usually. The editor cannot
tell that apart from the backend being down; the browser's network tab, or
uBlock's logger, can.

`server.js` is a hundred lines of static file serving with no dependencies:
ES modules cannot be loaded from `file://`, so the page has to come over http.
`PORT` and `HOST` come from the environment (`UI_PORT` in compose).

## What it does

- **The graph is built on the canvas.** Pull a wire from a port onto a node to
  link them, or into empty space to create one there. `⊕` and `×` on a link
  insert and cut. A node dragged from the palette lands on a link or after a
  card. Every way of adding a node ends with a connection.
- **Two kinds of connector on two axes.** Execution order runs vertically and
  is the real `next` of the JSON; data flows run horizontally, are derived from
  the graph, and are coloured per variable.
- **Regions are derived, not drawn.** The branches of a `parallel`, the body
  and handlers of a `try`, the body of a `map` loop are framed from the
  structure of the graph, so a frame cannot disagree with it.
- **The inspector comes from the stage spec.** Forms instead of hand-written
  JSON, with unfilled required arguments marked.
- **Step debugging on the real core**: the current node on the graph, stepping,
  a pace between nodes, and frame variables you can read and edit mid-run.
- **It knows what the backend allows.** Node types it cannot run are greyed
  out, limits it would break are flagged before the run, and a run shows what
  it spent against what it was given.
- **Secrets stay out of the JSON.** Only the name of a key goes into the
  pipeline; values live in the store and never appear in the debug panel or
  the event log.
- **The interface speaks the reader's language.** A flat JSON catalog per
  language in `i18n/`, picked in "View → Language" and remembered; a language
  is a file plus a line, and nothing in the code names one. A stage's prose is
  the backend's, so it arrives in every language the backend has and the editor
  picks — the choice is made where the reader is, not a request away.
- Subpipelines, live validation, JSON import and export, undo/redo, a node
  clipboard, and a session that survives a reload.

![Step debugging](docs/img/debugger.png)

## Compatibility

The editor mirrors the core's node registry as it stood when the editor was
built, so an editor newer than the backend it is pointed at is the normal
case. It is not guessed from version numbers — the backend is asked:

```
GET /api/meta  ->  {"api": 1, "plan": "basic", "plan_source": "token",
                    "plans": ["basic", "full", "pro"], "stageflow": "0.13.0",
                    "node_types": [...], "stages": 5, "limits": {...}}
```

`node_types` is what this caller may use — the core's registry, narrowed by
whatever allowance the backend gives the caller. A type missing from it is
greyed out in the palette with the reason in the tooltip, and a graph already
using one says so in the status bar **before** a run rather than failing
halfway through it with `Unknown node type`. The status bar carries the pair,
`editor 0.6.1 · plan basic, core 0.13.0, api v1`.

`limits` is the other half, and the editor treats it the same way: what can be
judged from the graph is judged before the run. A graph whose shortest path is
longer than the allowed `steps`, or a `retry` asking for more attempts than
the backend permits, is an issue in the status bar rather than a surprise
partway through. What cannot be judged is left alone — a loop's cost comes
from its data, and guessing would refuse graphs that fit.

During and after a run the debug panel shows what was spent against what was
allowed (`steps 412/5000`, `tokens 5120/200000`), which is the point of a
ceiling: to be visible before it is reached.

The **Plan** section of the connection dialog draws the graph against another
plan of the same backend
(`?plan=` on `/api/meta` and `/api/stages`; `?plan=basic` on the editor's URL
opens it that way). That is a **view** — unverified on purpose, because a name
is not a permission and an editor that must log in before it can grey out a
palette entry is one nobody configures. What a run may do is the backend's
decision, taken from the credential: a graph prepared for a plan you are not
on is refused when it starts, by name, instead of dissolving into stages that
"do not exist". The status bar marks a preview as one.

A backend that serves no `/api/meta` — an older one, or somebody else's — is
not second-guessed: nothing is marked and everything works as before, because
a false "unsupported" would be worse than the error being avoided. The status
bar says the version is unknown.

| Editor | Speaks | Needs |
|---|---|---|
| 0.4.x | api v1 | any StageFlow backend; core ≥ 0.10 to be asked what it runs, ≥ 0.12 for the per-caller answer and the limits. Credentials and `?plan=` need a backend that wants them — one that ignores both behaves exactly as before |
| 0.3.x | api v1 | any StageFlow backend; core ≥ 0.10 to be asked what it runs, ≥ 0.12 for the per-caller answer and the limits |

## Releases

A tag builds two things (`.github/workflows/release.yml`): a GitHub Release
with the static files zipped, and an image in GHCR.

```bash
docker run --rm -p 8080:8080 ghcr.io/leo-need-more-coffee/stageflow-ui:latest
```

The hosted demo at
[leo-need-more-coffee.github.io/stageflow-ui](https://leo-need-more-coffee.github.io/stageflow-ui/)
is the same files, deployed from `main`, and it is a full client rather than a
demonstration: point it at a backend of your own, give it a credential, pick a
plan, all from the interface — "File" → "Connection…", or click the backend
line in the status bar. Nothing is configured at build time, because on a
static page nothing can be.

It is served over https, so the backend has to be reachable from a secure
page: `https://…`, or loopback, which browsers allow (the example backend
answers Chrome's private-network preflight). A plain http address elsewhere is
blocked before the request is made — the dialog says so rather than letting it
read as a backend that is switched off.

The version lives in two places, `package.json` and `js/version.js` (the
browser cannot read the first, nothing rewrites the second — there is no build
step); `npm test` fails if they disagree, and so does the release workflow if
the tag does not match both.

## Documentation

| Page | What it covers |
|---|---|
| [The backend](docs/backend.md) | the endpoints the editor needs, CORS, the shape of a stage spec |
| [Building a graph](docs/canvas.md) | connectors, mouse gestures, regions, auto-layout |
| [The interface](docs/interface.md) | menus and hotkeys, the inspector, the theme, the language, the session |
| [Running and debugging](docs/running.md) | the run pace, starting variables, the debug panel, the run API |
| [Secrets](docs/secrets.md) | where keys live and why they are not in the pipeline |
| [The bridge to an agent](docs/bridge.md) | letting an assistant draw on this canvas, and read back what you drew |
| [Embedding](docs/embedding.md) | `createEditor` options, the public API, bundling catalogs, the layout of `js/` |

## Tests

Plain node scripts, no framework:

```bash
npm test
```

They cover what the eye misses: that every node kind has a port for the next
node, that inserting into an edge keeps the tail of the graph, that 291 random
layouts produce no overlaps and no foreign node inside a region frame, that
undo/redo walks real edits only, that pasted copies are independent, that
secret values never leave the store, that an older backend is degraded against
rather than guessed about, that the credential goes on every request while
`?plan=` goes on none of the ones that run anything, and that every key the
interface asks for is in the catalogs of every language — a missing one is not a
crash, only a reader seeing `delay.one.hint` on the screen.

## Known limitations

A stage that waits for input (`wait_input`) cannot be answered from the UI
yet, and stepping is still one node at a time — there are no breakpoints.

## License

MIT — see [LICENSE](LICENSE).
