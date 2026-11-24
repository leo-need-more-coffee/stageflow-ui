# Embedding as a library

The editor is a React component tree around one controller, `Editor`.
`src/lib.tsx` puts both behind two functions, for a page built with Vite (or
any bundler that handles TypeScript and JSX):

```ts
import { connectBackend, createEditor } from "./stageflow-ui/src/lib";

// asks for the backend address on a screen of its own; skipped when it is known
const backend = await connectBackend(document.body, { storageKey: "my-app" });

const editor = createEditor(container, {
  backend,                          // a Backend — REQUIRED
  pipeline: {...},                  // the starting graph (when there is no session)
  storageKey: "my-app",             // the session in localStorage; without it nothing is stored
  runDelay: 0.5,                    // the default run pace, seconds
  stages: {...},                    // ready-made specs instead of asking the backend
  dataMode: "focus",                // the data wires: "off" | "focus" | "all"
  spacing: { gapX: 110, gapY: 120, dataGap: 130 },
  onChange: (pipeline) => {...},
});
```

The package is not on npm; take the sources (or the release zip's `dist/` for
the stand-alone editor). `createEditor` returns the same `Editor` the interface
drives, so whatever the interface can do the page can do too:

```ts
editor.getPipeline();        // the current pipeline (a deep copy)
editor.setPipeline(data);    // load one
editor.setStages(specs);     // hand stage specs over directly
editor.reloadStages();       // ask the backend again
editor.validate();           // [{graph, node, message}]
editor.setDataMode("all");
editor.fitView();            // fit the graph to the screen
editor.model.relayout();     // lay it out again
editor.model.connect(from, portIndex, to);           // link a port
editor.model.disconnect(from, portIndex);            // cut a link
editor.model.insertOnEdge(from, portIndex, spec);    // insert into a wire
editor.model.removeNodes(ids);                       // delete nodes
editor.selection.setNodes(ids);                      // select
editor.openGraph("compose_reply");                   // a subpipeline alone; null — the main graph
editor.toggleSubgraphs();                            // subpipelines beside the main graph
editor.setRunDelay(0.5);                             // the pace, seconds
editor.secrets.set("OPENAI_API_KEY", "…");           // the key store
editor.run({ mode: "step", delay: 0.3 });            // a run (asks for the arguments)
editor.run({ vars: { n: 7 }, ask: false });          // a run without the dialog
editor.runner.step(); editor.runner.resume();        // driving the debugger
editor.runner.setVar("n", 42);                       // editing the frame
editor.undo(); editor.redo();
editor.copySelection(); editor.cutSelection(); editor.paste();
editor.save();                                       // Ctrl+S
editor.addEventListener("change", () => {...});      // a graph edit
// a node spec: {type: "stage" | "condition" | ..., extra: {stage: "LogStage"}}
```

`Editor` is an `EventTarget`: `change` is an edit of the graph, `render` is
anything the interface should redraw for.

## Languages

`createEditor` draws its text in whatever language `i18n.js` has settled on, so
an embedding decides the language before it builds the editor:

```js
import { loadLocale, install, setLocale, locale, locales } from "./stageflow-ui/src/core/i18n.js";

await loadLocale();                  // fetch i18n/index.json and the catalogs
await loadLocale(["ru"]);            // or ask for one, ignoring the reader
locale();                            // the tag in force: "en", "ru", …
locales();                           // {en: "English", ru: "Русский"} — what is on offer
setLocale("ru");                     // remember the choice and reload the page
```

`loadLocale` fetches, which needs a server; a page that bundles its catalogs
instead of serving them hands them over directly, and then nothing is fetched:

```js
import en from "./stageflow-ui/public/i18n/en.json";
import ru from "./stageflow-ui/public/i18n/ru.json";

install("ru", ru, en);   // the chosen catalog, and the fallback behind it
```

The third argument is why a half-finished translation is safe: a key missing
from `ru` is drawn from `en` rather than as its own name. Passing only
`install("ru", ru)` is the same thing without that safety net.

Adding a language is adding `public/i18n/<tag>.json` and a line in `public/i18n/index.json`
(`{"<tag>": "<the name, in that language>"}`). The keys are the English catalog's
keys; anything left out falls back. Nothing in the code names a language except
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

## The architecture

The split is the point: everything about pipelines is framework-free
JavaScript in `src/core`, tested with plain `node`, and `src/app` only draws
it.

`src/core/` — no React, no DOM where it can be helped:

- `model.js` — `PipelineModel`: the owner of the data, every mutation, the
  undo history, the change event;
- `kinds.js` — the node kinds, a mirror of the core's `NODE_TYPES`: defaults,
  `orderPorts`, `dataIns`/`dataOuts`, inspector fields, validation — a new node
  type is a new class;
- `geometry.js` — card sizes and connector positions, shared by the cards and
  the auto-layout, and the routing of order wires;
- `regions.js` — the membership and bounds of the areas, derived from the
  graph;
- `dataflow.js` — the nearest writers of every variable read;
- `wiring.js` — connecting operations: where the next node attaches, insertion
  into a wire, freeing space;
- `stages.js` — `StagesLibrary` (the specs from the backend) and `Validator`;
- `capabilities.js` — what the backend lets this caller run (`/api/meta`);
- `backend.js`, `connection.js` — the backend's address and credential, the
  check that StageFlow answers there;
- `runner.js`, `sse.js` — the client of the run API, its state assembled from
  the event stream;
- `secrets.js` — the key store; `storage.js` — the session in `localStorage`;
- `bridge.js` — the [bridge to an agent](bridge.md);
- `search.js` — the ranking of the add menu;
- `i18n.js` — the catalogs, the language, plurals, the backend's prose;
- `icons.js`, `colors.js` — stage icons (never as markup) and variable colours.

`src/app/` — React:

- `editor.ts` — `Editor`, the controller and public API, and `Selection`;
- `canvas/` — the canvas on React Flow: `scene.ts` turns the model into nodes
  and edges, `NodeCard.tsx` and `edges.tsx` draw them, `Canvas.tsx` turns
  gestures into model edits;
- `inspector/`, `run/`, `dialogs/`, `connect/` — the panels;
- `TopBar.tsx`, `AddNodeMenu.tsx`, `CommandPalette.tsx`, `VariablesPanel.tsx`;
- `src/ui/kit.tsx` — the building blocks (buttons, fields, menus, dialogs) on
  Radix, styled in one place.

Outside `src/`:

- `public/i18n/` — the catalogs;
- `server.js` — a static server for `dist/` with no dependencies; `PORT` and
  `HOST` from the environment;
- `Dockerfile`, `docker-compose.yml` — the same in a container.

The backend is a separate project: see [The backend](backend.md) for what the
editor asks of it, and
[stageflow-example](https://github.com/leo-need-more-coffee/stageflow-example)
for a working one.
