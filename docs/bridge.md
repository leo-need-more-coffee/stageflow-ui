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

A graph from the agent goes through the same door an imported one does:

- nodes that came without coordinates are **laid out** by the editor, so an
  agent writing plain JSON gets a readable graph rather than a heap at the
  origin;
- the graph is **validated** on arrival like any other, so an agent's mistake
  appears in the status bar where every other mistake appears;
- and it is **yours to keep or to put back** — see below. Loading a document
  starts a new edit history, so ordinary undo could not reach back past it;
  that is what the two buttons are for.

Edits going the other way are sent after a short pause rather than on every
keystroke — dragging a node is dozens of events, and the agent needs the result,
not the dragging.

## Nothing arrives without a way out of it

A graph from the bridge is applied at once — seeing it is the point, and a
preview of a graph is a graph you cannot look inside — and until you answer for
it, the status bar holds two buttons:

    ✓ keep      ↩ put back

**Put back** restores the graph exactly as it was before the change, keeping
your view and your place on the canvas. `Escape` and `Ctrl+Z` do the same
thing: the first `Ctrl+Z` after somebody else changed your graph means "put it
back", which is the gesture everybody tries first. The restored graph is sent
to the agent like any other edit, so it is working from what you kept rather
than from what it hoped.

**Keep** takes the marks off and drops the way back. So does editing anything
yourself: somebody who has started working on a graph has answered the
question, and being asked again would be nagging.

Two pushes in a row leave one question, and putting it back goes to the version
**you** last had — not to the assistant's previous attempt. The marks stay on
the cards until you answer: they are not decoration, they are the thing being
decided about, and a question does not time out.

## An incoming graph does not take the canvas away from you

A graph arriving from the bridge is an **edit of what you are looking at**, not
a document somebody opened, and the editor treats it as one.

**Your view stays where you put it.** Panned and zoomed in on a corner of a
large graph is exactly the state somebody is in while discussing it, and
refitting the canvas on every push would make a collaborator feel like an
interruption. A graph that shares no node with the one on screen is a different
document and still gets the view fitted to it — the rule is sharing a single
id, because an assistant rewriting a pipeline keeps the entry.

**Cards travel rather than jump.** A node whose position changed is put back
where it was and released, so it moves to its new place over a third of a
second. Nothing is measured and no second layout happens: the distance is in
the graph.

**What was touched is marked** — green for a node that is new, amber for one
that now says something different, the two oldest colours there are for a diff.
A change from the bridge keeps its marks until it is answered for; anything
else fades after a few seconds.

**The status bar keeps to one line.** The agent's note is prose and prose has
no length — it is cut to fit and kept whole in the tooltip. The figures are a
chip of their own and are never cut: they are the half you read at a glance,
and a sentence growing past them would push them off the bar.

    AI: a second pipeline: map over the titles → subpipe…   +5 −14 ✎2   ✓ keep   ↩ put back Position is deliberately not a change: a relayout moves
everything and alters nothing. Nothing is marked when the editor opens, however much is on the canvas. The
mark means "somebody just touched this", and on a graph nobody has looked at
yet there is no this.

Under `prefers-reduced-motion` the travel and the fade are off; the colours
stay.

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
