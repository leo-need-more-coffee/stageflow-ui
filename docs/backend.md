# The backend

The editor is static front-end: it draws a graph, validates it and debugs it,
but it holds no stage registry and executes nothing. Everything else it asks a
backend for, over the address typed on the connection screen.

That division is not an accident of packaging. The execution semantics (CEL,
types, `try`/`except`, `parallel`, frame merging) live in the StageFlow core,
and a second implementation of them in JavaScript would mean the step debugger
shows something other than what actually happens. So there is exactly one
implementation, and the editor is its client.

A ready-made backend lives in
[stageflow-example](https://github.com/leo-need-more-coffee/stageflow-example)
— about two hundred lines of Python on top of the core. Anything answering the
same endpoints will do.

## The connection screen

The address is the first question the editor asks, and it asks it before the
canvas appears: an editor with an empty palette and a dead "Run" would read as
broken rather than as unconfigured.

- What is typed is normalised: `localhost:8765`, `http://localhost:8765/` and
  `http://localhost:8765/api` all mean the same backend.
- It is then checked by `GET /api/stages` — the very request the editor cannot
  work without. So "connected" means the thing really answers and really allows
  this origin, not that the string looks like a URL.
- A checked address is remembered in `localStorage` (`<storageKey>:backend`),
  so the question is asked once rather than on every reload. If the remembered
  address stops answering, the screen comes back with the reason.
- `?backend=http://host:port` in the page URL skips the question.
- "File" → "Backend…" opens the same screen again; changing the address
  reloads the page. A reload rather than a live swap on purpose: the address is
  the ground everything stands on — the stage registry, a running session, the
  names of the environment secrets — and swapping it under a live session would
  leave a graph built from the stages of one backend with a run belonging to
  another.

## What the editor asks for

```
GET    /api/meta               {api, stageflow, node_types, stages} — optional, see below
GET    /api/stages             the specs of every registered stage
GET    /api/secrets            the NAMES of the secrets in the environment
POST   /api/run                {pipeline, vars, mode: "run"|"step", delay, secrets} -> {id, state}
GET    /api/run/<id>           the state of the run
GET    /api/run/<id>/events    the event stream (SSE), ?from=N — read on from the Nth
POST   /api/run/<id>/control   {action: "step"|"resume"|"pause"|"stop"|"delay", count, delay}
POST   /api/run/<id>/vars      {set: {...}, drop: [...]}
```

The run API is described in [Running and debugging](running.md), the secret
part in [Secrets](secrets.md).

Only `/api/stages` is required to get in. A backend without `/api/secrets` is
fine — the editor simply shows no environment keys (the request failing is not
treated as an error). Without the run API the editor opens and draws, and
running fails with the message the backend returned.

## What this backend can run (`/api/meta`)

The editor mirrors the core's node registry as it stood when the editor was
built. Pointed at an older backend it would offer a node that backend cannot
execute, and the mismatch used to surface mid-run as `Unknown node type` — a
message that names neither the cause nor the cure.

A version range cannot answer it either: a backend with a node type of its own
belongs to no range. So the backend is asked, and answers with the registry:

```json
{ "api": 1, "stageflow": "0.10.0",
  "node_types": ["condition", "entry", "map", "parallel", "stage",
                 "subpipeline", "switch", "terminal", "try"],
  "stages": 26 }
```

| Field | Means |
|---|---|
| `api` | the version of this HTTP contract; it moves only when an old client would break |
| `stageflow` | the core's version — for the status bar and the logs, not for branching on |
| `node_types` | **the field to branch on**: what a pipeline may use here |
| `stages` | how many stages are registered (the specs are `/api/stages`) |

What the editor does with it: a type absent from `node_types` is greyed out in
the palette with the reason in its tooltip, and a graph already using one gets
an issue in the status bar before the run.

The endpoint is optional. A backend that does not serve it is not
second-guessed — nothing is marked and everything works as before, because a
false "unsupported" on a good backend is worse than the error being avoided.
The editor then says the backend version is unknown, and that is all.

In the core the answer comes from `stageflow.capabilities()`, so serving it is
two lines and it cannot drift from the registry.

## CORS

The editor is served from its own origin, so every answer needs
`Access-Control-Allow-Origin` (and a `204` to the `OPTIONS` preflight of the
run requests, which carry a JSON body). Without that the browser blocks the
requests before they reach the backend, and the connection screen says the
backend is not reachable — which is what it looks like from the inside.

One more case, and it looks identical from the page: the editor served over
**https** (the hosted demo) fetching a backend on `127.0.0.1`. Chrome calls
that a private-network request and sends a preflight carrying
`Access-Control-Request-Private-Network: true`; unless the answer carries
`Access-Control-Allow-Private-Network: true`, the request never happens. With
Starlette that is `allow_private_network=True` on the CORS middleware — the
example backend sets it. A browser that blocks it regardless leaves one way
out: serve the editor from the same scheme as the backend, which locally means
running it yourself.

## The shape of a stage spec

`GET /api/stages` returns what the core's `get_specs()` produces:

```json
{
  "stages": {
    "IncrementStage": {
      "stage_name": "IncrementStage",
      "description": "Adds delta to a number",
      "category": "builtin.math",
      "icon": "/icons/plus.svg",
      "icon_mono": true,
      "color": "#4fb8e8",
      "arguments": [
        {"name": "current", "type": "int", "optional": false, "description": "…"},
        {"name": "delta", "type": "int", "optional": true, "description": "…"}
      ],
      "outputs": [
        {"name": "value", "type": "int", "description": "…"}
      ]
    }
  }
}
```

A bare object of specs without the `stages` wrapper is accepted too.

What the editor does with the fields: `arguments` and `outputs` become the rows
of the inspector (with the type, the description and whether it is required),
`description` becomes the note under the card title, `category` groups the
palette and gives a stage its color when `color` is absent, and `icon` becomes
the card icon — a glyph, an inline `<svg>`, a data URI, a full URL, or an
absolute path. **An absolute path (`/icons/globe.svg`) is resolved against the
backend**, because it is the backend that declared the icon and the backend
that serves it; the editor is files on another origin.

Anything the editor does not know about is ignored, so a backend is free to put
its own fields in.
