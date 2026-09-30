# The bridge to an agent

An assistant that can write a pipeline is of limited use while the pipeline it
wrote is text in a chat window. Somebody has to select it, open "File →
Import…", paste it, look at it — and when they change something on the canvas,
the assistant is back to working from the version it remembers.

The bridge closes that. A local process
([stageflow-mcp](https://github.com/leo-need-more-coffee/stageflow-mcp))
serves a small HTTP endpoint on this machine, the editor is opened with its
address, and from then on the two are looking at one graph:

- what the agent draws arrives here and goes onto the canvas;
- what happens here is sent back, so "add a retry to this node" is about the
  node on the screen.

```
stageflow-mcp --backend https://sf.example --bridge
```

It prints an address. Open it:

```
https://…/stageflow-ui/?backend=https://sf.example&bridge=http://127.0.0.1:7433#bridge-token=…
```

The status bar says `AI bridge` when it is connected, and shows the agent's own
one-line note about what it just did.

**Without `?bridge=` none of this exists.** No connection is attempted, no
socket is looked for, nothing is drawn. It is a feature you ask for by opening
a particular link.

## What arrives goes through the ordinary door

A graph from the agent is applied with the same `setPipeline` the import dialog
uses, which is worth knowing because of what it means:

- **undo works.** Whatever the model did to the graph is one `Ctrl+Z` away from
  being gone. It is not a special mode with a separate history;
- nodes that came without coordinates are **laid out** by the editor, so an
  agent writing plain JSON gets a readable graph rather than a heap at the
  origin;
- the graph is **validated** on arrival like any other, so an agent's mistake
  appears in the status bar where every other mistake appears.

Edits going the other way are sent after a short pause rather than on every
keystroke — dragging a node is dozens of events, and the agent needs the result,
not the dragging.

## The token, and why it is after the `#`

The bridge is a listening socket on your machine, and any page open in the same
browser may try to reach it. So it has a token, made fresh at every start, and
it refuses everything without one. On top of that it answers only to the editor
it was told about and to pages served from this machine.

The token travels in the **fragment** of the link — the part after `#`. A
fragment is never sent to a server, which matters because this page is served by
somebody else: in the query string the token would be in their access log, in
the `Referer` of every request the page makes, and in the history of whoever is
screen-sharing. The editor reads it once and takes it out of the address bar.

None of that makes the bridge something to open on a shared machine. It binds to
loopback only, and there is deliberately no option to bind it anywhere else.

## From a page you serve yourself

The rules above are a browser's, not ours: an **https** page reaching
`127.0.0.1` is a private-network request in Chrome, and it is only allowed
because the bridge answers the preflight that asks
(`Access-Control-Allow-Private-Network`). A browser that refuses regardless
leaves the same way out as a local backend does — serve the editor from this
machine too, and everything is one origin:

```bash
node server.js            # http://127.0.0.1:8080
```

Then open `http://127.0.0.1:8080/?backend=…&bridge=…#bridge-token=…`.
