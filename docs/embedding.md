# Embedding as a library

```js
import { connectBackend } from "./js/connect.js";
import { createEditor } from "./js/editor.js";

// asks for the backend address and checks it; skipped when you already know it
const backend = await connectBackend({ storageKey: "stageflow-editor" });

const editor = createEditor(container, {
  backend,                          // a Backend or just its address — REQUIRED
  pipeline: {...},                  // the starting graph (if there is no session)
  storageKey: "stageflow-editor",   // the session in localStorage; without it nothing is stored
  runDelay: 0.5,                    // the default run pace, seconds
  stages: {...},                    // ready-made specs instead of asking the backend
  onChange: (pipeline) => {...},
});

editor.getPipeline();        // the current pipeline (a deep copy)
editor.setPipeline(data);    // load one
editor.setStages(specs);     // hand the stage specs over directly
editor.reloadStages();       // ask the backend for them again
editor.backend.url;          // where the stages and the run API live
editor.validate();           // [{graph, node, message}]
editor.setDataMode("all");   // the data layer: "off" | "focus" | "all"
editor.dataMode;             // the current mode (also set by an option)
editor.canvas.fitView();     // fit the graph to the screen
editor.model.relayout();     // lay it out again
editor.model.connect(from, portIndex, to);           // link a port
editor.model.disconnect(from, portIndex);            // cut a link
editor.model.insertOnEdge(from, portIndex, spec);    // insert into an edge
editor.model.appendAfter(from, spec);                // append after
editor.model.removeNodes(ids);                       // delete a group of nodes
editor.selection.setNodes(ids);                      // select a group
editor.setRunDelay(0.5);     // the run pace: the pause between nodes, seconds
editor.secrets.set("OPENAI_API_KEY", "…");           // the key store
editor.secrets.names();      // the names (the values are not handed out)
editor.run({ mode: "step", delay: 0.3 });            // a run (it will ask for the arguments)
editor.run({ vars: { n: 7 }, ask: false });          // a run without the dialog
editor.runner.step(); editor.runner.resume();        // controlling the debugger
editor.runner.setVar("n", 42);                       // editing the frame
editor.undo(); editor.redo();                        // the edit history
editor.copySelection(); editor.cutSelection(); editor.paste();
editor.togglePanel("palette");                       // "palette" | "inspector"
// spec — {type: "stage" | "condition" | ..., extra: {stage: "LogStage"}}
editor.addEventListener("change", ...);
```

## Languages

`createEditor` draws its text in whatever language `i18n.js` has settled on, so
an embedding decides the language before it builds the editor:

```js
import { loadLocale, install, setLocale, locale, locales } from "./js/i18n.js";

await loadLocale();                  // fetch i18n/index.json + the catalogs
await loadLocale(["ru"]);            // or ask for one, ignoring the reader
locale();                            // the tag in force: "en", "ru", …
locales();                           // {en: "English", ru: "Русский"} — what is on offer
setLocale("ru");                     // remember the choice and reload the page
```

`loadLocale` fetches, which needs a server; a page that bundles its catalogs
instead of serving them hands them over directly, and then nothing is fetched:

```js
import en from "./i18n/en.json" with { type: "json" };
import ru from "./i18n/ru.json" with { type: "json" };

install("ru", ru, en);   // the chosen catalog, and the fallback behind it
```

The third argument is why a half-finished translation is safe: a key missing
from `ru` is drawn from `en` rather than as its own name. Passing only
`install("ru", ru)` is the same thing without that safety net.

Adding a language is adding `i18n/<tag>.json` and a line in `i18n/index.json`
(`{"<tag>": "<the name, in that language>"}`). The keys are the English catalog's
keys; anything left out falls back. Nothing in `js/` names a language except
`FALLBACK`, so no code changes.

### The stage specs are not in the catalogs

They cannot be: they are the backend's prose, and the editor knows nothing about
a host's stages. So a backend sends every language it has — each `description` is
either a string or a `{locale: text}` mapping — and `StagesLibrary.setSpecs`
resolves them once, on the way in, against the language in force. Everything
downstream reads `spec.description` as a string.

Which means specs passed straight in are localized too, with no work from the
embedding:

```js
createEditor(container, { backend, stages: {...} });   // mappings are fine here
editor.setStages(specs);                               // and here
```

Because the resolution happens at ingest and `setLocale` reloads the page, the
specs held in memory are always the reader's language. An embedding that swaps
the language without a reload has to hand the specs over again.

## The architecture of `js/`

- `backend.js` — `Backend`: the address of the backend turned into the URLs of
  the endpoints, the check that something StageFlow-shaped answers there, and
  the resolution of absolute icon paths against it;
- `connect.js` — the connection screen: asks for the address, checks it,
  remembers it;
- `model.js` — `PipelineModel`: the owner of the data, every mutation plus the
  change event;
- `kinds.js` — the node kinds (a mirror of the core's `NODE_TYPES` registry):
  the defaults, `orderPorts` (order), `dataIns`/`dataOuts` (variables),
  `acceptVariable` (what to do with a dropped variable), the inspector fields,
  the validation — polymorphically, a new node type is a new class;
- `geometry.js` — the card sizes and the connector attachment points: the
  single source of truth, shared by the rendering and the auto-layout (the
  constants agree with `editor.css`);
- `regions.js` — the membership and the bounds of the areas (the branches of a
  `parallel`, the body of a `try`), derived from the graph rather than stored in
  the JSON;
- `dataflow.js` — the data links: the nearest writers of every variable that is
  read (counting the implicit exits from areas); the shared source of truth for
  the edges on the canvas and for the auto-layout;
- `wiring.js` — the connecting operations (where the next node attaches,
  insertion into an edge, freeing space): pure functions over a graph, without
  the DOM;
- `menu.js` — the popup menu with a search and keyboard control: both "what to
  create" on the canvas and the sections of the menu bar (ticks, hotkeys,
  disabled items);
- `canvas.js` — `Viewport` (pan/zoom/fit) and `CanvasView` (rendering,
  interactions); the order edges are derived from the node fields, the data
  edges from `dataflow.js`, and there is no separate edge model;
- `stages.js` — `StagesLibrary` (the specs from the backend) and `Validator`;
- `storage.js` — the session in `localStorage`: the pipeline, the view and the
  panel layout, with a deferred write and without crashing on an unavailable
  storage;
- `i18n.js` — the interface's text: the catalogs from `i18n/*.json`, the
  negotiation of a language, `t` / `tn` / `pieces` / `has` to read a string, and
  `prose` to pick a language out of the `{locale: text}` mapping a backend sent
  (see [Languages](#languages));
- `bridge.js` — the connection to an agent working on this graph from
  outside the browser: off unless `?bridge=` asks for it (see
  [The bridge to an agent](bridge.md));
- `secrets.js` — the key store: the local values and the names of the secrets
  in the server environment, a mask instead of a value (see
  [Secrets](secrets.md));
- `runner.js` — the client of the run API: the debug state assembled from the
  event stream;
- `debugpanel.js` — the debug panel (controls, variables, the log);
- `rundialog.js` — the run dialog: the starting variables (the default values
  of the `entry` node shown as placeholders);
- `modal.js` — the frame of a modal window (import/export, settings, running);
- `inspector.js`, `palette.js` — the panels; `toolbar.js` — the menu bar, the
  graph selector and the run state in the bar;
- `editor.js` — the `Editor` facade (the public API) and `Selection`.

Outside `js/`:

- `server.js` — the static server that hands the files out (ES modules are not
  loaded from `file://`); no dependencies, `PORT` and `HOST` from the
  environment;
- `Dockerfile`, `docker-compose.yml` — the same thing in a container.

The backend is a separate project entirely: see [The backend](backend.md) for
what the editor asks of it, and
[stageflow-example](https://github.com/leo-need-more-coffee/stageflow-example)
for a working one.
