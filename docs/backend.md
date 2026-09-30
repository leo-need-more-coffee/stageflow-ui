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
— a few hundred lines of Python on top of the core. Anything answering the
same endpoints will do.

This page is the protocol, from the editor's side. Writing a backend rather
than talking to one is the other side of it, and the core's documentation has
a five-step track for that:
[Building a backend](https://leo-need-more-coffee.github.io/stageflow/backend/)
— the stages, these endpoints, a policy per caller, metering, and who is
calling.

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
- An **Authorization** section, folded away, takes a header — the name as well
  as the value, because `Authorization: Bearer …`, `X-Api-Key: …` and whatever
  a gateway reads are all real and the editor has no business picking one. It
  is sent with every request the editor makes, this check included, so a
  credential that is wrong is wrong here, on the screen where it can be
  corrected, rather than at the first run. The editor authenticates nothing
  itself: it carries what it is given and reports what came back. The value is
  remembered next to the address, with the same caveat as the
  [secret store](secrets.md) — it is not encryption.
- `?plan=basic` opens the editor drawn against that plan of that backend.

## The connection dialog

Everything about the connection is reachable while the editor is open, from
**"File" → "Connection…"** or by clicking the backend line in the status bar
— the same question as "which backend is this", so the same place. Four
sections:

- **Backend** — the address, and "Change…", which reopens the connection
  screen. Changing the address reloads the page. A reload rather than a live
  swap on purpose: the address is the ground everything stands on — the stage
  registry, a running session, the names of the environment secrets — and
  swapping it under a live session would leave a graph built from the stages
  of one backend with a run belonging to another. Served over https, the
  section also says why a plain http backend elsewhere cannot be reached (see
  [CORS](#cors) below), because that failure looks from the page exactly like
  a backend that is switched off.
- **Authorization** — the header, editable at any moment. A token is the one
  connection setting that goes stale *during* the work: it expires, it gets
  rotated, it turns out to be the wrong tenant's. "Apply" re-asks the three
  questions and repaints; nothing reloads, because the backend is the same
  backend and the graph is the same graph. A credential that is refused is
  reported and **rolled back** — a half-applied token would fail at the next
  request instead of at this one. An empty value means the editor sends none.
- **Plan** — see [below](#being-shown-a-plan-plan).
- **What it answered** — the plan, the core version, the node types and the
  limits, as they came back.

That is what makes the published editor usable against a backend of your own:
on a static page nothing can be arranged in advance, so the address, the
credential and the tier all have to be typed into the interface — and changed
there when they turn out to be wrong.

## What the editor asks for

```
GET    /api/meta               {api, stageflow, node_types, stages, …} — optional, see below
GET    /api/stages             the specs of every registered stage
GET    /api/secrets            the NAMES of the secrets in the environment
POST   /api/run                {pipeline, vars, mode: "run"|"step", delay, secrets, plan} -> {id, state}
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

## The language of the answer (`Accept-Language`)

Every request carries `Accept-Language` with the language the editor is drawn in,
the interface's fallback behind it — `ru, en;q=0.8`. A backend is free to ignore
it, and one that does simply answers as it always did.

It is **not** how the stage specs get their language: those arrive in every
language at once and are resolved in the editor (see
[the shape of a stage spec](#the-shape-of-a-stage-spec)). Sending a header would
be the wrong mechanism there — the specs are fetched once and the reader picks a
language afterwards, so a backend that had chosen for them would have to be asked
again on every change of mind.

What the header is for is the backend's **own** messages: what a refused run
says, what a validation error says, what a failure says. Those are one answer to
one request, so they have a language, and the request is the only place that
language can come from. On a StageFlow backend the locale is set once at the edge
and nothing below has to be told:

```python
from stageflow import i18n

asked = request.headers.get("accept-language", "")
with i18n.use_locale(i18n.negotiate(i18n.parse_accept_language(asked))):
    ...
```

Reading the header is the backend's job, not the framework's: `negotiate` matches
tags against the catalogs on disk and `use_locale` sets the locale for that
request, but nothing in the core touches a request, and nothing in it decides a
language on its own.

`Accept-Language` is a CORS-safelisted header, so it adds no preflight and needs
no line in `Access-Control-Allow-Headers`.

## What this backend can run (`/api/meta`)

The editor mirrors the core's node registry as it stood when the editor was
built. Pointed at an older backend it would offer a node that backend cannot
execute, and the mismatch used to surface mid-run as `Unknown node type` — a
message that names neither the cause nor the cure.

A version range cannot answer it either: a backend with a node type of its own
belongs to no range. So the backend is asked, and answers with the registry:

```json
{ "api": 1, "plan": "basic", "plan_source": "token", "plans": ["basic", "full", "pro"],
  "stageflow": "0.12.0",
  "node_types": ["condition", "entry", "stage", "switch", "terminal"],
  "stages": 5,
  "limits": { "counters": { "seconds": 15, "steps": 200, "iterations": 50 },
              "gauges": { "concurrency": 2, "depth": 2 },
              "max_retries": 2, "max_delay_seconds": 2 } }
```

| Field | Means |
|---|---|
| `api` | the version of this HTTP contract; it moves only when an old client would break |
| `stageflow` | the core's version — for the status bar and the logs, not for branching on |
| `node_types` | **the field to branch on**: what a pipeline may use here |
| `stages` | how many stages this caller may use (the specs are `/api/stages`, narrowed the same way) |
| `plan` | optional, a name for the allowance — shown, never interpreted |
| `plan_source` | optional, how that name was arrived at: `token` / `open` / `query` (see below) |
| `plans` | optional, the plans this backend will answer about, so the editor can offer them without knowing any names |
| `limits` | optional, how much a run may consume |

The answer describes **the caller**, not the backend. Two callers of one
backend may get different lists, and whether a node type is absent because the
core is older or because this caller's allowance is narrower is not a
distinction the editor has to make.

What the editor does with it: a type absent from `node_types` is greyed out in
the palette with the reason in its tooltip, and a graph already using one gets
an issue in the status bar before the run.

With `limits` it does the same for what a graph can be judged by without
running it — a shortest path longer than the allowed `steps`, a `retry` asking
for more attempts or a longer pause than the backend permits. What cannot be
judged statically it stays quiet about: a loop's cost comes from its data, and
guessing would flag graphs that fit.

The endpoint is optional. A backend that does not serve it is not
second-guessed — nothing is marked and everything works as before, because a
false "unsupported" on a good backend is worse than the error being avoided.
The editor then says the backend version is unknown, and that is all.

In the core the answer comes from `stageflow.capabilities()`, so serving it is
two lines and it cannot drift from the registry.

## Being shown a plan (`?plan=`)

A backend that serves plans may accept `?plan=<name>` on `/api/meta` and
`/api/stages`, and then answers about that plan instead of the caller's own.
The **Plan** section of the connection dialog offers whatever `plans` listed,
`?plan=basic` on the editor's own URL opens it that way, and the status bar
marks it `plan basic (preview)`.
Nothing reloads: the address, the session and the graph stay, and only the
palette, the limits and therefore the issues change — which is the thing being
looked at.

**It is unverified, and has to be.** A name is not a permission: drawing is
not running, and an editor that must authenticate before it can grey out a
palette entry is an editor nobody configures. So the question "what would this
graph look like on the cheaper tier" is answerable by anyone.

Which is exactly why the parameter must not exist on the run. `POST /api/run`
carries `plan` too, but in the opposite direction: it is what the editor
**drew against**, not a request to run on it. The backend resolves the real
plan from the credential and refuses a mismatch —

```json
{ "error": "this graph was prepared for plan 'pro', and these credentials are on 'basic'" }
```

— which is a better answer than six stages that suddenly "do not exist". A
backend that instead honoured `?plan=` on the run would be a backend whose
every ceiling is a query parameter.

None of this is in the StageFlow core. The core takes a `Policy`; tokens,
headers, tenants and plans belong to the platform, which already has its own
and would have to fight the framework's. The example backend does it in forty
lines (`app/auth.py`).

## The event stream is read with `fetch`, not `EventSource`

Worth knowing if you are writing a backend: the editor does **not** use
`EventSource` for `/api/run/<id>/events`. `EventSource` cannot send headers —
not "awkwardly", at all — and the usual workaround puts the credential in the
query string, where it lands in access logs, in the referrer and in the
history of whoever is screen-sharing.

So the stream is read by hand: an ordinary `fetch` with
`Accept: text/event-stream`, the body parsed as SSE frames. The wire format is
unchanged, and a backend needs to do nothing differently. What it does need is
`?from=N`, which the editor uses to resume after a dropped connection — it
reconnects at the event after the last one it saw, so a stream that broke
mid-run loses nothing. (That is also better than what `EventSource` gave us,
which was a reconnect with no idea where it had got to.)

## CORS

The editor is served from its own origin, so every answer needs
`Access-Control-Allow-Origin` (and a `204` to the `OPTIONS` preflight of the
run requests, which carry a JSON body). A backend that wants a credential must
also name that header in `Access-Control-Allow-Headers`, or the browser
refuses the request before sending it. Without that the browser blocks the
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
      "description": {"en": "Adds delta to a number", "ru": "Прибавляет delta к числу"},
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

**Every `description` is either a string or a `{locale: text}` mapping** — the
stage's own and those of its arguments, outputs, events and inputs. A backend
sends every language it has, because which one the reader wants is not a thing it
can know: the language is picked in the editor, and picked again whenever the
reader changes their mind. A stage nobody has translated is a plain string, which
is the honest shape for prose that exists in one language.

The editor resolves the mapping once, as the specs come in, against the language
it is drawn in — a regional tag (`ru-RU`) satisfies a request for `ru`, a missing
language falls back to the one the specs were written in, and a mapping with
neither gives up its only entry rather than nothing. So nothing downstream of
that has to know a mapping was ever there.

On a StageFlow backend this is simply what `get_specs()` returns:

```python
{"stages": {name: cls.get_specs() for name, cls in get_stages().items()}}
```

The built-in stages ship with their translations, and your own are
[translated by you](https://leo-need-more-coffee.github.io/stageflow/localization/).

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
