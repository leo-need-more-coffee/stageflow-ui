# Secrets: the key stays out of the document

An API key written as a value into a variable of an `entry` node travels with
the pipeline to every place the pipeline reaches: an export, a repository, a
screenshot at a defence, someone else's editor. "Remove it before sending" is
exactly the operation people forget, so keys have a place of their own:
**"File" → "Secrets…"**.

The graph refers to a secret BY NAME ONLY: the `arguments.vars` of a stage
reads `OPENAI_API_KEY` like an ordinary variable, and it is that name that goes
into the JSON — the value is substituted at start. So the pipeline stays a
whole document: it can be exported and shown without remembering what is inside
it.

Two sources, and the difference between them is substantial:

| source | where the value is | what the browser knows |
|---|---|---|
| **browser** | the `localStorage` of this tab, under a separate `<storageKey>:secrets` key | the value (it stores it itself) |
| **backend environment** | the variables of the backend process (in the example backend: `SF_SECRETS=NAME,NAME2` or `SF_SECRET_NAME=value`) | the name only |

The backend source is the one to use seriously: `GET /api/secrets` returns a
list of names and nothing else, the value is substituted into the starting
frame on the backend and never reaches the page at all. The list is
explicitly enumerated rather than "the whole environment": handing the browser
an inventory of the machine's variables is a bad idea by itself. For the same
reason only the names the server itself declared secret are substituted: a run
request must not be able to name an arbitrary environment variable and read it
back out of the frame.

**It is a key that travels to a run, not the keyring.** A secret is
substituted only if the graph mentions its name at all: otherwise every run
would carry the whole store along and put it into the frame, where it would lie
in plain view of the debugger. The sign is the name occurring in the pipeline
JSON, so a reference from inside a CEL expression (`vars.OPENAI_API_KEY`)
counts just as much as `arguments.vars`. The check is deliberately crude: a
false "did not send" is a failed run, while an extra name in the masking list
costs nothing.

The run dialog lists which keys will be substituted INTO THIS graph, and if the
store holds something but the graph refers to none of the names, it says so
plainly. Silence here is expensive: a key travels to a run only by a name
match, and "the store has `OPENAI_KEY`, the node reads `OPENAI_API_KEY`" would
look like "the key is filled in and the stage insists there is none". Names may
be shown — the secret here is the value, not the name.

**The value is shown nowhere and never** — that is the whole point of the
store:

- the store list shows `••••••••` — always eight dots, so that not even the
  length of the key is visible; a saved value can be replaced or deleted but
  not peeked at;
- the "show" eye exists only next to the input field — a typo has to be seen
  BEFORE the key goes into the store, and afterwards there is no point;
- **the frame and the debug log are scrubbed by the backend**, not by the
  editor: a masker there replaces secret values with the mask in every event, in
  the run state, in the result and in the artifacts — both by variable name and
  by the value itself (in the stage telemetry the name is already a different
  one: `api_key` rather than `OPENAI_API_KEY`). Otherwise the key would be back
  in the page with the very first `node_enter` — and from there in a
  screenshot;
- the field of such a variable in the debug panel is closed for editing:
  editing the dots would mean sending them back into the live frame and wiping
  the key;
- in the inspector a secret name is highlighted and labelled: it is visible
  that a key is wired into the stage, and still not visible which one.

The stage meanwhile receives the REAL value — the mask lives only on the way to
the browser. This is verified directly: a pipeline computing
`size(vars.DEMO_KEY)` returns the length of the real key while the event stream
shows dots.

The invariants are checked separately — `node tests/secrets.mjs`: the value
does not get into the pipeline, only a key the graph mentions travels to a run
(including one mentioned inside a CEL expression), the frame gives the mask
instead of the value, a backend key does not belong to the editor — the page
neither knows its value nor can delete it — and an unreachable backend does not
bring the store down.

What this is not: encryption. `localStorage` is read by browser extensions and
by devtools; the store protects not against someone who already has access to
the machine but against the key spreading through documents, logs and
demonstrations. For a real secret use the backend environment source.
