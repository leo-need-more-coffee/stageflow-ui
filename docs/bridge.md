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

## Reloads, and an agent that goes away

Both of those happen constantly, so neither ends the connection.

**A reload keeps it.** The token is taken out of the address bar as soon as it
is read, so there would be nothing left to authenticate with — it is kept in
the tab's own `sessionStorage` instead, which dies when the tab does. That is
exactly as long as a bridge lives.

**A reload does not undo your work.** The stream is a log, and the tab
remembers how far it has read, so what comes back after `F5` is what happened
since — not the agent's last graph landing on top of everything you have done
in the meantime. A tab that has never seen this bridge does start at the
beginning, and that is deliberate: a graph drawn before the editor was open
should be there when it opens.

**An agent's process comes and goes** — it belongs to a session, and the next
session is a new one. When it disappears the status bar says so and the editor
keeps trying for a few minutes, spaced further and further apart; the chip is a
button, so it can also be told to try again now. A new process gets a new
identity, and the tab notices and starts reading its log from the beginning
rather than from a number that meant something to the process before it.

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

## The hosted editor and your machine

This is a browser rule and it is worth knowing before it surprises you: a page
served from the internet reaching `127.0.0.1` is a request across address
spaces, and browsers guard it. The bridge answers the preflight that asks
(`Access-Control-Allow-Private-Network`), which is what older Chrome wanted —
but current Chrome has moved that guard to a **permission**: the first such
request raises a prompt about reaching devices on your local network, and until
somebody says yes the request fails with an ordinary-looking network error.

So from the published editor the bridge works **once you allow it**. The status
bar says as much rather than showing "failed to fetch", which would send you
looking for a process that is running perfectly well.

If the prompt is refused, or never appears — an automated browser, a policy, a
version that does not implement it — serve the editor from the same machine and
the question does not arise at all, because then nothing crosses anything:

```bash
node server.js            # http://127.0.0.1:8080
```

```bash
stageflow-mcp --backend https://… --bridge --editor http://127.0.0.1:8080/
```

`--editor` is what the printed link points at. The editor is also a container
(`ghcr.io/leo-need-more-coffee/stageflow-ui`) if you would rather not have a
checkout.
