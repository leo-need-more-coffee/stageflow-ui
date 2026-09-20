# StageFlow Editor

A visual node editor for [StageFlow](https://github.com/leo-need-more-coffee/stageflow)
pipelines. Plain HTML and JavaScript (ES modules), no build step and no
dependencies.

The editor is **static front-end only**: it holds no stage registry and
executes nothing. The stages and the run API live on a StageFlow backend, and
which one that is the user says on the connection screen when the editor opens.
So a graph is drawn here and executed by the real core — the step debugger
shows what will actually happen, not a second implementation of the semantics
in JavaScript.

A ready-made backend to point it at:
[stageflow-example](https://github.com/leo-need-more-coffee/stageflow-example).

## Running it

```bash
docker compose up --build      # http://127.0.0.1:8080
```

or without Docker:

```bash
npm start                      # node server.js, http://127.0.0.1:8080
```

`server.js` is a static server of about a hundred lines with no dependencies:
ES modules are not loaded from `file://`, so the page has to come over http —
that is the whole of its job. `PORT` and `HOST` are taken from the environment
(`UI_PORT` in compose).

Then open the page and type the address of a backend, for example
`http://127.0.0.1:8765`. It is checked by the very request the editor cannot
work without (`GET /api/stages`), remembered until it is changed, and can be
changed later in "File" → "Backend…". `?backend=http://host:port` in the URL
skips the question — handy for a bookmark or a demo.

## What it can do

- **The graph is assembled on the canvas**, not in a form: pull a wire from a
  port onto a node to link them or into empty space to create a node there,
  `⊕` / `×` on a link insert and cut, a node from the palette can be dragged
  onto a link or a card. Every way of adding a node ends with a connection.
- **Two sorts of connectors on two axes**: execution order is vertical
  (diamonds, the real edges of the JSON), data flows are horizontal (circles,
  derived from the graph and colored per variable).
- **Regions**: the branches of `parallel`, the body of a `try` and its `except`
  handlers are framed; membership is derived from the graph, so a frame cannot
  diverge from the structure.
- **The inspector is built from the stage spec**, not from the JSON structure:
  forms only, no hand-written JSON, required arguments that are not filled in
  are marked red.
- **Running and step debugging on the real core**: the current node on the
  graph, stepping, a pace between nodes, viewing and editing frame variables.
- **A secret store**: API keys live apart from the graph, only the name goes
  into the JSON, and the values are visible neither in the debug panel nor in
  the event log.
- **Session**: undo/redo, a node clipboard, foldable panels, and the pipeline,
  the view and the panel layout surviving a reload.
- Subpipelines, live graph validation, import/export of JSON, pipeline
  settings (`types` / `variables` / `metadata`).

## Documentation

- [The backend](docs/backend.md) — what the editor asks of a backend: the
  endpoints, CORS, the shape of a stage spec
- [Building a graph](docs/canvas.md) — the two sorts of connectors, the mouse
  gestures, regions, data wires, the auto-layout
- [The interface](docs/interface.md) — the menu bar and hotkeys, the inspector,
  what makes a node recognisable, the theme, the session
- [Running and debugging](docs/running.md) — the run pace, starting variables,
  the debug panel, the run API
- [Secrets](docs/secrets.md) — where the keys live and why they are not in the
  pipeline
- [Embedding as a library](docs/embedding.md) — `createEditor` options, the
  public API, the architecture of `js/`

## Tests

The invariants that cannot be caught by eye are checked by plain scripts — no
test framework, no dependencies:

```bash
npm test          # or: for t in tests/*.mjs; do node "$t"; done
```

| script | what it checks |
|---|---|
| `tests/wiring.mjs` | every node kind has a port for the next node, insertion into an edge keeps the tail of the graph, cards do not overlap |
| `tests/ports.mjs` | every read and write a node declares, CEL references included |
| `tests/layout.mjs` | 291 random graphs: no foreign node inside a region frame, no overlaps, the layout is idempotent |
| `tests/history.mjs` | undo/redo walk over real edits only |
| `tests/clipboard.mjs` | pasted copies do not control the originals |
| `tests/rows.mjs` | a freshly added table row does not disappear |
| `tests/secrets.mjs` | secret values do not leave the store |

## Known limitations

Input into a running session (a `wait_input` stage) cannot be provided from the
UI — that needs a control of its own in the debug panel; there are no
breakpoints, and a step is still only "the next node".

## License

MIT — see [LICENSE](LICENSE).
