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

## CORS

The editor is served from its own origin, so every answer needs
`Access-Control-Allow-Origin` (and a `204` to the `OPTIONS` preflight of the
run requests, which carry a JSON body). Without that the browser blocks the
requests before they reach the backend, and the connection screen says the
backend is not reachable — which is what it looks like from the inside.

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
